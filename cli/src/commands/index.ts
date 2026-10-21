import { canonicalize, payloadHash } from '@agentbridge/contracts';
import * as ed from '@noble/ed25519';
import { Client, generateKeyPair, loadKey, publicKeyBase64, saveKey } from '@agentbridge/sdk';

export interface Env {
  baseUrl: string;
  workspace: string;
  /** Where output goes. Injected so tests assert on it instead of stdout. */
  write: (line: string) => void;
  fetch?: typeof fetch;
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
    scopes?: readonly string[] | undefined;
    webhookUrl?: string | undefined;
    skills?: readonly string[] | undefined;
    registrationToken?: string | undefined;
  },
): Promise<{ ref: string; webhookSecret: string | null }> {
  const publicKey = publicKeyBase64(await ed.getPublicKeyAsync(await loadKey(opts.key)));
  const doFetch = env.fetch ?? fetch;

  const res = await doFetch(`${env.baseUrl}/v1/agents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agentbridge-workspace': env.workspace,
      // Registration cannot be signature-authenticated: the agent has no
      // registered key yet.
      'x-agentbridge-registration-token':
        opts.registrationToken ?? process.env.AGENTBRIDGE_REGISTRATION_TOKEN ?? '',
    },
    body: JSON.stringify({
      name: opts.name,
      capabilities: {
        skills: opts.skills ?? [],
        input: ['text', 'json'],
        output: ['text', 'json'],
      },
      public_key: publicKey,
      ...(opts.webhookUrl === undefined ? {} : { webhook_url: opts.webhookUrl }),
      ...(opts.scopes === undefined ? {} : { scopes: opts.scopes }),
    }),
  });

  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    ref: string;
    scopes: string[];
    webhook_secret: string | null;
  };

  env.write(`registered ${body.ref} with scopes ${body.scopes.join(', ')}`);
  if (body.webhook_secret !== null) {
    env.write(`webhook secret (shown once): ${body.webhook_secret}`);
  }
  return { ref: body.ref, webhookSecret: body.webhook_secret };
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
    agentRef: string;
    agentKeyPath: string;
    decision?: 'approve' | 'reject' | undefined;
    yes?: boolean | undefined;
  },
): Promise<ApproveResult> {
  const client = new Client({
    baseUrl: env.baseUrl,
    workspace: env.workspace,
    agent: opts.agentRef,
    privateKey: await loadKey(opts.agentKeyPath),
    ...(env.fetch === undefined ? {} : { fetch: env.fetch }),
  });

  const task = await client.getTask(opts.task);
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
  const issuedAt = new Date().toISOString();
  const signed = canonicalize({
    task: opts.task,
    decision,
    payload_hash: hash,
    issued_at: issuedAt,
  });
  const sig = await ed.signAsync(
    new TextEncoder().encode(signed),
    await loadKey(opts.ownerKeyPath),
  );

  // Submitted through the signed client: the owner signature travels in the
  // body, while the request itself is signed by the operator's agent key.
  let state: string;
  try {
    const out = await client.decideApproval({
      task: opts.task,
      decision,
      payloadHash: hash,
      issuedAt,
      sig: `ed25519:${Buffer.from(sig).toString('base64')}`,
    });
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
  opts: { ref: string; agentRef: string; agentKeyPath: string; yes?: boolean | undefined },
): Promise<{ revoked: string }> {
  if (opts.yes !== true) {
    throw new Error(`refusing to revoke ${opts.ref} without --yes`);
  }
  const client = new Client({
    baseUrl: env.baseUrl,
    workspace: env.workspace,
    agent: opts.agentRef,
    privateKey: await loadKey(opts.agentKeyPath),
    ...(env.fetch === undefined ? {} : { fetch: env.fetch }),
  });

  const out = await client.revokeAgentKey(opts.ref);
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
