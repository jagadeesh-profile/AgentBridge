import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import { requestDescriptor, signDescriptor } from '@agentbridge/contracts';
import { startHarness, type Harness } from './harness.js';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.stop();
});

const THREAD = 'thr_e2e';

async function completeAsMuse(taskId: string) {
  await h.muse.updateTask(taskId, 'accepted');
  await h.muse.updateTask(taskId, 'working');
  await h.muse.putArtifact({
    task: taskId,
    kind: 'json',
    name: 'matches.json',
    contentType: 'application/json',
    inline: { hits: 3 },
  });
  await h.muse.updateTask(taskId, 'completed');
}

/* 1 ------------------------------------------------------------ happy path */
describe('1. happy path', () => {
  it('A creates a task, B completes it with an artifact, A sees the result', async () => {
    const task = await h.claude.createTask({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 'list the 3 newest job matches',
      payload: { count: 3 },
    });

    const inbox = await h.muse.listInbox();
    expect(inbox.items.length).toBeGreaterThan(0);
    expect(inbox.items[0]?.body.unwrap()).toMatchObject({ title: expect.any(String) });

    await completeAsMuse(task.id);

    const done = (await h.claude.getTask(task.id)) as unknown as {
      state: string;
      artifacts: { name: string; version: number }[];
    };
    expect(done.state).toBe('completed');
    expect(done.artifacts.map((a) => a.name)).toContain('matches.json');

    const claudeInbox = await h.claude.listInbox();
    expect(claudeInbox.items.length).toBeGreaterThan(0);
  });
});

/* 2 --------------------------------------------------- duplicate delivery */
describe('2. duplicate delivery produces exactly one effect', () => {
  it('returns the same task to both callers for one idempotency key', async () => {
    const args = {
      thread: THREAD,
      assignee: 'agent:muse',
      title: 'once only',
      payload: { count: 1 },
      idempotencyKey: 'dup-key',
    };
    const a = await h.claude.createTask(args);
    const b = await h.claude.createTask(args);
    expect(b.id).toBe(a.id);

    const seen = (await h.muse.listInbox()).items.filter((i) => i.task === a.id);
    expect(seen).toHaveLength(1);
  });

  it('produces one artifact for a duplicated artifact.put', async () => {
    const task = await h.claude.createTask({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 't',
      payload: {},
    });
    const put = {
      task: task.id,
      kind: 'json' as const,
      name: 'matches.json',
      contentType: 'application/json',
      inline: { hits: 1 },
      idempotencyKey: 'art-key',
    };
    const first = await h.muse.putArtifact(put);
    const second = await h.muse.putArtifact(put);
    expect(second.id).toBe(first.id);
    expect(h.store.listArtifacts('ws_e2e', task.id)).toHaveLength(1);
  });

  it('rejects the same key reused with a different payload', async () => {
    const key = 'conflict-key';
    await h.claude.createTask({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 'first',
      payload: {},
      idempotencyKey: key,
    });
    await expect(
      h.claude.createTask({
        thread: THREAD,
        assignee: 'agent:muse',
        title: 'DIFFERENT',
        payload: {},
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
});

/* 3 ---------------------------------------------------------- in-thread order */
describe('3. ordering', () => {
  it('delivers messages within a thread in send order', async () => {
    for (const n of [1, 2, 3, 4]) {
      await h.claude.send({ thread: 'thr_order', to: ['agent:muse'], body: { n } });
    }
    const page = await h.muse.listInbox();
    const ns = page.items
      .map((i) => (i.body.unwrap() as { n?: number }).n)
      .filter((n) => n !== undefined);
    expect(ns).toEqual([1, 2, 3, 4]);
  });

  it('does not serialize across threads', async () => {
    await h.claude.send({ thread: 'thr_a', to: ['agent:muse'], body: { t: 'a' } });
    await h.claude.send({ thread: 'thr_b', to: ['agent:muse'], body: { t: 'b' } });
    const threads = new Set((await h.muse.listInbox()).items.map((i) => i.thread));
    expect(threads.has('thr_a')).toBe(true);
    expect(threads.has('thr_b')).toBe(true);
  });

  it('holds thread order when the first delivery fails and retries', async () => {
    // A receiver that 500s on its first request and 200s afterwards.
    let hits = 0;
    const seen: unknown[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hits += 1;
        if (hits === 1) {
          res.writeHead(500).end();
          return;
        }
        seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

    try {
      await h.registerAgent('pushy', url);
      await h.claude.send({ thread: 'thr_retry', to: ['agent:pushy'], body: { n: 1 } });
      await h.claude.send({ thread: 'thr_retry', to: ['agent:pushy'], body: { n: 2 } });

      // First tick: row 1 fails and is scheduled for retry.
      await h.worker.tick();
      expect(hits).toBe(1);
      // Row 2 must NOT have been delivered while row 1 is still pending.
      expect(seen).toHaveLength(0);

      // Force row 1 due again, then drain.
      const rows = h.store.listInbox('ws_e2e', 'agent:pushy', null, 10);
      expect(rows.length).toBeGreaterThan(0);
      h.store.updateOutbox(rows[0]!.id, { nextAttemptAt: new Date(0).toISOString() });
      for (let i = 0; i < 6; i += 1) {
        for (const r of h.store.listInbox('ws_e2e', 'agent:pushy', null, 10)) {
          h.store.updateOutbox(r.id, { nextAttemptAt: new Date(0).toISOString() });
        }
        await h.worker.tick();
      }

      const order = seen.map((s) => (s as { body: { value: { n: number } } }).body.value.n);
      expect(order).toEqual([1, 2]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/* 4 ------------------------------------------------- offline recovery + DLQ */
describe('4. offline recovery', () => {
  it('keeps a message readable in the pull inbox after the webhook is unreachable', async () => {
    // Port 1 is closed, so every push fails at the transport.
    await h.registerAgent('offline', 'http://127.0.0.1:1/hook');
    await h.claude.send({ thread: 'thr_off', to: ['agent:offline'], body: { text: 'hi' } });

    await h.worker.tick();

    const rows = h.store.listInbox('ws_e2e', 'agent:offline', null, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.state).not.toBe('dead');
  });

  it('dead-letters once the retry budget is spent and shows it in the DLQ', async () => {
    await h.registerAgent('gone', 'http://127.0.0.1:1/hook');
    await h.claude.send({ thread: 'thr_gone', to: ['agent:gone'], body: { text: 'hi' } });

    const row = h.store.listInbox('ws_e2e', 'agent:gone', null, 10)[0];
    expect(row).toBeDefined();
    // Jump the attempt counter past the budget rather than waiting 24 h.
    h.store.updateOutbox(row!.id, { attempts: 400, nextAttemptAt: new Date(0).toISOString() });
    await h.worker.tick();

    expect(h.store.getOutbox(row!.id)?.state).toBe('dead');
    expect(h.store.listDead('ws_e2e').map((r) => r.id)).toContain(row!.id);
    // A dead row is no longer offered in the normal inbox.
    expect(h.store.listInbox('ws_e2e', 'agent:gone', null, 10)).toHaveLength(0);
  });

  it('delivers nothing twice once the agent acks', async () => {
    await h.claude.send({ thread: THREAD, to: ['agent:muse'], body: { text: 'one' } });
    const first = await h.muse.listInbox();
    expect(first.items).toHaveLength(1);
    await h.muse.ack(first.cursor as string);
    expect((await h.muse.listInbox()).items).toHaveLength(0);
  });
});

/* 5 ------------------------------------------------------------ approval gate */
describe('5. approval gate', () => {
  it('blocks a side-effect task and never delivers it', async () => {
    const gated = await h.claude.requestApproval({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 'email the recruiter',
      payload: { to: 'recruiter@example.com' },
    });
    expect(gated.state).toBe('needs-approval');
    expect((await h.muse.listInbox()).items.filter((i) => i.task === gated.id)).toHaveLength(0);
  });

  it('rejects an approval carrying the wrong payload hash', async () => {
    const gated = await h.claude.requestApproval({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 'send it',
      payload: { to: 'a@b.com' },
    });
    const res = await h.ownerApproveWithHash(gated.id, 'f'.repeat(64));
    expect(res.code).toBe('approval_hash_mismatch');
    expect((await h.claude.getTask(gated.id)).state).toBe('needs-approval');
  });

  it('releases the task on a correct owner-signed approval', async () => {
    const gated = await h.claude.requestApproval({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 'send it',
      payload: { to: 'a@b.com' },
    });
    await h.ownerApprove(gated.id);
    expect((await h.claude.getTask(gated.id)).state).toBe('submitted');
    expect((await h.muse.listInbox()).items.filter((i) => i.task === gated.id).length).toBe(1);
  });

  it('rejects a replayed approval', async () => {
    const gated = await h.claude.requestApproval({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 'send it',
      payload: { to: 'a@b.com' },
    });
    const task = await h.claude.getTask(gated.id);
    const { payloadHash } = await import('@agentbridge/contracts');
    const hash = payloadHash(task.payload);

    const first = await h.ownerApproveWithHash(gated.id, hash);
    expect(first.code).toBeNull();
    // Same hash again: the task is no longer awaiting a decision.
    const second = await h.ownerApproveWithHash(gated.id, hash);
    expect(second.code).not.toBeNull();
  });

  it('moves a rejected side effect to failed and never delivers it', async () => {
    const gated = await h.claude.requestApproval({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 'send it',
      payload: { to: 'a@b.com' },
    });
    await h.ownerApprove(gated.id, 'reject');
    expect((await h.claude.getTask(gated.id)).state).toBe('failed');
    expect((await h.muse.listInbox()).items.filter((i) => i.task === gated.id)).toHaveLength(0);
  });
});

/* 6 ------------------------------------------------------ security negatives */
describe('6. security negatives', () => {
  const raw = async (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string,
  ) =>
    fetch(`${h.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body }),
    });

  it('rejects an unsigned request', async () => {
    const res = await raw('GET', '/v1/inbox', { 'x-agentbridge-workspace': 'ws_e2e' });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong signature', async () => {
    const stranger = ed.utils.randomPrivateKey();
    const timestamp = new Date().toISOString();
    const sig = await signDescriptor(
      requestDescriptor({ method: 'GET', path: '/v1/inbox', query: {}, body: '', timestamp }),
      stranger,
    );
    const res = await raw('GET', '/v1/inbox', {
      'x-agentbridge-workspace': 'ws_e2e',
      'x-agentbridge-agent': 'agent:muse',
      'x-agentbridge-timestamp': timestamp,
      'x-agentbridge-signature': sig,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'signature_invalid',
    );
  });

  it('rejects a request missing the required scope', async () => {
    h.store.putAgent({
      ...h.store.getAgent('ws_e2e', 'agent:muse')!,
      scopes: ['read'],
    });
    await expect(
      h.muse.send({ thread: THREAD, to: ['agent:claude'], body: { x: 1 } }),
    ).rejects.toMatchObject({ code: 'scope_denied' });
  });

  it('rejects a request signed with a revoked key', async () => {
    // Owner-signed: an agent revoking another agent is refused outright now.
    await h.owner.revokeAgentKey('agent:muse');
    await expect(h.muse.listInbox()).rejects.toMatchObject({ code: 'key_revoked' });
  });

  it('rejects a replayed unsigned-key write', async () => {
    // An unkeyed write replayed verbatim must be refused as a replay.
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ state: 'accepted' });
    const path = '/v1/tasks/tsk_nonexistent';
    const sig = await signDescriptor(
      requestDescriptor({ method: 'PATCH', path, query: {}, body, timestamp }),
      h.museKey,
    );
    const headers = {
      'x-agentbridge-workspace': 'ws_e2e',
      'x-agentbridge-agent': 'agent:muse',
      'x-agentbridge-timestamp': timestamp,
      'x-agentbridge-signature': sig,
    };
    const first = await raw('PATCH', path, headers, body);
    expect(first.status).toBe(404);
    const replay = await raw('PATCH', path, headers, body);
    expect(replay.status).toBe(401);
  });

  it('refuses a cross-workspace read', async () => {
    await h.claude.send({ thread: THREAD, to: ['agent:muse'], body: { secret: 1 } });
    const timestamp = new Date().toISOString();
    const sig = await signDescriptor(
      requestDescriptor({ method: 'GET', path: '/v1/inbox', query: {}, body: '', timestamp }),
      h.museKey,
    );
    const res = await raw('GET', '/v1/inbox', {
      'x-agentbridge-workspace': 'ws_someone_else',
      'x-agentbridge-agent': 'agent:muse',
      'x-agentbridge-timestamp': timestamp,
      'x-agentbridge-signature': sig,
    });
    // The agent does not exist in that workspace, so it cannot read there.
    expect(res.status).toBe(401);
  });
});

/* 7 ------------------------------------------------------------------- audit */
describe('7. audit', () => {
  it('verifies the chain across the whole run', async () => {
    const task = await h.claude.createTask({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 't',
      payload: {},
    });
    await completeAsMuse(task.id);
    const gated = await h.claude.requestApproval({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 'send it',
      payload: { to: 'a@b.com' },
    });
    await h.ownerApprove(gated.id);

    const out = (await h.owner.auditLog()).verification;
    expect(out.ok).toBe(true);
    expect(out.checked).toBeGreaterThan(5);
  });

  it('REFUSES to mutate an audit row at the database level', async () => {
    // Seed a row first: a BEFORE UPDATE trigger fires per matching row, so an
    // UPDATE against an empty table raises nothing and would pass vacuously.
    await h.claude.createTask({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 't',
      payload: {},
    });
    expect(h.store.listAudit('ws_e2e', 0, 5).length).toBeGreaterThan(0);

    expect(() => h.store.exec("UPDATE audit SET action='tampered' WHERE seq=1")).toThrow(
      /append-only/i,
    );
    expect(() => h.store.exec('DELETE FROM audit WHERE seq=1')).toThrow(/append-only/i);
  });

  it('detects a broken chain if a row is somehow altered', async () => {
    await h.claude.createTask({
      thread: THREAD,
      assignee: 'agent:muse',
      title: 't',
      payload: {},
    });
    // Drop the triggers to simulate an attacker with direct DB access.
    h.store.exec('DROP TRIGGER audit_no_update');
    h.store.exec("UPDATE audit SET action='tampered' WHERE seq=1");
    const out = (await h.owner.auditLog()).verification;
    expect(out.ok).toBe(false);
    expect(out.brokenAtSeq).toBe(1);
  });
});
