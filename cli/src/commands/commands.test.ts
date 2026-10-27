import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@agentbridge/hub/http';
import { makeFakes, type Fakes } from '@agentbridge/hub/ports/fakes';
import { payloadHash } from '@agentbridge/contracts';
import * as ed from '@noble/ed25519';
import { saveKey } from '@agentbridge/sdk';
import {
  agents,
  approve,
  tasks,
  auditVerify,
  inbox,
  keygen,
  pending,
  register,
  revoke,
  type Env,
} from './index.js';

let dir: string;
let deps: Fakes;
let app: FastifyInstance;
let env: Env;
let lines: string[];
let ownerKeyPath: string;
let claudeKeyPath: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-cli-'));
  deps = makeFakes();
  lines = [];

  const ownerPriv = ed.utils.randomPrivateKey();
  const ownerPub = await ed.getPublicKeyAsync(ownerPriv);
  ownerKeyPath = join(dir, 'owner.key');
  await saveKey(ownerKeyPath, ownerPriv);

  const claudePriv = ed.utils.randomPrivateKey();
  claudeKeyPath = join(dir, 'claude.key');
  await saveKey(claudeKeyPath, claudePriv);
  const claudePub = Buffer.from(await ed.getPublicKeyAsync(claudePriv)).toString('base64');

  for (const name of ['claude', 'muse']) {
    deps.store.putAgent({
      ref: `agent:${name}`,
      workspace: 'ws',
      name,
      publicKey: claudePub,
      webhookUrl: null,
      webhookSecret: null,
      scopes: ['read', 'message', 'create_task', 'request_side_effect'],
      keyStatus: 'active',
      capabilities: {},
      createdAt: '2026-10-20T00:00:00.000Z',
    });
  }

  app = await buildApp(
    {
      ...deps,
      clock: { now: () => new Date() },
      ownerPublicKey: ownerPub,
    },
    { logger: false, rateLimitMax: 5000 },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  env = {
    baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    workspace: 'ws',
    write: (line) => lines.push(line),
  };
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function gatedTask(payload: unknown = { to: 'a@b.com' }) {
  const id = deps.ids.ulid('tsk');
  deps.store.putTask({
    id,
    workspace: 'ws',
    thread: 'thr_1',
    creator: 'agent:claude',
    assignee: 'agent:muse',
    title: 'send email',
    payload,
    payloadHash: payloadHash(payload),
    state: 'needs-approval',
    sideEffect: true,
    dueAt: null,
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
  });
  return id;
}

const agentOpts = () => ({ agentRef: 'agent:claude', agentKeyPath: claudeKeyPath });

describe('keygen', () => {
  it('writes the private key and prints only the public one', async () => {
    const out = join(dir, 'new.key');
    const { publicKey } = await keygen(env, { out });
    expect(statSync(out).isFile()).toBe(true);
    expect(lines.join('\n')).toContain(publicKey);
    // The private key must never be printed.
    const priv = (await import('node:fs/promises')).readFile;
    const privText = (await priv(out, 'utf8')).trim();
    expect(lines.join('\n')).not.toContain(privText);
  });

  it('writes the key 0600', async () => {
    const out = join(dir, 'mode.key');
    await keygen(env, { out });
    if (platform() !== 'win32') {
      expect(statSync(out).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to overwrite without --force', async () => {
    const out = join(dir, 'twice.key');
    await keygen(env, { out });
    await expect(keygen(env, { out })).rejects.toThrow(/exists/i);
    await expect(keygen(env, { out, force: true })).resolves.toBeDefined();
  });
});

describe('register', () => {
  it('registers an agent and reports its default scopes', async () => {
    const out = await register(env, {
      name: 'newbie',
      key: claudeKeyPath,
      ownerKeyPath,
    });
    expect(out.ref).toBe('agent:newbie');
    expect(lines.join('\n')).toContain('read, message');
  });

  it('returns a webhook secret only when a url is given', async () => {
    expect(
      (await register(env, { name: 'pull', key: claudeKeyPath, ownerKeyPath })).webhookSecret,
    ).toBeNull();
    const pushy = await register(env, {
      name: 'pushy',
      key: claudeKeyPath,
      ownerKeyPath,
      webhookUrl: 'https://p.example/hook',
    });
    expect(pushy.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('register is owner-signed', () => {
  it('REFUSES to register when signed by a key that is not the owner key', async () => {
    const wrongOwner = join(dir, 'not-the-owner.key');
    await saveKey(wrongOwner, ed.utils.randomPrivateKey());
    await expect(
      register(env, { name: 'intruder', key: claudeKeyPath, ownerKeyPath: wrongOwner }),
    ).rejects.toThrow(/401|unauthenticated/i);
    expect(deps.store.getAgent('ws', 'agent:intruder')).toBeNull();
  });
});

describe('approve', () => {
  it('prints the payload for review and signs the CURRENT hash', async () => {
    const id = gatedTask({ to: 'recruiter@example.com' });
    const out = await approve(env, {
      task: id,
      ownerKeyPath,
      yes: true,
    });
    expect(out.payloadHash).toBe(payloadHash({ to: 'recruiter@example.com' }));
    expect(out.state).toBe('submitted');
    expect(lines.join('\n')).toContain('recruiter@example.com');
  });

  it('refuses to sign without --yes', async () => {
    const id = gatedTask();
    await expect(approve(env, { task: id, ownerKeyPath })).rejects.toThrow(/--yes/);
    expect(deps.store.getTask('ws', id)?.state).toBe('needs-approval');
  });

  it('rejects the task when --reject is given', async () => {
    const id = gatedTask();
    const out = await approve(env, {
      task: id,
      ownerKeyPath,
      decision: 'reject',
      yes: true,
    });
    expect(out.state).toBe('failed');
  });

  it('reports approval_hash_mismatch legibly when the payload changed', async () => {
    const id = gatedTask({ to: 'a@b.com' });
    // Simulate the payload being rewritten between read and sign by making the
    // stored hash disagree with the stored payload.
    const current = deps.store.getTask('ws', id);
    deps.store.putTask({
      ...(current as NonNullable<typeof current>),
      payloadHash: payloadHash({ to: 'someone-else@evil.com' }),
    });
    await expect(approve(env, { task: id, ownerKeyPath, yes: true })).rejects.toThrow(
      /approval_hash_mismatch/,
    );
    expect(deps.store.getTask('ws', id)?.state).toBe('needs-approval');
  });

  it('refuses an approval signed by the wrong owner key', async () => {
    const id = gatedTask();
    const wrongKey = join(dir, 'wrong.key');
    await saveKey(wrongKey, ed.utils.randomPrivateKey());
    // Under ADR 0006 this now fails at request auth, before the body signature
    // is ever examined — a non-owner cannot even read the queue.
    await expect(
      approve(env, { task: id, ownerKeyPath: wrongKey, yes: true }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(deps.store.getTask('ws', id)?.state).toBe('needs-approval');
  });

  it('needs ONLY the owner key — no agent key exists for the owner to borrow', async () => {
    const id = gatedTask({ to: 'recruiter@example.com' });
    const out = await approve(env, { task: id, ownerKeyPath, yes: true });
    expect(out.state).toBe('submitted');
    // The payload still reaches the operator's eyes before anything is signed.
    expect(lines.join('\n')).toContain('recruiter@example.com');
  });

  it('says plainly when a task is not awaiting a decision', async () => {
    const id = gatedTask();
    deps.store.setTaskState('ws', id, 'completed', '2026-10-20T13:00:00.000Z');
    await expect(approve(env, { task: id, ownerKeyPath, yes: true })).rejects.toThrow(
      /not awaiting approval/i,
    );
  });
});

describe('pending', () => {
  it('lists the approval queue with only the owner key', async () => {
    gatedTask({ to: 'a@b.com' });
    gatedTask({ to: 'c@d.com' });
    const out = await pending(env, { ownerKeyPath });
    expect(out).toHaveLength(2);
    expect(lines.join('\n')).toContain('send email');
  });

  it('reports an empty queue without failing', async () => {
    expect(await pending(env, { ownerKeyPath })).toHaveLength(0);
  });
});

describe('revoke', () => {
  it('revokes a key and drops pending deliveries', async () => {
    deps.store.putOutbox({
      id: 'ob_1',
      workspace: 'ws',
      thread: 'thr_1',
      recipient: 'agent:muse',
      messageId: 'msg_1',
      attempts: 0,
      nextAttemptAt: '2026-10-20T12:00:00.000Z',
      state: 'pending',
      ackedAt: null,
      createdAt: '2026-10-20T12:00:00.000Z',
    });
    const out = await revoke(env, { ref: 'agent:muse', ownerKeyPath, yes: true });
    expect(out.revoked).toBe('agent:muse');
    expect(deps.store.getAgent('ws', 'agent:muse')?.keyStatus).toBe('revoked');
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10)).toHaveLength(0);
  });

  it('refuses without --yes', async () => {
    await expect(revoke(env, { ref: 'agent:muse', ownerKeyPath })).rejects.toThrow(/--yes/);
    expect(deps.store.getAgent('ws', 'agent:muse')?.keyStatus).toBe('active');
  });
});

describe('revoke is owner-only', () => {
  it('REFUSES an agent key — an agent must not be able to kill another', async () => {
    // The old signature took --agent/--agent-key and any agent key worked.
    await expect(
      revoke(env, { ref: 'agent:muse', ownerKeyPath: claudeKeyPath, yes: true }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(deps.store.getAgent('ws', 'agent:muse')?.keyStatus).toBe('active');
  });
});

describe('agents', () => {
  it('lists the roster and marks revoked keys', async () => {
    await revoke(env, { ref: 'agent:muse', ownerKeyPath, yes: true });
    const roster = await agents(env, { ownerKeyPath });
    expect(roster).toHaveLength(2);
    const out = lines.join('\n');
    expect(out).toMatch(/REVOKED\s+agent:muse/);
    expect(out).toMatch(/active\s+agent:claude/);
  });
});

describe('tasks', () => {
  it('lists every state, with the state in the output', async () => {
    gatedTask();
    const id = deps.ids.ulid('tsk');
    deps.store.putTask({
      id,
      workspace: 'ws',
      thread: 'thr_1',
      creator: 'agent:claude',
      assignee: 'agent:muse',
      title: 'list matches',
      payload: {},
      payloadHash: payloadHash({}),
      state: 'working',
      sideEffect: false,
      dueAt: null,
      createdAt: '2026-10-20T12:00:01.000Z',
      updatedAt: '2026-10-20T12:00:01.000Z',
    });
    const out = await tasks(env, { ownerKeyPath });
    expect(out).toHaveLength(2);
    const out2 = lines.join('\n');
    expect(out2).toContain('working');
    expect(out2).toContain('needs-approval');
  });

  it('narrows to one state when asked', async () => {
    gatedTask();
    const out = await tasks(env, { ownerKeyPath, state: 'completed' });
    expect(out).toHaveLength(0);
  });
});

describe('read-only commands', () => {
  it('lists an empty inbox without failing', async () => {
    expect(await inbox(env, agentOpts())).toBe(0);
  });

  it('verifies the audit chain locally, not by asking the hub', async () => {
    const out = await auditVerify(env, { ownerKeyPath });
    expect(out.ok).toBe(true);
    expect(lines.join('\n')).toMatch(/verifies.*recomputed locally/);
  });

  it('REPORTS A BREAK when a stored row is tampered with', async () => {
    // The check must be able to fail. A verifier that always says "ok" is
    // worse than none, because it gets believed.
    await revoke(env, { ref: 'agent:muse', ownerKeyPath, yes: true });
    const victim = deps.store.listAudit('ws', 0, 50)[0];
    expect(victim).toBeDefined();
    deps.store.replaceAuditRowForTest({
      ...(victim as NonNullable<typeof victim>),
      subject: 'rewritten-history',
    });

    lines.length = 0;
    const out = await auditVerify(env, { ownerKeyPath });
    expect(out.ok).toBe(false);
    expect(lines.join('\n')).toContain('AUDIT CHAIN BROKEN');
  });

  it('lists the rows when --list is given', async () => {
    await revoke(env, { ref: 'agent:muse', ownerKeyPath, yes: true });
    lines.length = 0;
    await auditVerify(env, { ownerKeyPath, list: true });
    expect(lines.join('\n')).toContain('agent.revoke');
  });
});

/**
 * The real bin, as a subprocess.
 *
 * Everything above imports the command functions directly, which is why a
 * dispatch bug in `cli/src/index.ts` survived: `env()` ran before the switch,
 * so `keygen` — the first command of the documented quickstart, which talks to
 * nothing — failed with "AGENTBRIDGE_WORKSPACE is required" before the user
 * had a workspace to name. Found by following the quickstart on a fresh
 * machine, not by any test.
 */
describe('the agentbridge bin', () => {
  const BIN = join(import.meta.dirname, '..', '..', 'dist', 'index.js');

  function run(args: string[], env: Record<string, string | undefined>) {
    return spawnSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  it('generates a key with NO workspace configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-cli-bin-'));
    try {
      const res = run(['keygen', '--out', join(dir, 'owner.key')], {
        AGENTBRIDGE_WORKSPACE: undefined,
        AGENTBRIDGE_URL: undefined,
      });
      expect(res.stderr).not.toContain('AGENTBRIDGE_WORKSPACE');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('public key:');
      // The private key's location, never its bytes.
      expect(res.stdout).not.toContain(readFileSync(join(dir, 'owner.key'), 'utf8').trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still requires a workspace for a command that talks to the hub', () => {
    // The check was not wrong, only misplaced: `pending` genuinely needs it.
    const res = run(['pending', '--owner-key', 'owner.key'], {
      AGENTBRIDGE_WORKSPACE: undefined,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('AGENTBRIDGE_WORKSPACE');
  });
});
