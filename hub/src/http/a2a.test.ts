import * as ed from '@noble/ed25519';
import { requestDescriptor, signDescriptor } from '@agentbridge/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeFakes, type Fakes } from '../ports/fakes/index.js';
import { registerAgent } from '../domain/registry.js';
import { buildApp } from './app.js';

let deps: Fakes;
let app: FastifyInstance;
let clPriv: Uint8Array;

/** A signed JSON-RPC call to /a2a/v1, as a remote A2A agent would make it. */
async function rpc(method: string, params?: unknown, over: { priv?: Uint8Array } = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const timestamp = deps.clock.now().toISOString();
  const sig = await signDescriptor(
    requestDescriptor({ method: 'POST', path: '/a2a/v1', query: {}, body, timestamp }),
    over.priv ?? clPriv,
  );
  return {
    method: 'POST' as const,
    url: '/a2a/v1',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-agentbridge-workspace': 'ws',
      'x-agentbridge-agent': 'agent:claude',
      'x-agentbridge-timestamp': timestamp,
      'x-agentbridge-signature': sig,
    },
  };
}

const send = (over: Record<string, unknown> = {}) => ({
  message: { parts: [{ kind: 'data', data: { q: 'staff eng' } }] },
  metadata: { 'agentbridge/assignee': 'agent:muse', ...over },
});

beforeEach(async () => {
  deps = makeFakes();
  clPriv = ed.utils.randomPrivateKey();
  const pub = Buffer.from(await ed.getPublicKeyAsync(clPriv)).toString('base64');
  registerAgent(deps, 'ws', {
    name: 'claude',
    capabilities: {},
    public_key: pub,
    scopes: ['read', 'message', 'create_task', 'request_side_effect'],
  });
  registerAgent(deps, 'ws', {
    name: 'muse',
    capabilities: {},
    public_key: 'BBBB',
    scopes: ['read', 'message'],
  });
  app = await buildApp(
    { ...deps, ownerPublicKey: new Uint8Array(32) },
    { logger: false, rateLimitMax: 1000 },
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('the agent card', () => {
  it('is served without credentials, because discovery precedes them', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/agent-card.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().protocolVersion).toBe('1.0');
  });

  it('LEAKS NOTHING about the workspace', async () => {
    // The one endpoint anyone can reach unauthenticated. If a workspace or an
    // agent name ever appears here, it is a disclosure to the whole internet.
    const body = (await app.inject({ method: 'GET', url: '/.well-known/agent-card.json' })).body;
    for (const secret of ['agent:claude', 'agent:muse', 'ws', 'BBBB']) {
      expect(body.includes(`"${secret}"`), secret).toBe(false);
    }
  });

  it('declares streaming and push as unsupported rather than advertising them', async () => {
    // A caller that believes `streaming: true` and gets a non-stream has no
    // recourse; one that reads false polls tasks/get, which works.
    const card = (await app.inject({ method: 'GET', url: '/.well-known/agent.json' })).json();
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
  });
});

describe('/a2a/v1 authentication', () => {
  it('REFUSES an unsigned call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/a2a/v1',
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } }),
      headers: { 'content-type': 'application/json', 'x-agentbridge-workspace': 'ws' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('REFUSES a call signed by a key that is not the agent own', async () => {
    const res = await app.inject(
      await rpc('tasks/get', { id: 'x' }, { priv: ed.utils.randomPrivateKey() }),
    );
    expect(res.statusCode).toBe(401);
  });

  it('acts as the REMOTE agent, not as an adapter identity', async () => {
    // The created task must be attributed to the caller. If the endpoint had
    // its own key, every remote agent would share one identity and one set of
    // scopes.
    const res = await app.inject(await rpc('message/send', send()));
    const id = res.json().result.id as string;
    expect(deps.store.getTask('ws', id)?.creator).toBe('agent:claude');
  });
});

describe('message/send', () => {
  it('creates a task and returns it in A2A shape', async () => {
    const res = await app.inject(await rpc('message/send', send()));
    const result = res.json().result;
    expect(result.kind).toBe('task');
    expect(result.status.state).toBe('submitted');
    expect(deps.store.getTask('ws', result.id)?.payload).toEqual({ q: 'staff eng' });
  });

  it('REFUSES to guess an assignee', async () => {
    const res = await app.inject(
      await rpc('message/send', { message: { parts: [] }, metadata: {} }),
    );
    expect(res.json().error.code).toBe(-32602);
  });

  it('holds a side-effect task at the gate and reports auth-required', async () => {
    // The mapping that matters: A2A has no approval gate, and the remote
    // caller must learn it is blocked on an authorisation it cannot supply.
    const res = await app.inject(
      await rpc('message/send', send({ 'agentbridge/side_effect': true })),
    );
    const result = res.json().result;
    expect(result.status.state).toBe('auth-required');
    expect(result.metadata['agentbridge/state']).toBe('needs-approval');
    // And the assignee must not have been handed it.
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10)).toHaveLength(0);
  });

  it('refuses a side effect from an agent without the scope', async () => {
    const musePriv = ed.utils.randomPrivateKey();
    deps.store.putAgent({
      ...(deps.store.getAgent('ws', 'agent:claude') as NonNullable<
        ReturnType<typeof deps.store.getAgent>
      >),
      scopes: ['read', 'message', 'create_task'],
      publicKey: Buffer.from(await ed.getPublicKeyAsync(musePriv)).toString('base64'),
    });
    const res = await app.inject(
      await rpc('message/send', send({ 'agentbridge/side_effect': true }), { priv: musePriv }),
    );
    expect(res.json().error.data.agentbridgeCode).toBe('scope_denied');
  });
});

describe('tasks/get and tasks/cancel', () => {
  async function create() {
    const res = await app.inject(await rpc('message/send', send()));
    return res.json().result.id as string;
  }

  it('reads back a task the caller created', async () => {
    const id = await create();
    const res = await app.inject(await rpc('tasks/get', { id }));
    expect(res.json().result.id).toBe(id);
  });

  it('REFUSES to read a task the caller has nothing to do with', async () => {
    // Otherwise a registered agent could enumerate the workspace by task id.
    deps.store.putTask({
      id: 'tsk_other',
      workspace: 'ws',
      thread: 'thr_x',
      creator: 'agent:muse',
      assignee: 'agent:muse',
      title: 'not yours',
      payload: {},
      payloadHash: 'f'.repeat(64),
      state: 'working',
      sideEffect: false,
      dueAt: null,
      createdAt: '2026-10-20T12:00:00.000Z',
      updatedAt: '2026-10-20T12:00:00.000Z',
    });
    const res = await app.inject(await rpc('tasks/get', { id: 'tsk_other' }));
    expect(res.json().error.code).toBe(-32001);
  });

  it('cancels its own task', async () => {
    const id = await create();
    const res = await app.inject(await rpc('tasks/cancel', { id }));
    expect(res.json().result.status.state).toBe('canceled');
    expect(deps.store.getTask('ws', id)?.state).toBe('canceled');
  });

  it('cannot cancel a task it did not create', async () => {
    deps.store.putTask({
      id: 'tsk_other',
      workspace: 'ws',
      thread: 'thr_x',
      creator: 'agent:muse',
      assignee: 'agent:muse',
      title: 'not yours',
      payload: {},
      payloadHash: 'f'.repeat(64),
      state: 'working',
      sideEffect: false,
      dueAt: null,
      createdAt: '2026-10-20T12:00:00.000Z',
      updatedAt: '2026-10-20T12:00:00.000Z',
    });
    const res = await app.inject(await rpc('tasks/cancel', { id: 'tsk_other' }));
    expect(res.json().error).toBeDefined();
    expect(deps.store.getTask('ws', 'tsk_other')?.state).toBe('working');
  });
});

describe('JSON-RPC conformance', () => {
  it('answers an unknown method with -32601', async () => {
    expect((await app.inject(await rpc('nope/nope'))).json().error.code).toBe(-32601);
  });

  it('declines streaming with a reason rather than failing opaquely', async () => {
    const res = await app.inject(await rpc('message/stream', send()));
    expect(res.json().error.code).toBe(-32004);
    expect(res.json().error.message).toMatch(/streaming/i);
  });

  it('declines push notification config as unsupported', async () => {
    const res = await app.inject(await rpc('tasks/pushNotificationConfig/set', { id: 'x' }));
    expect(res.json().error.code).toBe(-32003);
  });

  it('echoes the request id even when the envelope is malformed', async () => {
    // A client correlating by id otherwise waits forever for a reply it can
    // match to the call it made.
    const body = JSON.stringify({ jsonrpc: '1.0', id: 77, method: 'tasks/get' });
    const timestamp = deps.clock.now().toISOString();
    const sig = await signDescriptor(
      requestDescriptor({ method: 'POST', path: '/a2a/v1', query: {}, body, timestamp }),
      clPriv,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/a2a/v1',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': 'ws',
        'x-agentbridge-agent': 'agent:claude',
        'x-agentbridge-timestamp': timestamp,
        'x-agentbridge-signature': sig,
      },
    });
    expect(res.json().id).toBe(77);
    expect(res.json().error.code).toBe(-32600);
  });

  it('returns 200 for an application error, so transport failure stays distinguishable', async () => {
    const res = await app.inject(await rpc('tasks/get', { id: 'tsk_missing' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().error.code).toBe(-32001);
  });
});
