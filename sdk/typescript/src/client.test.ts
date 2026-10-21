import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@agentbridge/hub/http';
import { makeFakes, type Fakes } from '@agentbridge/hub/ports/fakes';
import { Agent } from './agent.js';
import { Client } from './client.js';
import { generateKeyPair, publicKeyBase64 } from './keys.js';

let deps: Fakes;
let app: FastifyInstance;
let baseUrl: string;
let claude: Client;
let museAgent: Agent;
let dir: string;

async function registerAgent(name: string, webhookUrl?: string) {
  const { privateKey, publicKey } = await generateKeyPair();
  deps.store.putAgent({
    ref: `agent:${name}`,
    workspace: 'ws',
    name,
    publicKey: publicKeyBase64(publicKey),
    webhookUrl: webhookUrl ?? null,
    webhookSecret: webhookUrl === undefined ? null : 'shh',
    scopes: ['read', 'message', 'create_task', 'write_artifact', 'request_side_effect'],
    keyStatus: 'active',
    capabilities: {},
    createdAt: '2026-10-20T00:00:00.000Z',
  });
  return privateKey;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-sdk-'));
  deps = makeFakes();
  const clPriv = await registerAgent('claude');
  const musePriv = await registerAgent('muse');

  // A real clock, not the fake one: this suite drives the hub over HTTP with a
  // real-time SDK, and a fixed fake clock would put every request years outside
  // the replay window.
  app = await buildApp(
    {
      ...deps,
      clock: { now: () => new Date() },
      ownerPublicKey: new Uint8Array(32),
      registrationToken: 'test-registration-token',
    },
    { logger: false, rateLimitMax: 5000 },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const common = { baseUrl, workspace: 'ws' };
  claude = new Client({ ...common, agent: 'agent:claude', privateKey: clPriv });
  museAgent = new Agent({
    ...common,
    agent: 'agent:muse',
    privateKey: musePriv,
    cursorPath: join(dir, 'cursor.json'),
  });
});

afterEach(async () => {
  museAgent.stop();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Client', () => {
  it('signs every request, so the hub accepts it', async () => {
    const task = await claude.createTask({
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 'list matches',
      payload: { count: 3 },
    });
    expect(task.state).toBe('submitted');
  });

  it('generates an idempotency key so a retry is safe', async () => {
    const key = 'explicit-key';
    const a = await claude.createTask({
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 'once',
      payload: {},
      idempotencyKey: key,
    });
    const b = await claude.createTask({
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 'once',
      payload: {},
      idempotencyKey: key,
    });
    expect(b.id).toBe(a.id);
  });

  it('surfaces a hub error code as a typed AgentBridgeError', async () => {
    await expect(
      claude.createTask({
        thread: 'thr_1',
        assignee: 'agent:ghost',
        title: 't',
        payload: {},
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does NOT retry a 4xx', async () => {
    let calls = 0;
    const counting: typeof fetch = async (input, init) => {
      calls += 1;
      return fetch(input as string, init);
    };
    const c = new Client({
      baseUrl,
      workspace: 'ws',
      agent: 'agent:claude',
      privateKey: await generateKeyPair().then((k) => k.privateKey),
      fetch: counting,
    });
    await expect(c.listInbox()).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  it('never puts the private key in a request', async () => {
    const seen: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      seen.push(JSON.stringify({ url: String(input), init }));
      return fetch(input as string, init);
    };
    const priv = await registerAgent('spy');
    const c = new Client({
      baseUrl,
      workspace: 'ws',
      agent: 'agent:spy',
      privateKey: priv,
      fetch: spy,
    });
    await c.listInbox();
    const keyHex = Buffer.from(priv).toString('hex');
    const keyB64 = Buffer.from(priv).toString('base64');
    for (const entry of seen) {
      expect(entry).not.toContain(keyHex);
      expect(entry).not.toContain(keyB64);
    }
  });

  it('reads the inbox with an Untrusted body', async () => {
    await claude.send({ thread: 'thr_1', to: ['agent:muse'], body: { text: 'hi' } });
    const musePriv = await registerAgent('muse2');
    const muse = new Client({
      baseUrl,
      workspace: 'ws',
      agent: 'agent:muse2',
      privateKey: musePriv,
    });
    await claude.send({ thread: 'thr_2', to: ['agent:muse2'], body: { text: 'yo' } });
    const page = await muse.listInbox();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.body.unwrap()).toEqual({ text: 'yo' });
    expect(`${page.items[0]?.body}`).not.toContain('yo');
  });

  it('advances the cursor on ack so the next read is empty', async () => {
    const musePriv = await registerAgent('muse3');
    const muse = new Client({
      baseUrl,
      workspace: 'ws',
      agent: 'agent:muse3',
      privateKey: musePriv,
    });
    await claude.send({ thread: 'thr_3', to: ['agent:muse3'], body: { text: 'one' } });
    const first = await muse.listInbox();
    expect(first.items).toHaveLength(1);
    await muse.ack(first.cursor as string);
    expect((await muse.listInbox()).items).toHaveLength(0);
  });

  it('verifies the audit chain through the API', async () => {
    await claude.createTask({
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 't',
      payload: {},
    });
    expect((await claude.verifyAudit()).ok).toBe(true);
  });
});

describe('Agent', () => {
  it('invokes onTask for an inbox item and completes the task', async () => {
    const task = await claude.createTask({
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 'find jobs',
      payload: { count: 2 },
    });

    const seen: unknown[] = [];
    museAgent.onTask((delivery) => {
      seen.push(delivery.payload.unwrap());
      return { artifact: { name: 'matches.json', kind: 'json', inline: { hits: 2 } } };
    });

    expect(await museAgent.poll()).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    expect((await claude.getTask(task.id)).state).toBe('completed');
  });

  it('hands the handler an Untrusted payload, not a raw object', async () => {
    await claude.createTask({
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 't',
      payload: { secret: 'tell no one' },
    });
    let interpolated = '';
    museAgent.onTask((delivery) => {
      interpolated = `${delivery.payload}`;
    });
    await museAgent.poll();
    expect(interpolated).not.toContain('tell no one');
    expect(interpolated).toMatch(/Untrusted/);
  });

  it('does NOT ack when the handler throws, so the item is redelivered', async () => {
    await claude.createTask({
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 't',
      payload: {},
    });
    museAgent.onTask(() => {
      throw new Error('handler blew up');
    });
    await expect(museAgent.poll()).rejects.toThrow('handler blew up');

    // Still there on the next poll.
    let handled = 0;
    museAgent.onTask(() => {
      handled += 1;
    });
    await museAgent.poll();
    expect(handled).toBe(1);
  });

  it('resumes from the persisted cursor after a restart', async () => {
    await claude.createTask({
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 't',
      payload: {},
    });
    museAgent.onTask(() => undefined);
    await museAgent.poll();

    const restarted = new Agent({
      baseUrl,
      workspace: 'ws',
      agent: 'agent:muse',
      privateKey: await (async () => {
        const a = deps.store.getAgent('ws', 'agent:muse');
        expect(a).not.toBeNull();
        return (museAgent as unknown as { opts: { privateKey: Uint8Array } }).opts.privateKey;
      })(),
      cursorPath: join(dir, 'cursor.json'),
    });
    let handled = 0;
    restarted.onTask(() => {
      handled += 1;
    });
    await restarted.start();
    restarted.stop();
    expect(handled).toBe(0);
  });

  it('refuses to start without a handler', async () => {
    const bare = new Agent({
      baseUrl,
      workspace: 'ws',
      agent: 'agent:muse',
      privateKey: new Uint8Array(32),
    });
    await expect(bare.start()).rejects.toThrow(/onTask/);
  });

  it('processes items from one thread in order', async () => {
    const musePriv = await registerAgent('muse4');
    const ordered = new Agent({
      baseUrl,
      workspace: 'ws',
      agent: 'agent:muse4',
      privateKey: musePriv,
    });
    for (const n of [1, 2, 3]) {
      await claude.send({ thread: 'thr_order', to: ['agent:muse4'], body: { n } });
    }
    const seen: number[] = [];
    ordered.onTask((d) => {
      seen.push((d.payload.unwrap() as { n: number }).n);
    });
    await ordered.poll();
    ordered.stop();
    expect(seen).toEqual([1, 2, 3]);
  });
});
