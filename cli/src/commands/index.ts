import { canonicalize, payloadHash } from '@agentbridge/contracts';
import * as ed from '@noble/ed25519';
import {
  Client,
  OwnerClient,
  generateKeyPair,
  loadKey,
  publicKeyBase64,
  registerAgent as sdkRegisterAgent,
  saveKey,
  type AgentSummary,
  type PendingTask,
} from '@agentbridge/sdk';

export interface Env {
  baseUrl: string;
  workspace: string;
  /** Where output goes. Injected so tests assert on it instead of stdout. */
  write: (line: string) => void;
  fetch?: typeof fetch;
}

/** One place builds the owner client, so every owner command signs alike. */
async function ownerClient(env: Env, ownerKeyPath: string): Promise<OwnerClient> {
  return new OwnerClient({
    baseUrl: env.baseUrl,
    workspace: env.workspace,
    privateKey: await loadKey(ownerKeyPath),
    ...(env.fetch === undefined ? {} : { fetch: env.fetch }),
  });
}

/* ------------------------------------------------------------------ agents */

/** The roster, so `revoke` has something to name. */
export async function agents(env: Env, opts: { ownerKeyPath: string }): Promise<AgentSummary[]> {
  const items = await (await ownerClient(env, opts.ownerKeyPath)).listAgents();
  if (items.length === 0) {
    env.write('no agents registered');
    return items;
  }
  for (const a of items) {
    const mark = a.keyStatus === 'revoked' ? 'REVOKED' : 'active ';
    env.write(`${mark}  ${a.ref}  [${a.scopes.join(', ')}]`);
  }
  return items;
}

/* ----------------------------------------------------------------- pending */

/** The approval queue. Before ADR 0006 there was no way to ask for it. */
export async function pending(env: Env, opts: { ownerKeyPath: string }): Promise<PendingTask[]> {
  const items = await (await ownerClient(env, opts.ownerKeyPath)).listPendingApprovals();
  if (items.length === 0) {
    env.write('nothing awaiting approval');
    return items;
  }
  for (const t of items) {
    env.write(`${t.id}  ${t.title}  -> ${t.assignee}  (since ${t.createdAt})`);
  }
  return items;
}

/* ------------------------------------------------------------------ keygen */

export async function keygen(
  env: Env,
  opts: { out: string; force?: boolean | undefined },
): Promise<{ publicKey: string }> {
  const { privateKey, publicKey } = await generateKeyPair();
  await saveKey(opts.out, privateKey, { force: opts.force === true });
  const b64 = publicKeyBase64(publicKey);
  // The private key is never printed, only its location.
  env.write(`private key written to ${opts.out} (mode 0600)`);
  env.write(`public key: ${b64}`);
  return { publicKey: b64 };
}

/* ---------------------------------------------------------------- register */

export async function register(
  env: Env,
  opts: {
    name: string;
    key: string;
    ownerKeyPath: string;
    scopes?: readonly string[] | undefined;
    webhookUrl?: string | undefined;
    skills?: readonly string[] | undefined;
  },
): Promise<{ ref: string; webhookSecret: string | null }> {
  // The agent key file supplies only its PUBLIC half; enrolment is authorised
  // by the OWNER's signature (ADR 0005), so the two keys do different jobs.
  const publicKey = publicKeyBase64(await ed.getPublicKeyAsync(await loadKey(opts.key)));

  const out = await sdkRegisterAgent({
    baseUrl: env.baseUrl,
    workspace: env.workspace,
    name: opts.name,
    publicKey,
    ownerPrivateKey: await loadKey(opts.ownerKeyPath),
    ...(opts.scopes === undefined ? {} : { scopes: opts.scopes }),
    ...(opts.webhookUrl === undefined ? {} : { webhookUrl: opts.webhookUrl }),
    capabilities: {
      skills: [...(opts.skills ?? [])],
      input: ['text', 'json'],
      output: ['text', 'json'],
    },
    ...(env.fetch === undefined ? {} : { fetch: env.fetch }),
  });

  env.write(`registered ${out.ref} with scopes ${out.scopes.join(', ')}`);
  if (out.webhookSecret !== null) {
    env.write(`webhook secret (shown once): ${out.webhookSecret}`);
  }
  return { ref: out.ref, webhookSecret: out.webhookSecret };
}

/* ----------------------------------------------------------------- approve */

export interface ApproveResult {
  task: string;
  decision: 'approve' | 'reject';
  payloadHash: string;
  state: string;
}

/**
 * The Phase 0 stand-in for the console's approval queue.
 *
 * Fetches the task and hashes the payload AS IT STANDS NOW. There is
 * deliberately no --payload-hash flag: a hash the operator typed, or copied
 * from an older notification, could approve a payload that has since changed.
 * The signed format is identical to what the console will sign with WebAuthn,
 * so the console drops in without an API change (spec §5.4).
 */
export async function approve(
  env: Env,
  opts: {
    task: string;
    ownerKeyPath: string;
    decision?: 'approve' | 'reject' | undefined;
    yes?: boolean | undefined;
  },
): Promise<ApproveResult> {
  const owner = await ownerClient(env, opts.ownerKeyPath);

  // Read from the owner's own queue. Previously this fetched the task through
  // a borrowed agent identity (ADR 0006); the queue is both the right source
  // and the one the owner key can actually reach.
  const queue = await owner.listPendingApprovals();
  const task = queue.find((t) => t.id === opts.task);
  if (task === undefined) {
    throw new Error(
      `${opts.task} is not awaiting approval in ${env.workspace}. ` +
        'Run `agentbridge pending` to see what is.',
    );
  }
  const decision = opts.decision ?? 'approve';

  env.write(`task:     ${task.id}`);
  env.write(`title:    ${task.title}`);
  env.write(`assignee: ${task.assignee}`);
  env.write(`state:    ${task.state}`);
  env.write(`payload:  ${canonicalize(task.payload)}`);

  if (opts.yes !== true) {
    throw new Error('refusing to sign without --yes; review the payload above first');
  }

  // Hash the payload we just read, not anything the caller supplied.
  const hash = payloadHash(task.payload);

  // Both the decision and the request carry the owner's signature now, so
  // there is one key and one identity involved rather than two.
  let state: string;
  try {
    const out = await owner.decide(task, decision);
    state = out.state;
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : String(err);
    if (code === 'approval_hash_mismatch') {
      throw new Error(
        'approval_hash_mismatch: the payload changed after it was read. ' +
          'Re-run to review the current payload before signing.',
      );
    }
    throw new Error(`approval rejected: ${code}`);
  }

  env.write(`${decision}d ${opts.task} -> ${state}`);
  return { task: opts.task, decision, payloadHash: hash, state };
}

/* ------------------------------------------------------------------ revoke */

/**
 * The Phase 0 kill switch (CLAUDE.md P0 control). revokeKey exists in the hub
 * domain, but without this command and its route nothing could trigger it.
 */
export async function revoke(
  env: Env,
  opts: { ref: string; ownerKeyPath: string; yes?: boolean | undefined },
): Promise<{ revoked: string }> {
  if (opts.yes !== true) {
    throw new Error(`refusing to revoke ${opts.ref} without --yes`);
  }
  // Owner-signed (ADR 0006). This used to accept any agent key, which meant
  // any agent could revoke any other.
  const out = await (await ownerClient(env, opts.ownerKeyPath)).revokeAgentKey(opts.ref);
  env.write(`revoked ${out.revoked}; pending deliveries dropped`);
  return out;
}

/* -------------------------------------------------------------- read-only */

export async function inbox(
  env: Env,
  opts: { agentRef: string; agentKeyPath: string; limit?: number | undefined },
): Promise<number> {
  const client = new Client({
    baseUrl: env.baseUrl,
    workspace: env.workspace,
    agent: opts.agentRef,
    privateKey: await loadKey(opts.agentKeyPath),
    ...(env.fetch === undefined ? {} : { fetch: env.fetch }),
  });
  const page = await client.listInbox(opts.limit === undefined ? {} : { limit: opts.limit });
  for (const item of page.items) {
    env.write(
      `${item.id}  ${item.type}  from ${item.body.provenance.from}  task=${item.task ?? '-'}`,
    );
  }
  env.write(`${page.items.length} item(s); cursor ${page.cursor ?? 'none'}`);
  return page.items.length;
}

export async function auditVerify(
  env: Env,
  opts: { agentRef: string; agentKeyPath: string },
): Promise<{ ok: boolean; checked: number }> {
  const client = new Client({
    baseUrl: env.baseUrl,
    workspace: env.workspace,
    agent: opts.agentRef,
    privateKey: await loadKey(opts.agentKeyPath),
    ...(env.fetch === undefined ? {} : { fetch: env.fetch }),
  });
  const out = await client.verifyAudit();
  env.write(
    out.ok
      ? `audit chain verifies across ${out.checked} row(s)`
      : `AUDIT CHAIN BROKEN at seq ${String(out.brokenAtSeq)} after ${out.checked} row(s)`,
  );
  return { ok: out.ok, checked: out.checked };
}
