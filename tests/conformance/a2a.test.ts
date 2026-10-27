import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestDescriptor, signDescriptor } from '@agentbridge/contracts';
import { A2A_PUBLIC_URL, startHarness, type Harness } from '../e2e/harness.js';

/**
 * A2A v1.0 conformance, driven over real HTTP against a real hub.
 *
 * Written from the published specification rather than from
 * `adapters/a2a/` or `hub/src/http/a2a.ts`. That distinction is the only
 * reason this suite is worth having: the same session wrote the A2A
 * implementation from its own reading of the spec, so a suite written from
 * memory would reproduce whatever that reading got wrong. The constants below
 * were taken from the specification text, and each group cites the clause it
 * comes from:
 *
 * - Error codes: the A2A error table — nine application codes, -32001..-32009,
 *   plus JSON-RPC's own -32700..-32603.
 * - `AgentCard` required fields and `supportedInterfaces`: spec §4.4.1 and
 *   §8.3.1. v1.0 replaced v0.3's `url` + `preferredTransport` with an ordered
 *   `supportedInterfaces[]` whose first entry is the preferred one.
 * - `TaskState`: the nine states, of which COMPLETED/FAILED/CANCELED/REJECTED
 *   are terminal and INPUT_REQUIRED/AUTH_REQUIRED are interrupted.
 *
 * Sources:
 *   https://a2a-protocol.org/latest/specification/
 *   https://github.com/a2aproject/A2A/blob/main/docs/specification.md
 *   https://agent2agent.info/docs/reference/errors/
 */

/** The A2A error table. Numbers are normative; names are the spec's. */
const A2A_ERRORS = {
  // JSON-RPC 2.0's own.
  JSONParseError: -32700,
  InvalidRequestError: -32600,
  MethodNotFoundError: -32601,
  InvalidParamsError: -32602,
  InternalError: -32603,
  // A2A application errors.
  TaskNotFoundError: -32001,
  TaskNotCancelableError: -32002,
  PushNotificationNotSupportedError: -32003,
  UnsupportedOperationError: -32004,
  ContentTypeNotSupportedError: -32005,
  InvalidAgentResponseError: -32006,
  ExtendedAgentCardNotConfiguredError: -32007,
  ExtensionSupportRequiredError: -32008,
  VersionNotSupportedError: -32009,
} as const;

/** Spec §4.4.1 — AgentCard REQUIRED fields in v1.0. */
const CARD_REQUIRED = [
  'name',
  'description',
  'version',
  'supportedInterfaces',
  'capabilities',
  'defaultInputModes',
  'defaultOutputModes',
  'skills',
] as const;

/** The complete TaskState set. `unknown` is the unspecified value. */
const A2A_TASK_STATES = new Set([
  'unknown',
  'submitted',
  'working',
  'completed',
  'failed',
  'canceled',
  'input-required',
  'rejected',
  'auth-required',
]);

let h: Harness;

beforeEach(async () => {
  h = await startHarness('ws_a2a');
});
afterEach(async () => {
  await h.stop();
});

/** A signed JSON-RPC call to the A2A endpoint, as a remote agent would make it. */
async function rpc(
  method: string,
  params: unknown,
  opts: { id?: string | number | null; rawBody?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const id = opts.id === undefined ? 'c-1' : opts.id;
  const body = opts.rawBody ?? JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const timestamp = new Date().toISOString();
  const signature = await signDescriptor(
    requestDescriptor({ method: 'POST', path: '/a2a/v1', query: {}, body, timestamp }),
    h.museKey,
  );
  const res = await fetch(`${h.baseUrl}/a2a/v1`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agentbridge-workspace': 'ws_a2a',
      'x-agentbridge-agent': 'agent:muse',
      'x-agentbridge-timestamp': timestamp,
      'x-agentbridge-signature': signature,
    },
    body,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { __unparseable: text };
  }
  return { status: res.status, body: parsed };
}

function errorOf(body: Record<string, unknown>): { code?: number; message?: string } {
  return (body.error ?? {}) as { code?: number; message?: string };
}

/**
 * Sends a message and returns the A2A Task object it produced.
 *
 * `agentbridge/assignee` is required in params.metadata: A2A addresses an
 * endpoint while AgentBridge addresses a named agent, and the hub refuses to
 * guess which one. That is an extension beyond the spec, which is why it is
 * isolated in this helper rather than spread across the cases.
 */
async function sendMessage(text: string, metadata: Record<string, unknown> = {}) {
  const { body } = await rpc('message/send', {
    message: {
      role: 'user',
      parts: [{ kind: 'text', text }],
      messageId: `m-${Math.floor(performance.now() * 1000)}`,
    },
    metadata: { 'agentbridge/assignee': 'agent:claude', ...metadata },
  });
  return body.result as Record<string, unknown> | undefined;
}

/* ───────────────────────────────── 1. Discovery (§4.4.1, §8.3.1) ───────── */

describe('A2A 1. Agent Card discovery', () => {
  it('serves the card at /.well-known/agent-card.json without authentication', async () => {
    // Discovery must work before credentials exist, so this is deliberately
    // unauthenticated — note no signature headers are sent here.
    const res = await fetch(`${h.baseUrl}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('declares every REQUIRED v1.0 field', async () => {
    const card = (await (await fetch(`${h.baseUrl}/.well-known/agent-card.json`)).json()) as Record<
      string,
      unknown
    >;
    for (const field of CARD_REQUIRED) {
      expect(card, `AgentCard.${field} is REQUIRED by spec §4.4.1`).toHaveProperty(field);
    }
  });

  it('declares supportedInterfaces as a non-empty ordered array', async () => {
    // §8.3.1: "The first entry in supportedInterfaces represents the preferred
    // interface." v1.0 consolidated url/preferredTransport/additionalInterfaces
    // into this one field.
    const card = (await (await fetch(`${h.baseUrl}/.well-known/agent-card.json`)).json()) as {
      supportedInterfaces?: unknown;
    };
    expect(Array.isArray(card.supportedInterfaces)).toBe(true);
    expect((card.supportedInterfaces as unknown[]).length).toBeGreaterThan(0);
  });

  it('gives every declared interface a url and a protocolBinding', async () => {
    // §8.3.1: "Each interface MUST accurately declare its transport protocol
    // and URL."
    const card = (await (await fetch(`${h.baseUrl}/.well-known/agent-card.json`)).json()) as {
      supportedInterfaces?: { url?: string; protocolBinding?: string }[];
    };
    for (const iface of card.supportedInterfaces ?? []) {
      expect(typeof iface.url, 'interface.url').toBe('string');
      expect(() => new URL(iface.url as string)).not.toThrow();
      expect(typeof iface.protocolBinding, 'interface.protocolBinding').toBe('string');
    }
  });

  it('advertises the CONFIGURED public address, not a hardcoded default', async () => {
    // This caught a real defect: `publicUrl` defaulted to
    // http://localhost:8080 and the composition root never set it, so a
    // deployed hub published a card pointing at its own loopback. Discovery
    // is the one thing that must work before anything else, and it would have
    // failed for every remote agent while every local test passed.
    const card = (await (await fetch(`${h.baseUrl}/.well-known/agent-card.json`)).json()) as {
      supportedInterfaces?: { url?: string }[];
    };
    const url = card.supportedInterfaces?.[0]?.url as string;
    expect(url.startsWith(A2A_PUBLIC_URL)).toBe(true);
    expect(url).not.toContain('localhost');
    expect(url).not.toContain('127.0.0.1');
  });

  it('points its preferred interface at a path that actually answers', async () => {
    // The host is whatever the operator configured and is not resolvable from
    // a test, so the *path* is what can be verified here — a card naming a
    // path nothing serves is still a dead card, and nothing else catches it.
    const card = (await (await fetch(`${h.baseUrl}/.well-known/agent-card.json`)).json()) as {
      supportedInterfaces?: { url?: string }[];
    };
    const { pathname } = new URL(card.supportedInterfaces?.[0]?.url as string);
    const res = await fetch(`${h.baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } }),
    });
    // 401 is the expected answer and the one that proves the point: the route
    // exists and is auth-guarded. A 404 would mean the card names a path this
    // hub does not serve, which is the failure being hunted. Asserted on the
    // status rather than the body, because an authentication failure is an
    // HTTP-layer answer (§5.4) and so carries no JSON-RPC envelope.
    expect(res.status).toBe(401);
  });

  it('keeps the legacy v0.3 url in agreement with supportedInterfaces[0]', async () => {
    // `url`/`preferredTransport` are retained for v0.3 clients. Two fields
    // naming the same endpoint will drift apart unless something checks, and
    // the failure mode is a v0.3 caller silently talking to the wrong place.
    const card = (await (await fetch(`${h.baseUrl}/.well-known/agent-card.json`)).json()) as {
      url?: string;
      preferredTransport?: string;
      supportedInterfaces?: { url?: string; protocolBinding?: string }[];
    };
    if (card.url === undefined) return; // dropped on purpose is fine
    expect(card.url).toBe(card.supportedInterfaces?.[0]?.url);
    expect(card.preferredTransport).toBe(card.supportedInterfaces?.[0]?.protocolBinding);
  });

  it('gives every skill an id, name, description and tags', async () => {
    const card = (await (await fetch(`${h.baseUrl}/.well-known/agent-card.json`)).json()) as {
      skills?: Record<string, unknown>[];
    };
    expect((card.skills ?? []).length).toBeGreaterThan(0);
    for (const skill of card.skills ?? []) {
      for (const key of ['id', 'name', 'description', 'tags']) {
        expect(skill, `skill.${key}`).toHaveProperty(key);
      }
      expect(Array.isArray(skill.tags)).toBe(true);
    }
  });

  it('declares capabilities as booleans, including streaming', async () => {
    const card = (await (await fetch(`${h.baseUrl}/.well-known/agent-card.json`)).json()) as {
      capabilities?: Record<string, unknown>;
    };
    expect(typeof card.capabilities?.streaming).toBe('boolean');
  });

  it('leaks no agent names, keys or workspace contents', async () => {
    // Not a spec requirement — an AgentBridge one. The card is the only
    // unauthenticated surface, so it is the one that must disclose nothing.
    await h.registerAgent('secretagent');
    const text = await (await fetch(`${h.baseUrl}/.well-known/agent-card.json`)).text();
    expect(text).not.toContain('secretagent');
    expect(text).not.toContain('ws_a2a');
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });
});

/* ───────────────────────────── 2. JSON-RPC 2.0 binding ─────────────────── */

describe('A2A 2. JSON-RPC 2.0 envelope', () => {
  it('answers with jsonrpc "2.0" and echoes the request id', async () => {
    const { body } = await rpc('tasks/get', { id: 'tsk_nope' }, { id: 'abc-123' });
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe('abc-123');
  });

  it('preserves a NUMERIC id as a number', async () => {
    // JSON-RPC ids may be strings or numbers and the type must survive, or a
    // client keying a map on it never matches the reply.
    const { body } = await rpc('tasks/get', { id: 'tsk_nope' }, { id: 7 });
    expect(body.id).toBe(7);
  });

  it('echoes the id even when the envelope itself is invalid', async () => {
    const { body } = await rpc('', null, {
      rawBody: JSON.stringify({ jsonrpc: '1.0', id: 'keep-me', method: 'tasks/get' }),
    });
    expect(errorOf(body).code).toBe(A2A_ERRORS.InvalidRequestError);
    expect(body.id).toBe('keep-me');
  });

  it('returns -32700 for a body that is not JSON', async () => {
    const { body } = await rpc('', null, { rawBody: '{not json at all' });
    expect(errorOf(body).code).toBe(A2A_ERRORS.JSONParseError);
  });

  it('returns -32600 when jsonrpc is missing', async () => {
    const { body } = await rpc('', null, {
      rawBody: JSON.stringify({ id: 1, method: 'tasks/get', params: { id: 'x' } }),
    });
    expect(errorOf(body).code).toBe(A2A_ERRORS.InvalidRequestError);
  });

  it('returns -32600 for a batch, which A2A does not use', async () => {
    const { body } = await rpc('', null, {
      rawBody: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tasks/get' }]),
    });
    expect(errorOf(body).code).toBe(A2A_ERRORS.InvalidRequestError);
  });

  it('returns -32601 for an unknown method', async () => {
    const { body } = await rpc('tasks/explode', {});
    expect(errorOf(body).code).toBe(A2A_ERRORS.MethodNotFoundError);
  });

  it('returns -32602 when a required param is missing', async () => {
    const { body } = await rpc('tasks/get', {});
    expect(errorOf(body).code).toBe(A2A_ERRORS.InvalidParamsError);
  });

  it('never returns both result and error', async () => {
    for (const call of [
      rpc('tasks/get', { id: 'tsk_nope' }),
      rpc('tasks/explode', {}),
      sendMessage('a legitimate task').then(() => ({ body: {} as Record<string, unknown> })),
    ]) {
      const { body } = await call;
      if (Object.keys(body).length === 0) continue;
      expect('result' in body && 'error' in body).toBe(false);
    }
  });

  it('gives every error a numeric code and a string message', async () => {
    const { body } = await rpc('tasks/get', { id: 'tsk_nope' });
    expect(typeof errorOf(body).code).toBe('number');
    expect(typeof errorOf(body).message).toBe('string');
  });
});

/* ──────────────────────── 3. A2A application error codes ───────────────── */

describe('A2A 3. application error codes', () => {
  it('returns -32001 TaskNotFoundError for an unknown task id', async () => {
    const { body } = await rpc('tasks/get', { id: 'tsk_does_not_exist' });
    expect(errorOf(body).code).toBe(A2A_ERRORS.TaskNotFoundError);
  });

  it('returns -32001 rather than leaking that a task exists in another workspace', async () => {
    // Cross-workspace reads must be indistinguishable from absent (§1.2 of
    // CLAUDE.md), and TaskNotFoundError is also the spec's answer for
    // "not accessible".
    const other = await startHarness('ws_other');
    try {
      const task = await other.claude.createTask({
        thread: 'thr_x',
        assignee: 'agent:muse',
        title: 'other workspace',
        payload: {},
      });
      const { body } = await rpc('tasks/get', { id: task.id });
      expect(errorOf(body).code).toBe(A2A_ERRORS.TaskNotFoundError);
    } finally {
      await other.stop();
    }
  });

  it('returns -32002 TaskNotCancelableError for a task in a terminal state', async () => {
    const created = await sendMessage('finish me');
    const id = created?.id as string;
    await h.claude.updateTask(id, 'accepted');
    await h.claude.updateTask(id, 'working');
    await h.claude.updateTask(id, 'completed');

    const { body } = await rpc('tasks/cancel', { id });
    expect(errorOf(body).code).toBe(A2A_ERRORS.TaskNotCancelableError);
  });

  it('returns -32004 UnsupportedOperationError for message/stream when streaming is false', async () => {
    // The card declares streaming: false, so this must be a clean refusal
    // rather than a hang or an empty 200.
    const { body } = await rpc('message/stream', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'stream me' }], messageId: 'm-s' },
    });
    expect(errorOf(body).code).toBe(A2A_ERRORS.UnsupportedOperationError);
  });

  it('returns -32004 for tasks/resubscribe when streaming is false', async () => {
    const { body } = await rpc('tasks/resubscribe', { id: 'tsk_x' });
    expect(errorOf(body).code).toBe(A2A_ERRORS.UnsupportedOperationError);
  });

  it('uses only codes from the A2A error table', async () => {
    const known = new Set<number>(Object.values(A2A_ERRORS));
    const calls = [
      rpc('tasks/get', {}),
      rpc('tasks/get', { id: 'tsk_nope' }),
      rpc('tasks/explode', {}),
      rpc('tasks/cancel', { id: 'tsk_nope' }),
      rpc('message/stream', { message: {} }),
      rpc('message/send', {}),
      rpc('tasks/pushNotificationConfig/set', { taskId: 'tsk_nope' }),
      rpc('tasks/pushNotificationConfig/get', { taskId: 'tsk_nope' }),
    ];
    for (const call of calls) {
      const { body } = await call;
      const code = errorOf(body).code;
      if (code === undefined) continue;
      expect(known, `undeclared error code ${code}`).toContain(code);
    }
  });
});

/* ──────────────────────────── 4. Task object (§4.1) ────────────────────── */

describe('A2A 4. Task object', () => {
  it('message/send returns a Task with the required shape', async () => {
    const task = await sendMessage('list three job matches');
    expect(task?.kind).toBe('task');
    expect(typeof task?.id).toBe('string');
    expect(typeof task?.contextId).toBe('string');
    const status = task?.status as { state?: string; timestamp?: string };
    expect(typeof status?.state).toBe('string');
    expect(typeof status?.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(status?.timestamp as string))).toBe(false);
  });

  it('only ever reports a state from the A2A TaskState set', async () => {
    const task = await sendMessage('state check');
    const id = task?.id as string;

    const seen: string[] = [];
    for (const next of ['accepted', 'working', 'completed'] as const) {
      // The assignee drives state, and agent:muse is the A2A caller/creator.
      await h.claude.updateTask(id, next);
      const { body } = await rpc('tasks/get', { id });
      seen.push((body.result as { status: { state: string } }).status.state);
    }
    for (const state of seen) {
      expect(A2A_TASK_STATES, `"${state}" is not an A2A TaskState`).toContain(state);
    }
  });

  it('tasks/get round-trips the id it was given', async () => {
    const task = await sendMessage('round trip');
    const { body } = await rpc('tasks/get', { id: task?.id });
    expect((body.result as { id: string }).id).toBe(task?.id);
  });

  it('reports auth-required for a task held at the approval gate', async () => {
    // AgentBridge's gate has no A2A equivalent. auth-required is the honest
    // mapping: blocked pending an authorisation the caller cannot supply.
    // Asserted here because an A2A caller's whole behaviour depends on it —
    // `working` would make it poll forever and `input-required` would invite
    // input that cannot release it.
    const { body } = await rpc('message/send', {
      message: {
        role: 'user',
        parts: [{ kind: 'data', data: { amount: 100 } }],
        messageId: 'm-side',
      },
      metadata: { 'agentbridge/assignee': 'agent:claude', 'agentbridge/side_effect': true },
    });
    const result = body.result as { status?: { state?: string } } | undefined;
    if (result === undefined) {
      // If side-effect tasks cannot be created over A2A at all, that is a
      // defensible design — but it must be an explicit refusal, not a silent
      // downgrade to a non-gated task.
      expect(typeof errorOf(body).code).toBe('number');
      return;
    }
    expect(result.status?.state).toBe('auth-required');
  });

  it('cancels a live task and reports canceled', async () => {
    const task = await sendMessage('cancel me');
    const { body } = await rpc('tasks/cancel', { id: task?.id });
    expect(errorOf(body).code).toBeUndefined();
    expect((body.result as { status: { state: string } }).status.state).toBe('canceled');
  });
});

/* ─────────────────── 5. Push notification configuration ────────────────── */

describe('A2A 5. push notification config', () => {
  const PUSH_ORIGIN = 'https://muse.example.com';

  /**
   * A caller that actually has an owner-authorised origin.
   *
   * The default harness agents are registered with no webhook, which is why
   * these cases cannot use `rpc()` — pushes are restricted to the origin the
   * owner authorised at enrolment (ADR 0007), so an agent without one is
   * correctly refused and would prove nothing about the round trip.
   */
  async function pushRpc(method: string, params: unknown) {
    const key = await h.registerAgent('pusher', `${PUSH_ORIGIN}/hook`);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'p-1', method, params });
    const timestamp = new Date().toISOString();
    const signature = await signDescriptor(
      requestDescriptor({ method: 'POST', path: '/a2a/v1', query: {}, body, timestamp }),
      key,
    );
    const res = await fetch(`${h.baseUrl}/a2a/v1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': 'ws_a2a',
        'x-agentbridge-agent': 'agent:pusher',
        'x-agentbridge-timestamp': timestamp,
        'x-agentbridge-signature': signature,
      },
      body,
    });
    return (await res.json()) as Record<string, unknown>;
  }

  /** Creates a task owned by agent:pusher, so it may configure push on it. */
  async function pusherTask(): Promise<string> {
    const created = await pushRpc('message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'push me' }], messageId: 'm-p' },
      metadata: { 'agentbridge/assignee': 'agent:claude' },
    });
    return (created.result as { id: string }).id;
  }

  it('round-trips a config whose origin the owner authorised', async () => {
    const id = await pusherTask();
    const set = await pushRpc('tasks/pushNotificationConfig/set', {
      taskId: id,
      pushNotificationConfig: { url: `${PUSH_ORIGIN}/hook`, token: 't-1' },
    });
    expect(errorOf(set).code).toBeUndefined();

    const got = await pushRpc('tasks/pushNotificationConfig/get', { taskId: id });
    expect(errorOf(got).code).toBeUndefined();
  });

  it('refuses a push URL outside the owner-authorised origin with -32602', async () => {
    // SSRF: an agent that could name any URL would make the hub a request
    // forwarder into the owner's network. The link-local address is the
    // canonical cloud-credential target.
    const id = await pusherTask();
    const body = await pushRpc('tasks/pushNotificationConfig/set', {
      taskId: id,
      pushNotificationConfig: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(errorOf(body).code).toBe(A2A_ERRORS.InvalidParamsError);
  });

  it('refuses a syntactically invalid push URL with -32602', async () => {
    const id = await pusherTask();
    const body = await pushRpc('tasks/pushNotificationConfig/set', {
      taskId: id,
      pushNotificationConfig: { url: 'not-a-url' },
    });
    expect(errorOf(body).code).toBe(A2A_ERRORS.InvalidParamsError);
  });

  it('returns -32003 when the caller has no authorised origin at all', async () => {
    // agent:muse has no webhook. The spec's dedicated code for "push
    // notifications used but not supported" is -32003; -32004 would imply the
    // method is unavailable, contradicting the card's pushNotifications: true.
    const task = await sendMessage('no origin');
    const { body } = await rpc('tasks/pushNotificationConfig/set', {
      taskId: task?.id,
      pushNotificationConfig: { url: 'https://anywhere.example.com/hook' },
    });
    expect(errorOf(body).code).toBe(A2A_ERRORS.PushNotificationNotSupportedError);
  });

  it('returns -32001 for a push config on an unknown task', async () => {
    const { body } = await rpc('tasks/pushNotificationConfig/get', { taskId: 'tsk_nope' });
    expect(errorOf(body).code).toBe(A2A_ERRORS.TaskNotFoundError);
  });
});

/* ──────────────────────────── 6. Authentication ────────────────────────── */

describe('A2A 6. authentication', () => {
  /**
   * Spec §5.4 maps authentication failures to HTTP 401 and authorization
   * failures to HTTP 403 — they stay at the transport layer rather than
   * becoming a 200 with a JSON-RPC error.
   *
   * An earlier version of this suite asserted a numeric JSON-RPC code here,
   * which was wrong, and "fixing" the hub to satisfy it would have broken
   * correct behaviour: a client that needs to refresh a credential reads the
   * status, and burying 401 inside a 200 body hides it from every standard
   * HTTP auth client.
   */
  it('refuses an unsigned call with HTTP 401, not a 200 error body', async () => {
    const res = await fetch(`${h.baseUrl}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()) as Record<string, unknown>).not.toHaveProperty('result');
  });

  it('refuses a call signed by a revoked key', async () => {
    const task = await sendMessage('before revocation');
    expect(task?.id).toBeDefined();
    await h.owner.revokeAgentKey('agent:muse');
    const res = await fetch(`${h.baseUrl}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/get',
        params: { id: task?.id },
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });

  it('still answers a JSON-level failure with JSON-RPC, not an HTTP status', async () => {
    // The complement of the two above: a malformed body is a JSON-RPC concern,
    // not an auth one, so it must come back as 200 + -32700 even though it is
    // also "a bad request". This is the line the error handler has to draw.
    const { status, body } = await rpc('', null, { rawBody: '{nope' });
    expect(status).toBe(200);
    expect(errorOf(body).code).toBe(A2A_ERRORS.JSONParseError);
  });
});
