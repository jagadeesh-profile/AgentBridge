import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@agentbridge/hub/http';
import { makeFakes, type Fakes } from '@agentbridge/hub/ports/fakes';
import { Agent } from './agent.js';
import * as ed from '@noble/ed25519';
import { Client } from './client.js';
import { OwnerClient } from './owner.js';
import { generateKeyPair, publicKeyBase64 } from './keys.js';

let deps: Fakes;
let app: FastifyInstance;
let baseUrl: string;
let claude: Client;
/** The options `claude` was built from, so a test can vary one of them. */
let claudeOpts: ConstructorParameters<typeof Client>[0];
let owner: OwnerClient;
let ownerPriv: Uint8Array;
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
      ownerPublicKey: await ed.getPublicKeyAsync((ownerPriv = ed.utils.randomPrivateKey())),
    },
    { logger: false, rateLimitMax: 5000 },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const common = { baseUrl, workspace: 'ws' };
  claudeOpts = { ...common, agent: 'agent:claude', privateKey: clPriv };
  claude = new Client(claudeOpts);
  owner = new OwnerClient({ ...common, privateKey: ownerPriv });
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
    expect((await owner.auditLog()).verification.ok).toBe(true);
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

describe('wire-name guard', () => {
  /**
   * The failure this prevents was found by deploying locally and using the
   * SDK from a plain `.mjs` script: `createTask({ side_effect: true })` is an
   * excess property that TypeScript rejects and JavaScript ignores, so the
   * `?? false` default applied and the task was created WITHOUT the approval
   * gate. The assignee would then have executed the side effect with no owner
   * decision — the one outcome CLAUDE.md §1.3 exists to prevent.
   *
   * Every document in the project spells this field `side_effect`; only this
   * client spells it `sideEffect`. That makes the mistake structural, so the
   * guard refuses rather than translates.
   */
  it('REFUSES side_effect, which would have created an ungated task', async () => {
    await expect(
      claude.createTask({
        thread: 'thr_1',
        assignee: 'agent:muse',
        title: 'pay the invoice',
        payload: { amount: 100 },
        // @ts-expect-error -- the wire name; TS catches it, JS would not.
        side_effect: true,
      }),
    ).rejects.toThrow(/"side_effect" is the wire field name/);
  });

  it('says what the correct name is, and what the silent cost was', async () => {
    const err = await claude
      .createTask({
        thread: 'thr_1',
        assignee: 'agent:muse',
        title: 'x',
        payload: {},
        // @ts-expect-error -- deliberate
        side_effect: true,
      })
      .catch((e: unknown) => e as Error);
    expect(err.message).toContain('sideEffect');
    expect(err.message).toContain('WITHOUT the approval gate');
  });

  it('refuses the other wire names too, which fail the same way', async () => {
    // due_at and idempotency_key are the same bug, just cheaper: silently
    // ignored, so the caller believes it set a deadline or a retry key.
    for (const bad of ['due_at', 'idempotency_key'] as const) {
      await expect(
        claude.createTask({
          thread: 'thr_1',
          assignee: 'agent:muse',
          title: 'x',
          payload: {},
          // @ts-expect-error -- deliberate
          [bad]: 'whatever',
        }),
      ).rejects.toThrow(new RegExp(`"${bad}" is the wire field name`));
    }
  });

  it('guards requestApproval, whose name a stray side_effect would contradict', async () => {
    await expect(
      claude.requestApproval({
        thread: 'thr_1',
        assignee: 'agent:muse',
        title: 'x',
        payload: {},
        // @ts-expect-error -- deliberate
        side_effect: false,
      }),
    ).rejects.toThrow(/wire field name/);
  });

  it('still accepts the camelCase form, and gates the task', async () => {
    // The complement: the guard must not have broken the correct spelling.
    const task = await claude.createTask({
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 'gated properly',
      payload: { amount: 100 },
      sideEffect: true,
    });
    expect(task.state).toBe('needs-approval');
  });
});

describe('trace id propagation (spec §8)', () => {
  const TRACE = 'ab'.repeat(16);

  function spyFetch(seen: Record<string, string>[]) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ ...((init?.headers ?? {}) as Record<string, string>) });
      return globalThis.fetch(url as string, init);
    }) as typeof fetch;
  }

  it('sends the caller trace id, so the hub joins the same trace', async () => {
    // Previously sent no such header at all, which is the only thing the hub
    // reads a caller's trace from — so §8 held for raw HTTP and failed for
    // every SDK user.
    const seen: Record<string, string>[] = [];
    const c = new Client({ ...claudeOpts, fetch: spyFetch(seen), traceId: () => TRACE });
    await c.listInbox();
    expect(seen[0]?.['x-agentbridge-trace-id']).toBe(TRACE);
  });

  it('sends no header when there is no active trace', async () => {
    const seen: Record<string, string>[] = [];
    const c = new Client({ ...claudeOpts, fetch: spyFetch(seen), traceId: () => undefined });
    await c.listInbox();
    expect(seen[0]).not.toHaveProperty('x-agentbridge-trace-id');
  });

  it('THROWS on a malformed trace id rather than letting the hub discard it', async () => {
    // The hub replaces a bad id and warns server-side, so the agent would
    // believe its traces were joined when they were not.
    const c = new Client({ ...claudeOpts, traceId: () => 'not-a-trace-id' });
    await expect(c.listInbox()).rejects.toThrow(/not a 32-character lowercase hex/);
  });

  it('re-reads the provider per request, so a per-task trace works', async () => {
    // The option is a function precisely because an agent handling many tasks
    // has one trace per task, not one per client.
    const seen: Record<string, string>[] = [];
    let current = TRACE;
    const c = new Client({ ...claudeOpts, fetch: spyFetch(seen), traceId: () => current });
    await c.listInbox();
    current = 'cd'.repeat(16);
    await c.listInbox();
    expect(seen[0]?.['x-agentbridge-trace-id']).toBe(TRACE);
    expect(seen[1]?.['x-agentbridge-trace-id']).toBe('cd'.repeat(16));
  });
});
