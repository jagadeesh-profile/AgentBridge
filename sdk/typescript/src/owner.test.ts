import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import * as ed from '@noble/ed25519';
import { payloadHash } from '@agentbridge/contracts';
import { buildApp } from '@agentbridge/hub/http';
import { makeFakes, type Fakes } from '@agentbridge/hub/ports/fakes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { OwnerClient } from './owner.js';

let deps: Fakes;
let app: FastifyInstance;
let owner: OwnerClient;
let ownerPriv: Uint8Array;

function gated(id: string, payload: unknown = { to: 'a@b.com' }, state = 'needs-approval') {
  deps.store.putTask({
    id,
    workspace: 'ws',
    thread: 'thr_1',
    creator: 'agent:claude',
    assignee: 'agent:muse',
    title: 'send email',
    payload,
    payloadHash: payloadHash(payload),
    state: state as 'needs-approval',
    sideEffect: true,
    dueAt: null,
    createdAt: `2026-10-20T12:00:0${id.slice(-1)}.000Z`,
    updatedAt: '2026-10-20T12:00:00.000Z',
  });
}

beforeEach(async () => {
  deps = makeFakes();
  ownerPriv = ed.utils.randomPrivateKey();
  app = await buildApp(
    {
      ...deps,
      clock: { now: () => new Date() },
      ownerPublicKey: await ed.getPublicKeyAsync(ownerPriv),
    },
    { logger: false, rateLimitMax: 5000 },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  owner = new OwnerClient({
    baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    workspace: 'ws',
    privateKey: ownerPriv,
  });
});

afterEach(async () => {
  await app.close();
});

describe('OwnerClient', () => {
  it('lists what awaits a decision with NO agent identity anywhere', async () => {
    gated('tsk_1');
    gated('tsk_2', { to: 'c@d.com' }, 'completed');
    const items = await owner.listPendingApprovals();
    expect(items.map((t) => t.id)).toEqual(['tsk_1']);
  });

  it('approves, and the task becomes deliverable', async () => {
    gated('tsk_1');
    const [task] = await owner.listPendingApprovals();
    const out = await owner.decide(task!, 'approve');
    expect(out.state).toBe('submitted');
    expect(deps.store.getTask('ws', 'tsk_1')?.state).toBe('submitted');
  });

  it('rejects, and the task fails WITHOUT ever being delivered', async () => {
    gated('tsk_1');
    const [task] = await owner.listPendingApprovals();
    await owner.decide(task!, 'reject');
    expect(deps.store.getTask('ws', 'tsk_1')?.state).toBe('failed');
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10)).toHaveLength(0);
  });

  it('IGNORES the advertised hash and signs one recomputed from the payload', async () => {
    gated('tsk_1', { to: 'recruiter@example.com' });
    const [task] = await owner.listPendingApprovals();
    // A task whose advertised hash disagrees with its payload — the shape a
    // buggy or compromised hub would produce. Succeeding proves the advertised
    // figure was never used; had the client signed it, the hub would have
    // answered approval_hash_mismatch.
    const lying = { ...task!, payloadHash: payloadHash({ to: 'attacker@evil.com' }) };
    await expect(owner.decide(lying, 'approve')).resolves.toMatchObject({ state: 'submitted' });
  });

  it('puts payloadHash(payload) on the wire, which is the signed quantity', async () => {
    // Asserted on the request itself, so the guarantee does not rest on the
    // hub happening to disagree. The owner approves what they were shown.
    let sent: Record<string, unknown> = {};
    const capturing = new OwnerClient({
      baseUrl: owner.baseUrl,
      workspace: 'ws',
      privateKey: ownerPriv,
      fetch: async (url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ id: 'tsk_1', state: 'submitted' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await capturing.decide({ id: 'tsk_1', payload: { to: 'recruiter@example.com' } }, 'approve');
    expect(sent.payload_hash).toBe(payloadHash({ to: 'recruiter@example.com' }));
  });

  it('REFUSES to act with a key that is not the owner key', async () => {
    gated('tsk_1');
    const impostor = new OwnerClient({
      baseUrl: owner.baseUrl,
      workspace: 'ws',
      privateKey: ed.utils.randomPrivateKey(),
    });
    await expect(impostor.listPendingApprovals()).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('calls the default fetch UNBOUND from the instance, as a browser requires', async () => {
    // `this.fetchImpl(...)` invokes fetch with `this` set to the client, which
    // Node tolerates and a browser rejects with "Illegal invocation". Every
    // other test injects a fetch, so the default path was only ever exercised
    // in Node — this asserts the receiver directly.
    const realFetch = globalThis.fetch;
    const receivers: unknown[] = [];
    globalThis.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      receivers.push(this);
      return realFetch(...args);
    } as typeof fetch;
    try {
      const c = new OwnerClient({ baseUrl: owner.baseUrl, workspace: 'ws', privateKey: ownerPriv });
      await c.listPendingApprovals();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(receivers.length).toBeGreaterThan(0);
    for (const r of receivers) expect(r).not.toBeInstanceOf(OwnerClient);
  });

  it('is importable in a browser: no node: builtins anywhere in its import graph', () => {
    // The console loads the owner key into the page and signs there. A single
    // `node:fs` in this module's graph would break that build — and the usual
    // fix, moving signing to a server, is exactly what must not happen.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['owner.ts', 'untrusted.ts']) {
      const src = readFileSync(join(here, file), 'utf8');
      expect(src, file).not.toMatch(/from 'node:/);
    }
  });
});

describe('OwnerClient kill switch', () => {
  function agent(name: string, keyStatus: 'active' | 'revoked' = 'active') {
    deps.store.putAgent({
      ref: `agent:${name}`,
      workspace: 'ws',
      name,
      publicKey: 'QUFBQQ==',
      webhookUrl: null,
      webhookSecret: null,
      scopes: ['read', 'message'],
      keyStatus,
      capabilities: {},
      createdAt: '2026-10-20T00:00:00.000Z',
    });
  }

  it('lists the roster with key status', async () => {
    agent('claude');
    agent('muse');
    const roster = await owner.listAgents();
    expect(roster.map((a) => a.ref).sort()).toEqual(['agent:claude', 'agent:muse']);
    expect(roster.every((a) => a.keyStatus === 'active')).toBe(true);
  });

  it('revokes a key and the roster then says so', async () => {
    agent('muse');
    await owner.revokeAgentKey('agent:muse');
    const roster = await owner.listAgents();
    expect(roster.find((a) => a.ref === 'agent:muse')?.keyStatus).toBe('revoked');
    expect(deps.store.getAgent('ws', 'agent:muse')?.keyStatus).toBe('revoked');
  });

  it('drops that agent pending deliveries, so in-flight work stops too', async () => {
    agent('muse');
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
    await owner.revokeAgentKey('agent:muse');
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10)).toHaveLength(0);
  });

  it('encodes the ref, so a colon in agent:muse survives the path', async () => {
    agent('muse');
    // `agent:muse` unencoded would make the hub see a different path than the
    // one that was signed.
    await expect(owner.revokeAgentKey('agent:muse')).resolves.toEqual({ revoked: 'agent:muse' });
  });

  it('404s rather than silently succeeding on an unknown agent', async () => {
    await expect(owner.revokeAgentKey('agent:ghost')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('OwnerClient task board', () => {
  it('lists every state, not just what awaits approval', async () => {
    gated('tsk_1');
    gated('tsk_2', { to: 'c@d.com' }, 'working');
    gated('tsk_3', { to: 'e@f.com' }, 'completed');
    const all = await owner.listTasks();
    expect(all.map((t) => t.state).sort()).toEqual(['completed', 'needs-approval', 'working']);
  });

  it('leaves payloads behind by default — a board does not need them', async () => {
    gated('tsk_1', { to: 'secret@example.com' });
    const [task] = await owner.listTasks();
    expect(task?.payload).toBeUndefined();
    // The hash still arrives, so the board can show it.
    expect(task?.payloadHash).toBe(payloadHash({ to: 'secret@example.com' }));
  });

  it('fetches payloads when asked, so one call can serve both views', async () => {
    gated('tsk_1', { to: 'a@b.com' });
    const [task] = await owner.listTasks({ includePayload: true });
    expect(task?.payload).toEqual({ to: 'a@b.com' });
  });

  it('cancels a task as the owner', async () => {
    gated('tsk_1');
    await owner.cancelTask('tsk_1');
    expect(deps.store.getTask('ws', 'tsk_1')?.state).toBe('canceled');
  });

  it('refuses to cancel a task already in a terminal state', async () => {
    gated('tsk_1', { to: 'a@b.com' }, 'completed');
    await expect(owner.cancelTask('tsk_1')).rejects.toMatchObject({
      code: 'illegal_transition',
    });
    expect(deps.store.getTask('ws', 'tsk_1')?.state).toBe('completed');
  });

  it('records the cancel in the audit chain, attributed to the owner', async () => {
    gated('tsk_1');
    await owner.cancelTask('tsk_1');
    const row = deps.store.listAudit('ws', 0, 50).find((r) => r.action === 'task.cancel');
    expect(row?.actor).toBe('owner');
  });
});
