import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, type Fakes } from '@agentbridge/hub/ports/fakes';
import { pushOnce, signWebhook } from './push.js';
import { makeWorker } from './worker.js';

let deps: Fakes;
let server: Server;
let url: string;
let received: { headers: Record<string, string | undefined>; body: string }[];
let respond: (n: number) => number;
let hang = false;

beforeEach(async () => {
  deps = makeFakes();
  received = [];
  respond = () => 200;
  hang = false;

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        headers: req.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (hang) return; // never responds; the push must time out
      res.writeHead(respond(received.length)).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

  deps.store.putAgent({
    ref: 'agent:muse',
    workspace: 'ws',
    name: 'muse',
    publicKey: 'AAAA',
    webhookUrl: url,
    webhookSecret: 'shh',
    scopes: ['read', 'message'],
    keyStatus: 'active',
    capabilities: {},
    createdAt: '2026-10-20T00:00:00.000Z',
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function enqueue(body: unknown = { text: 'hello' }) {
  deps.store.putMessage({
    id: 'msg_1',
    workspace: 'ws',
    thread: 'thr_1',
    from: 'agent:claude',
    to: ['agent:muse'],
    type: 'task.create',
    task: 'tsk_1',
    body,
    sideEffect: false,
    traceId: '0'.repeat(32),
    sig: '',
    createdAt: '2026-10-20T12:00:00.000Z',
  });
  const row = {
    id: 'ob_1',
    workspace: 'ws',
    thread: 'thr_1',
    recipient: 'agent:muse',
    messageId: 'msg_1',
    attempts: 0,
    nextAttemptAt: '2026-10-20T12:00:00.000Z',
    state: 'pending' as const,
    ackedAt: null,
    createdAt: '2026-10-20T12:00:00.000Z',
  };
  deps.store.putOutbox(row);
  return row;
}

describe('pushOnce', () => {
  it('POSTs to the webhook and returns acked on 2xx', async () => {
    expect(await pushOnce(deps, enqueue())).toBe('acked');
    expect(received).toHaveLength(1);
  });

  it('signs the body with HMAC-SHA256 over timestamp + "." + rawBody', async () => {
    await pushOnce(deps, enqueue());
    const got = received[0];
    expect(got).toBeDefined();
    const ts = got?.headers['x-agentbridge-timestamp'];
    expect(ts).toBeDefined();
    expect(got?.headers['x-agentbridge-signature']).toBe(
      signWebhook('shh', ts as string, got?.body ?? ''),
    );
  });

  it('never sends the webhook secret itself', async () => {
    await pushOnce(deps, enqueue());
    expect(JSON.stringify(received[0])).not.toContain('shh');
  });

  it('wraps the body as untrusted with provenance', async () => {
    await pushOnce(deps, enqueue());
    const parsed = JSON.parse(received[0]?.body ?? '{}') as {
      body: { untrusted: boolean; provenance: { from: string }; value: unknown };
    };
    expect(parsed.body.untrusted).toBe(true);
    expect(parsed.body.provenance.from).toBe('agent:claude');
    expect(parsed.body.value).toEqual({ text: 'hello' });
  });

  it('redacts a card number before it leaves the hub', async () => {
    await pushOnce(deps, enqueue({ note: 'card 4242424242424242' }));
    expect(received[0]?.body).toContain('[REDACTED]');
    expect(received[0]?.body).not.toContain('4242424242424242');
  });

  it('returns retry on a 500', async () => {
    respond = () => 500;
    expect(await pushOnce(deps, enqueue())).toBe('retry');
  });

  it('returns retry on a 404, which may be a deploy in progress', async () => {
    respond = () => 404;
    expect(await pushOnce(deps, enqueue())).toBe('retry');
  });

  it('returns dead on a 410 Gone, which will never succeed', async () => {
    respond = () => 410;
    expect(await pushOnce(deps, enqueue())).toBe('dead');
  });

  it('returns retry on a timeout rather than hanging', async () => {
    hang = true;
    expect(await pushOnce({ ...deps, timeoutMs: 150 }, enqueue())).toBe('retry');
  });

  it('returns dead for a revoked agent without making a request', async () => {
    deps.store.setKeyStatus('ws', 'agent:muse', 'revoked');
    expect(await pushOnce(deps, enqueue())).toBe('dead');
    expect(received).toHaveLength(0);
  });

  it('returns dead for an agent with no webhook url', async () => {
    deps.store.putAgent({
      ...(deps.store.getAgent('ws', 'agent:muse') as NonNullable<
        ReturnType<typeof deps.store.getAgent>
      >),
      webhookUrl: null,
      webhookSecret: null,
    });
    expect(await pushOnce(deps, enqueue())).toBe('dead');
  });
});

describe('worker', () => {
  it('delivers a pending row and marks it delivered', async () => {
    enqueue();
    const worker = makeWorker(deps);
    expect(await worker.tick()).toBe(1);
    expect(deps.store.getOutbox('ob_1')?.state).toBe('delivered');
    worker.stop();
  });

  it('schedules a retry with a future attempt time on failure', async () => {
    respond = () => 500;
    enqueue();
    const worker = makeWorker(deps);
    await worker.tick();
    const row = deps.store.getOutbox('ob_1');
    expect(row?.state).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).not.toBe('2026-10-20T12:00:00.000Z');
    worker.stop();
  });

  it('dead-letters a permanently gone endpoint and surfaces it in the DLQ', async () => {
    respond = () => 410;
    enqueue();
    const worker = makeWorker(deps);
    await worker.tick();
    expect(deps.store.getOutbox('ob_1')?.state).toBe('dead');
    expect(deps.store.listDead('ws').map((r) => r.id)).toEqual(['ob_1']);
    worker.stop();
  });

  it('does not deliver the same row twice in one tick', async () => {
    enqueue();
    const worker = makeWorker(deps);
    await worker.tick();
    expect(received).toHaveLength(1);
    worker.stop();
  });
});

describe('A2A push notifications', () => {
  function configurePush(token: string | null = 'tok') {
    deps.store.putTask({
      id: 'tsk_1',
      workspace: 'ws',
      thread: 'thr_1',
      creator: 'agent:muse',
      assignee: 'agent:claude',
      title: 'a2a task',
      payload: { secret: 'do-not-ship-this' },
      payloadHash: 'f'.repeat(64),
      state: 'working',
      sideEffect: false,
      dueAt: null,
      createdAt: '2026-10-20T12:00:00.000Z',
      updatedAt: '2026-10-20T12:30:00.000Z',
    });
    deps.store.putPushConfig({
      workspace: 'ws',
      task: 'tsk_1',
      agentRef: 'agent:muse',
      url: `${url.replace('/hook', '')}/a2a/callback`,
      token,
      createdAt: '2026-10-20T12:00:00.000Z',
    });
  }

  it('sends the A2A task shape to the configured url', async () => {
    configurePush();
    expect(await pushOnce(deps, enqueue())).toBe('acked');
    const body = JSON.parse(received[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body.kind).toBe('task');
    expect(body.id).toBe('tsk_1');
    expect((body.status as { state: string }).state).toBe('working');
  });

  it('carries the caller token so the receiver can authenticate the callback', async () => {
    configurePush('s3cret-token');
    await pushOnce(deps, enqueue());
    expect(received[0]?.headers['x-a2a-notification-token']).toBe('s3cret-token');
  });

  it('still HMAC-signs the notification', async () => {
    // Same secret the agent already holds: the destination is its own origin.
    configurePush();
    await pushOnce(deps, enqueue());
    expect(received[0]?.headers['x-agentbridge-signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does NOT ship the task payload in the notification', async () => {
    // A state change is the notification; detail comes from tasks/get over an
    // authenticated channel. Shipping the payload would put it on a second
    // wire for no gain.
    configurePush();
    await pushOnce(deps, enqueue());
    expect(received[0]?.body).not.toContain('do-not-ship-this');
  });

  it('ignores a config belonging to a DIFFERENT agent', async () => {
    // The config is keyed by task; without the recipient check, one party's
    // push URL would receive the other party's notifications.
    configurePush();
    deps.store.putPushConfig({
      workspace: 'ws',
      task: 'tsk_1',
      agentRef: 'agent:someone-else',
      url: 'https://elsewhere.example/cb',
      token: null,
      createdAt: '2026-10-20T12:00:00.000Z',
    });
    expect(await pushOnce(deps, enqueue())).toBe('acked');
    // Delivered to the ordinary webhook, not to the other agent's URL.
    const body = JSON.parse(received[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body.kind).toBeUndefined();
  });

  it('falls back to the ordinary webhook when no push is configured', async () => {
    expect(await pushOnce(deps, enqueue())).toBe('acked');
    const body = JSON.parse(received[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body.kind).toBeUndefined();
    expect(body.body).toBeDefined();
  });
});
