import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import { payloadHash, requestDescriptor, signDescriptor } from '@agentbridge/contracts';
import type { Client } from '@agentbridge/sdk';
import { WORKSPACE, dockerAvailable, startContainer, type ContainerHarness } from './harness.js';

/**
 * The deployed artifact, end to end: real image, real entrypoint, real volume,
 * real SQLite file inside the container. Everything goes over HTTP — there is
 * no Store handle on this side, which is exactly why this suite catches what
 * the in-process e2e suite cannot (env contract, entrypoint, persistence).
 *
 * One container for the whole file: a build-plus-boot per test would dominate
 * the runtime, and the scenarios are written not to depend on a clean slate.
 */
let h: ContainerHarness;
let claude: Client;
let muse: Client;
let available = false;
let threadSeq = 0;

const thread = (): string => `thr_c${(threadSeq += 1)}`;

beforeAll(async () => {
  available = await dockerAvailable();
  if (!available) return;
  h = await startContainer();

  const claudePriv = await h.register('claude', [
    'read',
    'message',
    'create_task',
    'request_side_effect',
  ]);
  const musePriv = await h.register('muse', ['read', 'message', 'write_artifact']);
  claude = h.client('claude', claudePriv);
  muse = h.client('muse', musePriv);
}, 180_000);

afterAll(async () => {
  if (available) await h.stop();
}, 60_000);

const needsDocker = () => {
  if (!available) throw new Error('docker is not available; cannot run the container suite');
};

async function completeAsMuse(taskId: string): Promise<void> {
  await muse.updateTask(taskId, 'accepted');
  await muse.updateTask(taskId, 'working');
  await muse.putArtifact({
    task: taskId,
    kind: 'json',
    name: 'matches.json',
    contentType: 'application/json',
    inline: { matches: [{ title: 'Staff Engineer', company: 'Acme' }] },
  });
  await muse.updateTask(taskId, 'completed');
}

describe('the container boots and serves', () => {
  it('answers /healthz', async () => {
    needsDocker();
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('logs no startup error', async () => {
    needsDocker();
    const logs = await h.logs();
    expect(logs).not.toMatch(/MODULE_NOT_FOUND|failed to start|ERR_/);
    expect(logs).toMatch(/agentbridge hub listening|"level":30/);
  });

  it('never logs a message body', async () => {
    needsDocker();
    const canary = 'SHOULD-NEVER-APPEAR-IN-LOGS';
    const t = await claude.createTask({
      thread: thread(),
      assignee: 'agent:muse',
      title: 'secret-bearing task',
      payload: { canary },
    });
    expect(t.id).toMatch(/^tsk_/);

    const logs = await h.logs();
    // Guard against a vacuous pass: with an empty log, "does not contain the
    // canary" is true for the wrong reason.
    expect(logs.length, 'expected request logs to search').toBeGreaterThan(200);
    expect(logs).toContain('"msg":"request completed"');
    expect(logs).not.toContain(canary);
  });
});

describe('registration is gated in the real deployment', () => {
  it('rejects a registration with no token', async () => {
    needsDocker();
    const res = await fetch(`${h.baseUrl}/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentbridge-workspace': WORKSPACE },
      body: JSON.stringify({
        name: 'intruder',
        capabilities: { skills: [], input: [], output: [] },
        public_key: 'AAAA',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a registration with a wrong token', async () => {
    needsDocker();
    const res = await fetch(`${h.baseUrl}/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': WORKSPACE,
        'x-agentbridge-registration-token': 'x'.repeat(64),
      },
      body: JSON.stringify({
        name: 'intruder',
        capabilities: { skills: [], input: [], output: [] },
        public_key: 'AAAA',
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe('auth against the container', () => {
  it('rejects an unsigned read', async () => {
    needsDocker();
    const res = await fetch(`${h.baseUrl}/v1/inbox`, {
      headers: { 'x-agentbridge-workspace': WORKSPACE },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a signature from a key the hub does not know', async () => {
    needsDocker();
    const stranger = ed.utils.randomPrivateKey();
    const timestamp = new Date().toISOString();
    const sig = await signDescriptor(
      requestDescriptor({ method: 'GET', path: '/v1/inbox', query: {}, body: '', timestamp }),
      stranger,
    );
    const res = await fetch(`${h.baseUrl}/v1/inbox`, {
      headers: {
        'x-agentbridge-workspace': WORKSPACE,
        'x-agentbridge-agent': 'agent:muse',
        'x-agentbridge-timestamp': timestamp,
        'x-agentbridge-signature': sig,
      },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'signature_invalid',
    );
  });

  it('refuses a scope the agent does not hold', async () => {
    needsDocker();
    // muse has no create_task.
    await expect(
      muse.createTask({
        thread: thread(),
        assignee: 'agent:claude',
        title: 'nope',
        payload: {},
      }),
    ).rejects.toMatchObject({ code: 'scope_denied' });
  });
});

describe('the relay-free exchange, through the container', () => {
  it('runs Claude -> Muse -> Claude with an artifact', async () => {
    needsDocker();
    const t = thread();
    const task = await claude.createTask({
      thread: t,
      assignee: 'agent:muse',
      title: 'list the 3 newest job matches',
      payload: { count: 3 },
    });

    const inbox = await muse.listInbox();
    const mine = inbox.items.filter((i) => i.task === task.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.body.unwrap()).toMatchObject({ title: 'list the 3 newest job matches' });

    await completeAsMuse(task.id);

    const done = (await claude.getTask(task.id)) as unknown as {
      state: string;
      artifacts: { name: string }[];
    };
    expect(done.state).toBe('completed');
    expect(done.artifacts.map((a) => a.name)).toContain('matches.json');
  });

  it('returns the same task for a retried create', async () => {
    needsDocker();
    const args = {
      thread: thread(),
      assignee: 'agent:muse',
      title: 'once only',
      payload: { count: 1 },
      idempotencyKey: 'container-dup',
    };
    const a = await claude.createTask(args);
    const b = await claude.createTask(args);
    expect(b.id).toBe(a.id);
  });

  it('wraps inbox bodies as untrusted', async () => {
    needsDocker();
    await claude.send({ thread: thread(), to: ['agent:muse'], body: { text: 'hello' } });
    const page = await muse.listInbox();
    const item = page.items.at(-1);
    expect(item).toBeDefined();
    expect(item?.body.provenance.from).toBe('agent:claude');
    expect(`${item?.body}`).not.toContain('hello');
  });
});

describe('the approval gate, through the container', () => {
  it('withholds a side effect, then releases it on approval', async () => {
    needsDocker();
    const t = thread();
    const gated = await claude.requestApproval({
      thread: t,
      assignee: 'agent:muse',
      title: 'email the recruiter',
      payload: { to: 'recruiter@example.com' },
    });
    expect(gated.state).toBe('needs-approval');

    const before = (await muse.listInbox()).items.filter((i) => i.task === gated.id);
    expect(before).toHaveLength(0);

    const decided = await h.ownerApprove(claude, gated.id);
    expect(decided.code).toBeNull();

    const after = (await muse.listInbox()).items.filter((i) => i.task === gated.id);
    expect(after).toHaveLength(1);
  });

  it('rejects an approval bearing the wrong payload hash', async () => {
    needsDocker();
    const gated = await claude.requestApproval({
      thread: thread(),
      assignee: 'agent:muse',
      title: 'send it',
      payload: { to: 'a@b.com' },
    });
    const res = await h.ownerApproveWithHash(claude, gated.id, 'f'.repeat(64));
    expect(res.code).toBe('approval_hash_mismatch');
    expect((await claude.getTask(gated.id)).state).toBe('needs-approval');
  });

  it('rejects a replayed approval', async () => {
    needsDocker();
    const gated = await claude.requestApproval({
      thread: thread(),
      assignee: 'agent:muse',
      title: 'send it',
      payload: { to: 'a@b.com' },
    });
    const task = await claude.getTask(gated.id);
    const hash = payloadHash(task.payload);
    expect((await h.ownerApproveWithHash(claude, gated.id, hash)).code).toBeNull();
    expect((await h.ownerApproveWithHash(claude, gated.id, hash)).code).not.toBeNull();
  });

  it('never delivers a rejected side effect', async () => {
    needsDocker();
    const gated = await claude.requestApproval({
      thread: thread(),
      assignee: 'agent:muse',
      title: 'send it',
      payload: { to: 'a@b.com' },
    });
    await h.ownerApprove(claude, gated.id, 'reject');
    expect((await claude.getTask(gated.id)).state).toBe('failed');
    expect((await muse.listInbox()).items.filter((i) => i.task === gated.id)).toHaveLength(0);
  });

  it('refuses an approval signed by a key that is not the owner key', async () => {
    needsDocker();
    const gated = await claude.requestApproval({
      thread: thread(),
      assignee: 'agent:muse',
      title: 'send it',
      payload: { to: 'a@b.com' },
    });
    const impostor = ed.utils.randomPrivateKey();
    const issuedAt = new Date().toISOString();
    const hash = payloadHash((await claude.getTask(gated.id)).payload);
    const { canonicalize } = await import('@agentbridge/contracts');
    const sig = await ed.signAsync(
      new TextEncoder().encode(
        canonicalize({
          task: gated.id,
          decision: 'approve',
          payload_hash: hash,
          issued_at: issuedAt,
        }),
      ),
      impostor,
    );
    await expect(
      claude.decideApproval({
        task: gated.id,
        decision: 'approve',
        payloadHash: hash,
        issuedAt,
        sig: `ed25519:${Buffer.from(sig).toString('base64')}`,
      }),
    ).rejects.toMatchObject({ code: 'signature_invalid' });
    expect((await claude.getTask(gated.id)).state).toBe('needs-approval');
  });
});

describe('trace and audit, through the container', () => {
  it('adopts an inbound trace id and echoes one on errors', async () => {
    needsDocker();
    const res = await fetch(`${h.baseUrl}/v1/inbox`, {
      headers: {
        'x-agentbridge-workspace': WORKSPACE,
        'x-agentbridge-trace-id': '4bf92f3577b34da6a3ce929d0e0e4736',
      },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { trace_id: string } }).error.trace_id).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736',
    );
  });

  it('verifies the audit chain inside the container', async () => {
    needsDocker();
    const out = await claude.verifyAudit();
    expect(out.ok).toBe(true);
    expect(out.checked).toBeGreaterThan(0);
  });
});

/**
 * The property only a container can prove: the SQLite file and the artifact
 * directory live on a volume, so a restart must preserve state. An in-process
 * suite cannot test this because its store dies with the process.
 */
describe('state survives a container restart', () => {
  it('keeps agents, tasks, artifacts and the audit chain across a restart', async () => {
    needsDocker();
    const t = thread();
    const task = await claude.createTask({
      thread: t,
      assignee: 'agent:muse',
      title: 'survive a restart',
      payload: { count: 1 },
    });
    await completeAsMuse(task.id);
    const auditBefore = await claude.verifyAudit();

    await h.restart();

    // The same signed clients keep working: the agent rows persisted.
    const after = (await claude.getTask(task.id)) as unknown as {
      state: string;
      artifacts: { name: string }[];
    };
    expect(after.state).toBe('completed');
    expect(after.artifacts.map((a) => a.name)).toContain('matches.json');

    const auditAfter = await claude.verifyAudit();
    expect(auditAfter.ok).toBe(true);
    expect(auditAfter.checked).toBeGreaterThanOrEqual(auditBefore.checked);
  });
});

describe('the kill switch works in the real deployment', () => {
  it('revokes an agent key and locks it out immediately', async () => {
    needsDocker();
    const doomedPriv = await h.register('doomed', ['read', 'message']);
    const doomed = h.client('doomed', doomedPriv);
    await expect(doomed.listInbox()).resolves.toBeDefined();

    await claude.revokeAgentKey('agent:doomed');

    await expect(doomed.listInbox()).rejects.toMatchObject({ code: 'key_revoked' });
  });
});
