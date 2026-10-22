// Boots a real hub on an ephemeral port for the Python integration test and
// prints one line of JSON describing how to reach it.
//
// Lives in `tests/` rather than beside the Python test because Node resolves
// bare specifiers from the importing file's directory, and `sdk/python` has
// no node_modules. `tests/` already depends on the hub, @noble/ed25519 and
// ulid.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';
import { ulid } from 'ulid';
import { buildApp, openBlobStore, openStore } from '@agentbridge/hub';

const dir = mkdtempSync(join(tmpdir(), 'ab-py-'));
const store = openStore(join(dir, 'py.sqlite'));
const deps = {
  store,
  clock: { now: () => new Date() },
  ids: { ulid: (p) => `${p}_${ulid()}` },
  blob: openBlobStore(join(dir, 'artifacts')),
};

const priv = ed.utils.randomPrivateKey();
const pub = Buffer.from(await ed.getPublicKeyAsync(priv)).toString('base64');
// putAgent rather than the registry domain function: registration is
// owner-signed (ADR 0005), and this fixture only needs the agents to exist.
const agent = (name, publicKey, scopes) =>
  store.putAgent({
    ref: `agent:${name}`,
    workspace: 'ws_py',
    name,
    publicKey,
    webhookUrl: null,
    webhookSecret: null,
    scopes,
    keyStatus: 'active',
    capabilities: {},
    createdAt: new Date().toISOString(),
  });

agent('pyagent', pub, ['read', 'message', 'create_task', 'write_artifact', 'request_side_effect']);
agent('peer', 'QUFBQQ==', ['read', 'message']);

const app = await buildApp(
  { ...deps, ownerPublicKey: new Uint8Array(32) },
  { logger: false, rateLimitMax: 5000 },
);
await app.listen({ port: 0, host: '127.0.0.1' });
const { port } = app.server.address();
process.stdout.write(
  `${JSON.stringify({ port, workspace: 'ws_py', agent: 'agent:pyagent', privateKeyBase64: Buffer.from(priv).toString('base64') })}\n`,
);

process.on('SIGTERM', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
