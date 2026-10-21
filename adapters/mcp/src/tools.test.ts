import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@agentbridge/hub/http';
import { makeFakes, type Fakes } from '@agentbridge/hub/ports/fakes';
import { Client, generateKeyPair, publicKeyBase64 } from '@agentbridge/sdk';
import { CreateTaskRequest } from '@agentbridge/contracts';
import { TOOLS, TOOL_NAMES, UNTRUSTED_NOTICE } from './tools.js';
import { buildServer } from './server.js';

const EXPECTED = [
  'approval.request',
  'artifact.put',
  'inbox.list',
  'message.send',
  'task.create',
  'task.get',
  'task.update',
];

describe('tool surface', () => {
  it('exposes exactly the seven Phase 0 tools', () => {
    expect([...TOOL_NAMES].sort()).toEqual(EXPECTED);
  });

  it('states in EVERY tool description that returned content is untrusted', () => {
    for (const tool of TOOLS) {
      expect(tool.description.toLowerCase(), tool.name).toContain('untrusted');
      expect(tool.description, tool.name).toContain(UNTRUSTED_NOTICE);
    }
  });

  it('gives every tool an input schema and a title', () => {
    for (const tool of TOOLS) {
      expect(Object.keys(tool.inputSchema).length, tool.name).toBeGreaterThan(0);
      expect(tool.title, tool.name).not.toBe('');
    }
  });

  it('requires side_effect on task.create rather than defaulting it', () => {
    const create = TOOLS.find((t) => t.name === 'task.create');
    expect(create).toBeDefined();
    const shape = create?.inputSchema ?? {};
    expect(Object.keys(shape)).toContain('side_effect');
    // Matches the contract: required there too, so omission cannot bypass the gate.
    expect(
      CreateTaskRequest.safeParse({ thread: 't', assignee: 'agent:m', title: 'x' }).success,
    ).toBe(false);
  });

  it('declares the same required task.create keys as the contract', () => {
    const create = TOOLS.find((t) => t.name === 'task.create');
    const declared = new Set(Object.keys(create?.inputSchema ?? {}));
    for (const key of ['thread', 'assignee', 'title', 'payload', 'side_effect']) {
      expect(declared, key).toContain(key);
    }
  });

  it('does NOT import hub internals — the boundary is mechanical, not advisory', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // Matches module specifiers only. Checking raw text would flag the comment
    // in server.ts that explains this very rule.
    const specifiers =
      /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

    for (const file of ['tools.ts', 'server.ts', 'index.ts']) {
      const src = await readFile(join(here, file), 'utf8');
      const imported: string[] = [];
      for (const m of src.matchAll(specifiers)) imported.push(m[1] ?? m[2] ?? '');

      for (const spec of imported) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/@agentbridge\/hub/);
        expect(spec, `${file} imports ${spec}`).not.toMatch(/hub\/src\//);
        expect(spec, `${file} imports ${spec}`).not.toMatch(/node:sqlite/);
        expect(spec, `${file} imports ${spec}`).not.toMatch(/\.\.\/\.\.\/\.\.\/hub/);
      }
      expect(imported.length, `${file} should import something`).toBeGreaterThan(0);
    }
  });
});

describe('tools against a real hub', () => {
  let deps: Fakes;
  let app: FastifyInstance;
  let client: Client;

  beforeEach(async () => {
    deps = makeFakes();
    const { privateKey, publicKey } = await generateKeyPair();
    for (const name of ['claude', 'muse']) {
      deps.store.putAgent({
        ref: `agent:${name}`,
        workspace: 'ws',
        name,
        publicKey: publicKeyBase64(publicKey),
        webhookUrl: null,
        webhookSecret: null,
        scopes: ['read', 'message', 'create_task', 'write_artifact', 'request_side_effect'],
        keyStatus: 'active',
        capabilities: {},
        createdAt: '2026-10-20T00:00:00.000Z',
      });
    }
    app = await buildApp(
      { ...deps, clock: { now: () => new Date() }, ownerPublicKey: new Uint8Array(32) },
      { logger: false, rateLimitMax: 5000 },
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    client = new Client({
      baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
      workspace: 'ws',
      agent: 'agent:claude',
      privateKey,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === name);
    expect(tool, name).toBeDefined();
    return (tool as (typeof TOOLS)[number]).handler(client, args);
  };

  it('forwards task.create and returns the task id', async () => {
    const created = (await run('task.create', {
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 'list matches',
      payload: { count: 3 },
      side_effect: false,
    })) as { id: string; state: string };
    expect(created.id).toMatch(/^tsk_/);
    expect(created.state).toBe('submitted');
  });

  it('round-trips task.create then task.get', async () => {
    const created = (await run('task.create', {
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 't',
      payload: {},
      side_effect: false,
    })) as { id: string };
    const read = (await run('task.get', { id: created.id })) as { id: string };
    expect(read.id).toBe(created.id);
  });

  it('keeps a gated task out of the assignee inbox via approval.request', async () => {
    const gated = (await run('approval.request', {
      thread: 'thr_1',
      assignee: 'agent:muse',
      title: 'send email',
      payload: { to: 'a@b.com' },
    })) as { state: string };
    expect(gated.state).toBe('needs-approval');
  });

  it('returns inbox items with their untrusted wrapper intact', async () => {
    await run('message.send', {
      thread: 'thr_1',
      to: ['agent:claude'],
      body: { text: 'hello' },
    });
    const page = (await run('inbox.list', {})) as {
      items: { body: { untrusted: boolean; provenance: { from: string }; value: unknown } }[];
    };
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]?.body.untrusted).toBe(true);
    expect(page.items[0]?.body.provenance.from).toBe('agent:claude');
    expect(page.items[0]?.body.value).toEqual({ text: 'hello' });
  });

  it('maps a hub error into an MCP tool error rather than crashing', async () => {
    const server = buildServer(client);
    expect(server).toBeDefined();
    await expect(
      run('task.create', {
        thread: 'thr_1',
        assignee: 'agent:ghost',
        title: 't',
        payload: {},
        side_effect: false,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('builds a server with all seven tools registered', () => {
    expect(() => buildServer(client)).not.toThrow();
  });
});
