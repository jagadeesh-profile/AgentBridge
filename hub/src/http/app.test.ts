import * as ed from '@noble/ed25519';
import {
  ERROR_CATALOG,
  canonicalize,
  ownerRequestDescriptor,
  payloadHash,
  registrationDescriptor,
  requestDescriptor,
  signDescriptor,
} from '@agentbridge/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeFakes, type Fakes } from '../ports/fakes/index.js';
import { registerAgent } from '../domain/registry.js';
import { assertDepth } from './errors.js';
import { REDACTED_PATHS } from './logger.js';
import { buildApp } from './app.js';

let deps: Fakes;
let app: FastifyInstance;
let clPriv: Uint8Array;
let ownerPriv: Uint8Array;
let ownerPub: Uint8Array;

async function signed(
  method: string,
  path: string,
  bodyObj?: unknown,
  agentRef = 'agent:claude',
  priv?: Uint8Array,
) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const timestamp = deps.clock.now().toISOString();
  const [bare, qs] = path.split('?');
  const query: Record<string, string> = {};
  if (qs !== undefined) {
    for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  }
  const sig = await signDescriptor(
    requestDescriptor({ method, path: bare ?? path, query, body, timestamp }),
    priv ?? clPriv,
  );
  return {
    method,
    url: path,
    ...(bodyObj === undefined ? {} : { payload: body }),
    headers: {
      'content-type': 'application/json',
      'x-agentbridge-workspace': 'ws',
      'x-agentbridge-agent': agentRef,
      'x-agentbridge-timestamp': timestamp,
      'x-agentbridge-signature': sig,
    },
  };
}

beforeEach(async () => {
  deps = makeFakes();
  clPriv = ed.utils.randomPrivateKey();
  ownerPriv = ed.utils.randomPrivateKey();
  ownerPub = await ed.getPublicKeyAsync(ownerPriv);
  const pub = Buffer.from(await ed.getPublicKeyAsync(clPriv)).toString('base64');
  registerAgent(deps, 'ws', {
    name: 'claude',
    capabilities: {},
    public_key: pub,
    scopes: ['read', 'message', 'create_task'],
  });
  registerAgent(deps, 'ws', {
    name: 'muse',
    capabilities: {},
    public_key: 'BBBB',
    scopes: ['read', 'message'],
  });
  app = await buildApp(
    {
      ...deps,
      ownerPublicKey: ownerPub,
    },
    { logger: false, rateLimitMax: 1000 },
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('error mapping', () => {
  it('maps AgentBridgeError to its catalog status and shape', async () => {
    const res = await app.inject(
      await signed('POST', '/v1/tasks', {
        thread: 'thr_1',
        assignee: 'agent:ghost',
        title: 't',
        payload: {},
        side_effect: false,
      }),
    );
    expect(res.statusCode).toBe(404);
    const parsed = res.json() as { error: { code: string; trace_id: string; message: string } };
    expect(parsed.error.code).toBe('not_found');
    expect(parsed.error.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(parsed.error).sort()).toEqual(['code', 'message', 'trace_id']);
  });

  it('returns scope_denied with 403 when the agent lacks the scope', async () => {
    const res = await app.inject(
      await signed('POST', '/v1/tasks', {
        thread: 'thr_1',
        assignee: 'agent:claude',
        title: 't',
        payload: {},
        side_effect: true,
      }),
    );
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('scope_denied');
  });

  it('returns schema_invalid with 400 when the body fails the contract', async () => {
    const res = await app.inject(await signed('POST', '/v1/tasks', { thread: 'thr_1' }));
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('schema_invalid');
  });

  it('never leaks a stack trace or file path in an error body', async () => {
    const res = await app.inject(await signed('POST', '/v1/tasks', { thread: 'thr_1' }));
    expect(res.body).not.toMatch(/at \w+|\.ts:|node_modules|C:\\/);
  });

  it('rejects an unsigned request with unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/inbox' });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('unauthenticated');
  });

  it('rejects a wrong signature with signature_invalid', async () => {
    const req = await signed(
      'GET',
      '/v1/inbox',
      undefined,
      'agent:claude',
      ed.utils.randomPrivateKey(),
    );
    const res = await app.inject(req);
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('signature_invalid');
  });

  it('serves /healthz without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('happy path over HTTP', () => {
  it('creates a task and reads it back', async () => {
    const created = await app.inject(
      await signed('POST', '/v1/tasks', {
        thread: 'thr_1',
        assignee: 'agent:muse',
        title: 'list matches',
        payload: { count: 3 },
        side_effect: false,
      }),
    );
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const read = await app.inject(await signed('GET', `/v1/tasks/${id}`));
    expect(read.statusCode).toBe(200);
    expect((read.json() as { state: string }).state).toBe('submitted');
  });

  it('replays an idempotent create rather than making a second task', async () => {
    const payload = {
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 'once',
      payload: {},
      side_effect: false,
      idempotency_key: 'only-once',
    };
    const a = await app.inject(await signed('POST', '/v1/tasks', payload));
    const b = await app.inject(await signed('POST', '/v1/tasks', payload));
    expect((a.json() as { id: string }).id).toBe((b.json() as { id: string }).id);
  });

  it('wraps inbox bodies as untrusted', async () => {
    await app.inject(
      await signed('POST', '/v1/messages', {
        thread: 'thr_1',
        to: ['agent:muse'],
        body: { text: 'hi' },
        side_effect: false,
        idempotency_key: 'm1',
      }),
    );
    // Read as muse: a separate key, so re-register with a known one.
    const musePriv = ed.utils.randomPrivateKey();
    deps.store.putAgent({
      ...(deps.store.getAgent('ws', 'agent:muse') as NonNullable<
        ReturnType<typeof deps.store.getAgent>
      >),
      publicKey: Buffer.from(await ed.getPublicKeyAsync(musePriv)).toString('base64'),
    });
    const res = await app.inject(
      await signed('GET', '/v1/inbox', undefined, 'agent:muse', musePriv),
    );
    expect(res.statusCode).toBe(200);
    const page = res.json() as { items: { body: { untrusted: boolean } }[] };
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]?.body.untrusted).toBe(true);
  });
});

// Review Focus item 5 — hostile payload shapes.
describe('hostile payloads', () => {
  it('REJECTS a body over the size limit with 413 and keeps serving', async () => {
    const small = await buildApp(
      { ...deps, ownerPublicKey: ownerPub },
      { logger: false, bodyLimit: 1024, rateLimitMax: 1000 },
    );
    await small.ready();
    try {
      const big = await small.inject({
        method: 'POST',
        url: '/v1/tasks',
        payload: JSON.stringify({ pad: 'x'.repeat(5000) }),
        headers: { 'content-type': 'application/json' },
      });
      expect(big.statusCode).toBe(413);
      // The process still serves afterwards.
      const health = await small.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
    } finally {
      await small.close();
    }
  });

  it('REJECTS a 10000-deep nested object with schema_invalid, not a crash', async () => {
    const deep = `${'{"a":'.repeat(10_000)}1${'}'.repeat(10_000)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: deep,
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': 'ws',
        'x-agentbridge-agent': 'agent:claude',
        'x-agentbridge-timestamp': deps.clock.now().toISOString(),
        'x-agentbridge-signature': 'ed25519:AAAA',
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('schema_invalid');

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
  });

  it('assertDepth rejects deep nesting without overflowing its own stack', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20_000; i += 1) deep = { a: deep };
    expect(() => assertDepth(deep)).toThrow(/depth/i);
  });

  it('assertDepth accepts ordinary payloads', () => {
    expect(() => assertDepth({ a: { b: { c: [1, 2, { d: 'e' }] } } })).not.toThrow();
  });

  it('rejects malformed JSON with schema_invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: '{not json',
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': 'ws',
        'x-agentbridge-agent': 'agent:claude',
        'x-agentbridge-timestamp': deps.clock.now().toISOString(),
        'x-agentbridge-signature': 'ed25519:AAAA',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('log redaction', () => {
  it('redacts every field that could carry agent content or a secret', () => {
    for (const path of ['body', 'value', 'payload', 'inline', 'webhookSecret', 'privateKey']) {
      expect(REDACTED_PATHS, path).toContain(path);
    }
  });
});

describe('rate limiting', () => {
  it('returns rate_limited once an agent exceeds its burst', async () => {
    const tight = await buildApp(
      { ...deps, ownerPublicKey: ownerPub },
      { logger: false, rateLimitMax: 2, rateLimitWindow: '1 minute' },
    );
    await tight.ready();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await tight.inject(await signed('GET', '/v1/inbox'));
        codes.push(res.statusCode);
      }
      expect(codes).toContain(429);
    } finally {
      await tight.close();
    }
  });
});

// Task 19: the trace id must reach the stored message, replacing the
// UNSET_TRACE_ID placeholder the domain used before this was wired.
describe('trace propagation', () => {
  it('carries an inbound trace id through to the stored message', async () => {
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
    const req = await signed('POST', '/v1/messages', {
      thread: 'thr_1',
      to: ['agent:muse'],
      body: { text: 'hi' },
      side_effect: false,
      idempotency_key: 'm-trace',
    });
    const res = await app.inject({
      ...req,
      headers: { ...req.headers, 'x-agentbridge-trace-id': trace },
    });
    expect(res.statusCode).toBe(202);
    const { id } = res.json() as { id: string };
    expect(deps.store.getMessage('ws', id)?.traceId).toBe(trace);
  });

  it('generates a trace id when the caller sends none, never the placeholder', async () => {
    const res = await app.inject(
      await signed('POST', '/v1/messages', {
        thread: 'thr_1',
        to: ['agent:muse'],
        body: { text: 'hi' },
        side_effect: false,
        idempotency_key: 'm-notrace',
      }),
    );
    const { id } = res.json() as { id: string };
    const stored = deps.store.getMessage('ws', id)?.traceId;
    expect(stored).toMatch(/^[0-9a-f]{32}$/);
    expect(stored).not.toBe('0'.repeat(32));
  });

  it('replaces a malformed inbound trace id rather than storing it', async () => {
    const req = await signed('POST', '/v1/messages', {
      thread: 'thr_1',
      to: ['agent:muse'],
      body: { text: 'hi' },
      side_effect: false,
      idempotency_key: 'm-badtrace',
    });
    const res = await app.inject({
      ...req,
      headers: { ...req.headers, 'x-agentbridge-trace-id': '../../etc/passwd' },
    });
    const { id } = res.json() as { id: string };
    expect(deps.store.getMessage('ws', id)?.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('puts a trace_id in every error body', async () => {
    const res = await app.inject(await signed('POST', '/v1/tasks', { thread: 'thr_1' }));
    expect((res.json() as { error: { trace_id: string } }).error.trace_id).toMatch(
      /^[0-9a-f]{32}$/,
    );
  });

  it('carries the task trace id into the notification to the assignee', async () => {
    const trace = 'aaaaaaaabbbbbbbbccccccccdddddddd';
    const req = await signed('POST', '/v1/tasks', {
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 't',
      payload: {},
      side_effect: false,
      idempotency_key: 'tsk-trace',
    });
    const res = await app.inject({
      ...req,
      headers: { ...req.headers, 'x-agentbridge-trace-id': trace },
    });
    expect(res.statusCode).toBe(201);
    const rows = deps.store.listInbox('ws', 'agent:muse', null, 10);
    expect(rows.length).toBeGreaterThan(0);
    const msg = deps.store.getMessage('ws', rows[0]!.messageId);
    expect(msg?.traceId).toBe(trace);
  });
});

// ADR 0005: registration is authorised by the OWNER's Ed25519 signature, not a
// shared secret. The owner key already exists for approvals, so this adds no
// new credential and authenticates *who* enrolled rather than merely that
// someone held a secret.
describe('registration is owner-signed', () => {
  async function registration(
    over: {
      name?: string;
      publicKey?: string;
      scopes?: string[];
      webhookUrl?: string;
      issuedAt?: string;
      workspace?: string;
      signWith?: Uint8Array;
      signedScopes?: string[];
      signedWorkspace?: string;
    } = {},
  ) {
    const name = over.name ?? 'invited';
    const publicKey = over.publicKey ?? 'QUFBQQ==';
    const scopes = over.scopes ?? ['read', 'message'];
    const issuedAt = over.issuedAt ?? deps.clock.now().toISOString();
    const workspace = over.workspace ?? 'ws';

    const descriptor = registrationDescriptor({
      // Deliberately allow the SIGNED values to differ from the sent ones, so
      // a test can prove the binding actually holds.
      workspace: over.signedWorkspace ?? workspace,
      name,
      publicKey,
      scopes: over.signedScopes ?? scopes,
      ...(over.webhookUrl === undefined ? {} : { webhookUrl: over.webhookUrl }),
      issuedAt,
    });
    const sig = await signDescriptor(descriptor, over.signWith ?? ownerPriv);

    return {
      method: 'POST' as const,
      url: '/v1/agents',
      payload: JSON.stringify({
        name,
        capabilities: { skills: [], input: [], output: [] },
        public_key: publicKey,
        scopes,
        ...(over.webhookUrl === undefined ? {} : { webhook_url: over.webhookUrl }),
      }),
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': workspace,
        'x-agentbridge-timestamp': issuedAt,
        'x-agentbridge-owner-signature': sig,
      },
    };
  }

  it('accepts a registration signed by the owner', async () => {
    const res = await app.inject(await registration());
    expect(res.statusCode).toBe(201);
    expect(deps.store.getAgent('ws', 'agent:invited')?.scopes).toEqual(['read', 'message']);
  });

  it('REJECTS a registration with no signature', async () => {
    const req = await registration();
    delete (req.headers as Record<string, string>)['x-agentbridge-owner-signature'];
    const res = await app.inject(req);
    expect(res.statusCode).toBe(401);
    expect(deps.store.getAgent('ws', 'agent:invited')).toBeNull();
  });

  it('REJECTS a registration signed by someone other than the owner', async () => {
    const res = await app.inject(await registration({ signWith: ed.utils.randomPrivateKey() }));
    expect(res.statusCode).toBe(401);
    expect(deps.store.getAgent('ws', 'agent:invited')).toBeNull();
  });

  it('REJECTS scopes wider than the owner signed, so no self-escalation', async () => {
    const res = await app.inject(
      await registration({
        signedScopes: ['read', 'message'],
        scopes: ['read', 'message', 'request_side_effect'],
      }),
    );
    expect(res.statusCode).toBe(401);
    expect(deps.store.getAgent('ws', 'agent:invited')).toBeNull();
  });

  it('REJECTS a signature issued for a different workspace', async () => {
    const res = await app.inject(
      await registration({ signedWorkspace: 'ws_other', workspace: 'ws' }),
    );
    expect(res.statusCode).toBe(401);
    expect(deps.store.getAgent('ws', 'agent:invited')).toBeNull();
  });

  it('REJECTS a signature older than the replay window', async () => {
    const stale = new Date(deps.clock.now().getTime() - 301_000).toISOString();
    const res = await app.inject(await registration({ issuedAt: stale }));
    expect(res.statusCode).toBe(401);
  });

  it('BLAMES the clock, not the key, when registration is refused for drift', async () => {
    // ADR 0005 noted this: owner signing made registration sensitive to skew,
    // and a bare `unauthenticated` sends the operator to re-check their key.
    const stale = new Date(deps.clock.now().getTime() - 600_000).toISOString();
    const res = await app.inject(await registration({ issuedAt: stale }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/600s behind .*clock/i);
  });

  it('still WITHHOLDS every other rejection reason from the client', async () => {
    // Opting one message in must not opt the rest in. "already used" versus
    // "signature rejected" would tell an attacker whether they are replaying
    // or forging; both must read as the same generic refusal.
    const req = await registration({ name: 'twice' });
    expect((await app.inject(req)).statusCode).toBe(201);
    const replayed = (await app.inject(req)).json().error.message;
    const forged = (
      await app.inject(
        await registration({ name: 'forged', signWith: ed.utils.randomPrivateKey() }),
      )
    ).json().error.message;

    expect(replayed).toBe(forged);
    // The shared generic refusal, not either specific reason. (It mentions the
    // replay *window* — that is the catalog wording, not a disclosure that
    // this particular request was a replay.)
    expect(replayed).toBe(ERROR_CATALOG.unauthenticated.message);
    expect(replayed).not.toMatch(/already|rejected|clock/i);
  });

  it('REJECTS a replayed registration, even one that previously succeeded', async () => {
    const req = await registration({ name: 'once' });
    expect((await app.inject(req)).statusCode).toBe(201);
    // Same signature again: the name now conflicts, but it must be refused as a
    // replay before that is even considered.
    const replay = await app.inject(req);
    expect(replay.statusCode).toBe(401);
  });

  it('binds the webhook url, so delivery cannot be redirected after signing', async () => {
    const signed = await registration({
      name: 'pushy',
      webhookUrl: 'https://good.example/hook',
    });
    const body = JSON.parse(signed.payload) as Record<string, unknown>;
    body.webhook_url = 'https://attacker.example/hook';
    const res = await app.inject({ ...signed, payload: JSON.stringify(body) });
    expect(res.statusCode).toBe(401);
    expect(deps.store.getAgent('ws', 'agent:pushy')).toBeNull();
  });

  it('still returns the webhook secret exactly once on success', async () => {
    const res = await app.inject(
      await registration({ name: 'hooked', webhookUrl: 'https://good.example/hook' }),
    );
    expect(res.statusCode).toBe(201);
    expect((res.json() as { webhook_secret: string }).webhook_secret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('owner-authenticated routes (ADR 0006)', () => {
  async function ownerSigned(
    method: string,
    path: string,
    bodyObj?: unknown,
    over: {
      signWith?: Uint8Array;
      workspace?: string;
      signedWorkspace?: string;
    } = {},
  ) {
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const timestamp = deps.clock.now().toISOString();
    const [bare, qs] = path.split('?');
    const query: Record<string, string> = {};
    if (qs !== undefined) for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
    const workspace = over.workspace ?? 'ws';
    const sig = await signDescriptor(
      ownerRequestDescriptor({
        method,
        path: bare ?? path,
        query,
        body,
        workspace: over.signedWorkspace ?? workspace,
        issuedAt: timestamp,
      }),
      over.signWith ?? ownerPriv,
    );
    return {
      method,
      url: path,
      ...(bodyObj === undefined ? {} : { payload: body }),
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': workspace,
        'x-agentbridge-timestamp': timestamp,
        'x-agentbridge-owner-signature': sig,
      },
    };
  }

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
      createdAt: '2026-10-20T12:00:00.000Z',
      updatedAt: '2026-10-20T12:00:00.000Z',
    });
  }

  describe('GET /v1/tasks', () => {
    it('lists what awaits a decision, for an owner-signed request', async () => {
      gated('tsk_a');
      gated('tsk_b', { to: 'c@d.com' }, 'completed');
      const res = await app.inject(await ownerSigned('GET', '/v1/tasks?state=needs-approval'));
      expect(res.statusCode).toBe(200);
      const items = res.json().items as { id: string }[];
      expect(items.map((t) => t.id)).toEqual(['tsk_a']);
    });

    it('returns the payload AND its hash, so the console can recompute and compare', async () => {
      gated('tsk_a', { to: 'recruiter@example.com' });
      const res = await app.inject(await ownerSigned('GET', '/v1/tasks?state=needs-approval'));
      const item = (res.json().items as { payload: unknown; payload_hash: string }[])[0];
      expect(item?.payload).toEqual({ to: 'recruiter@example.com' });
      expect(item?.payload_hash).toBe(payloadHash({ to: 'recruiter@example.com' }));
    });

    it('REFUSES an agent signature — this is owner-only', async () => {
      gated('tsk_a');
      const res = await app.inject(await signed('GET', '/v1/tasks?state=needs-approval'));
      expect(res.statusCode).toBe(401);
    });

    it('REFUSES an unsigned request', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/tasks?state=needs-approval',
        headers: { 'x-agentbridge-workspace': 'ws' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('NEVER returns another workspace, even when the header says so', async () => {
      gated('tsk_a');
      const res = await app.inject(
        await ownerSigned('GET', '/v1/tasks?state=needs-approval', undefined, {
          workspace: 'ws_other',
        }),
      );
      expect(res.json().items).toEqual([]);
    });
  });

  describe('POST /v1/approvals', () => {
    async function decision(task: string, payload: unknown, decisionKind = 'approve') {
      const issued_at = deps.clock.now().toISOString();
      const sig = await signDescriptor(
        canonicalize({
          task,
          decision: decisionKind,
          payload_hash: payloadHash(payload),
          issued_at,
        }),
        ownerPriv,
      );
      return { task, decision: decisionKind, payload_hash: payloadHash(payload), issued_at, sig };
    }

    it('accepts an owner-signed request with NO agent identity at all', async () => {
      gated('tsk_a');
      const body = await decision('tsk_a', { to: 'a@b.com' });
      const res = await app.inject(await ownerSigned('POST', '/v1/approvals', body));
      expect(res.statusCode).toBe(200);
      expect(deps.store.getTask('ws', 'tsk_a')?.state).toBe('submitted');
    });

    it('REFUSES an agent-signed approval, so an agent cannot clear its own gate', async () => {
      gated('tsk_a');
      const body = await decision('tsk_a', { to: 'a@b.com' });
      const res = await app.inject(await signed('POST', '/v1/approvals', body));
      expect(res.statusCode).toBe(401);
      expect(deps.store.getTask('ws', 'tsk_a')?.state).toBe('needs-approval');
    });

    it('REFUSES a request signed by a key that is not the owner key', async () => {
      gated('tsk_a');
      const body = await decision('tsk_a', { to: 'a@b.com' });
      const res = await app.inject(
        await ownerSigned('POST', '/v1/approvals', body, {
          signWith: ed.utils.randomPrivateKey(),
        }),
      );
      expect(res.statusCode).toBe(401);
      expect(deps.store.getTask('ws', 'tsk_a')?.state).toBe('needs-approval');
    });

    describe('the kill switch', () => {
      it('revokes on an owner-signed request', async () => {
        const res = await app.inject(await ownerSigned('DELETE', '/v1/agents/agent%3Amuse/key'));
        expect(res.statusCode).toBe(200);
        expect(deps.store.getAgent('ws', 'agent:muse')?.keyStatus).toBe('revoked');
      });

      it('REFUSES an agent-signed revoke — one agent must not kill another', async () => {
        // Before ADR 0006 this route was `requireAgent` with no scope check, so
        // any agent holding read+message could revoke every other agent in the
        // workspace. Least privilege (CLAUDE.md §1.8) says it could not.
        const res = await app.inject(await signed('DELETE', '/v1/agents/agent%3Amuse/key'));
        expect(res.statusCode).toBe(401);
        expect(deps.store.getAgent('ws', 'agent:muse')?.keyStatus).toBe('active');
      });

      it('REFUSES a revoke signed by a key that is not the owner key', async () => {
        const res = await app.inject(
          await ownerSigned('DELETE', '/v1/agents/agent%3Amuse/key', undefined, {
            signWith: ed.utils.randomPrivateKey(),
          }),
        );
        expect(res.statusCode).toBe(401);
        expect(deps.store.getAgent('ws', 'agent:muse')?.keyStatus).toBe('active');
      });

      it('binds the AGENT REF, so a signature cannot be retargeted at another agent', async () => {
        // The ref is in the path, which the descriptor covers. Swapping it after
        // signing must not revoke a different agent.
        const forMuse = await ownerSigned('DELETE', '/v1/agents/agent%3Amuse/key');
        const res = await app.inject({ ...forMuse, url: '/v1/agents/agent%3Aclaude/key' });
        expect(res.statusCode).toBe(401);
        expect(deps.store.getAgent('ws', 'agent:claude')?.keyStatus).toBe('active');
        expect(deps.store.getAgent('ws', 'agent:muse')?.keyStatus).toBe('active');
      });

      it('404s on an unknown agent rather than reporting success', async () => {
        const res = await app.inject(await ownerSigned('DELETE', '/v1/agents/agent%3Aghost/key'));
        expect(res.statusCode).toBe(404);
      });
    });

    describe('GET /v1/agents', () => {
      it('lists the workspace roster with key status, for an owner-signed request', async () => {
        const res = await app.inject(await ownerSigned('GET', '/v1/agents'));
        expect(res.statusCode).toBe(200);
        const items = res.json().items as { ref: string; key_status: string }[];
        expect(items.map((a) => a.ref).sort()).toEqual(['agent:claude', 'agent:muse']);
        expect(items.every((a) => a.key_status === 'active')).toBe(true);
      });

      it('reflects a revoked key, so the console can show what it did', async () => {
        await app.inject(await ownerSigned('DELETE', '/v1/agents/agent%3Amuse/key'));
        const res = await app.inject(await ownerSigned('GET', '/v1/agents'));
        const muse = (res.json().items as { ref: string; key_status: string }[]).find(
          (a) => a.ref === 'agent:muse',
        );
        expect(muse?.key_status).toBe('revoked');
      });

      it('NEVER returns a public key, which the roster has no need for', async () => {
        const res = await app.inject(await ownerSigned('GET', '/v1/agents'));
        expect(res.body).not.toMatch(/public_key|publicKey|webhook_secret|webhookSecret/);
      });

      it('REFUSES an agent signature — the roster is for the owner', async () => {
        expect((await app.inject(await signed('GET', '/v1/agents'))).statusCode).toBe(401);
      });

      it('does not leak another workspace', async () => {
        const res = await app.inject(
          await ownerSigned('GET', '/v1/agents', undefined, { workspace: 'ws_other' }),
        );
        expect(res.json().items).toEqual([]);
      });
    });

    it('still enforces the payload-hash binding under the new auth', async () => {
      gated('tsk_a', { to: 'a@b.com' });
      // Signed for a different payload than the task actually holds.
      const body = await decision('tsk_a', { to: 'attacker@evil.com' });
      const res = await app.inject(await ownerSigned('POST', '/v1/approvals', body));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('approval_hash_mismatch');
      expect(deps.store.getTask('ws', 'tsk_a')?.state).toBe('needs-approval');
    });
  });
});
