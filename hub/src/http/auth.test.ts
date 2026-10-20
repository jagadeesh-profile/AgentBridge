import * as ed from '@noble/ed25519';
import { requestDescriptor, signDescriptor } from '@agentbridge/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, type Fakes } from '../ports/fakes/index.js';
import { authenticate } from './auth.js';

let deps: Fakes;
let priv: Uint8Array;

async function signedRequest(overrides: { timestamp?: string; path?: string } = {}) {
  const timestamp = overrides.timestamp ?? deps.clock.now().toISOString();
  const path = overrides.path ?? '/v1/inbox';
  const descriptor = requestDescriptor({
    method: 'GET',
    path,
    query: {},
    body: '',
    timestamp,
  });
  return {
    method: 'GET',
    path,
    query: {} as Record<string, string | string[]>,
    body: '',
    headers: {
      'x-agentbridge-workspace': 'ws',
      'x-agentbridge-agent': 'agent:muse',
      'x-agentbridge-timestamp': timestamp,
      'x-agentbridge-signature': await signDescriptor(descriptor, priv),
    } as Record<string, string | undefined>,
  };
}

beforeEach(async () => {
  deps = makeFakes();
  priv = ed.utils.randomPrivateKey();
  const pub = Buffer.from(await ed.getPublicKeyAsync(priv)).toString('base64');
  deps.store.putAgent({
    ref: 'agent:muse',
    workspace: 'ws',
    name: 'muse',
    publicKey: pub,
    webhookUrl: null,
    webhookSecret: null,
    scopes: ['read', 'message'],
    keyStatus: 'active',
    capabilities: {},
    createdAt: '2026-10-20T00:00:00.000Z',
  });
});

describe('authenticate', () => {
  it('accepts a correctly signed request', async () => {
    await expect(authenticate(deps, await signedRequest())).resolves.toMatchObject({
      ref: 'agent:muse',
    });
  });

  it('rejects a missing signature header with unauthenticated', async () => {
    const r = await signedRequest();
    delete r.headers['x-agentbridge-signature'];
    await expect(authenticate(deps, r)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a signature over a different path', async () => {
    const r = await signedRequest();
    await expect(authenticate(deps, { ...r, path: '/v1/tasks' })).rejects.toMatchObject({
      code: 'signature_invalid',
    });
  });

  it('rejects a revoked key even with a valid signature', async () => {
    deps.store.setKeyStatus('ws', 'agent:muse', 'revoked');
    await expect(authenticate(deps, await signedRequest())).rejects.toMatchObject({
      code: 'key_revoked',
    });
  });

  it('rejects an unknown agent with the same code as bad credentials', async () => {
    const r = await signedRequest();
    r.headers['x-agentbridge-agent'] = 'agent:ghost';
    await expect(authenticate(deps, r)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a replayed timestamp that was already seen', async () => {
    const r = await signedRequest();
    await authenticate(deps, r);
    await expect(authenticate(deps, r)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a non-numeric timestamp rather than treating it as epoch', async () => {
    const r = await signedRequest({ timestamp: 'not-a-date' });
    await expect(authenticate(deps, r)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  // Review Focus item 1 — the replay window boundary.
  it('ACCEPTS a request signed 299 s ago', async () => {
    const ts = new Date(deps.clock.now().getTime() - 299_000).toISOString();
    await expect(authenticate(deps, await signedRequest({ timestamp: ts }))).resolves.toMatchObject(
      { ref: 'agent:muse' },
    );
  });

  it('REJECTS a request signed 301 s ago', async () => {
    const ts = new Date(deps.clock.now().getTime() - 301_000).toISOString();
    await expect(authenticate(deps, await signedRequest({ timestamp: ts }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('ACCEPTS a request timestamped 299 s in the future, for modest clock skew', async () => {
    const ts = new Date(deps.clock.now().getTime() + 299_000).toISOString();
    await expect(authenticate(deps, await signedRequest({ timestamp: ts }))).resolves.toMatchObject(
      { ref: 'agent:muse' },
    );
  });

  it('REJECTS a request timestamped 301 s in the future', async () => {
    const ts = new Date(deps.clock.now().getTime() + 301_000).toISOString();
    await expect(authenticate(deps, await signedRequest({ timestamp: ts }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
