import * as ed from '@noble/ed25519';
import { ownerRequestDescriptor, requestDescriptor, signDescriptor } from '@agentbridge/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, type Fakes } from '../ports/fakes/index.js';
import { authenticate, authenticateOwner } from './auth.js';

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

  // A refused signature sends the operator looking at their key. Clock drift is
  // the far more common cause, and the message is the only place that can say so.
  it('NAMES the drift and its direction when the sender is behind', async () => {
    const ts = new Date(deps.clock.now().getTime() - 420_000).toISOString();
    await expect(authenticate(deps, await signedRequest({ timestamp: ts }))).rejects.toMatchObject({
      code: 'unauthenticated',
      // publicDetail, not message: the catalog message is the generic one, and
      // publicDetail is the field the error handler actually sends to the client.
      publicDetail: expect.stringMatching(/420s behind .*clock/i),
    });
  });

  it('says AHEAD when the sender is in the future, not the same message both ways', async () => {
    const ts = new Date(deps.clock.now().getTime() + 420_000).toISOString();
    await expect(authenticate(deps, await signedRequest({ timestamp: ts }))).rejects.toMatchObject({
      publicDetail: expect.stringMatching(/420s ahead of/i),
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

describe('authenticateOwner', () => {
  let ownerPriv: Uint8Array;
  let ownerPub: Uint8Array;

  beforeEach(async () => {
    ownerPriv = ed.utils.randomPrivateKey();
    ownerPub = await ed.getPublicKeyAsync(ownerPriv);
  });

  async function ownerRequest(
    over: {
      method?: string;
      path?: string;
      body?: string;
      workspace?: string;
      signedWorkspace?: string;
      timestamp?: string;
      signWith?: Uint8Array;
      query?: Record<string, string | string[]>;
    } = {},
  ) {
    const method = over.method ?? 'POST';
    const path = over.path ?? '/v1/approvals';
    const body = over.body ?? '{"task":"tsk_1"}';
    const workspace = over.workspace ?? 'ws';
    const query = over.query ?? {};
    const timestamp = over.timestamp ?? deps.clock.now().toISOString();
    const descriptor = ownerRequestDescriptor({
      method,
      path,
      query,
      body,
      // Deliberately separable, so a test can prove the binding holds.
      workspace: over.signedWorkspace ?? workspace,
      issuedAt: timestamp,
    });
    return {
      method,
      path,
      query,
      body,
      headers: {
        'x-agentbridge-workspace': workspace,
        'x-agentbridge-timestamp': timestamp,
        'x-agentbridge-owner-signature': await signDescriptor(
          descriptor,
          over.signWith ?? ownerPriv,
        ),
      } as Record<string, string | undefined>,
    };
  }

  it('accepts a request signed by the owner key and returns the workspace', async () => {
    await expect(authenticateOwner(deps, ownerPub, await ownerRequest())).resolves.toBe('ws');
  });

  it('REFUSES a signature from any other key', async () => {
    await expect(
      authenticateOwner(
        deps,
        ownerPub,
        await ownerRequest({ signWith: ed.utils.randomPrivateKey() }),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('REFUSES a signature retargeted at another workspace', async () => {
    // The workspace arrives in a header; only the signature decides whose it is.
    await expect(
      authenticateOwner(
        deps,
        ownerPub,
        await ownerRequest({ signedWorkspace: 'ws', workspace: 'ws_victim' }),
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('REFUSES a signed GET replayed as a POST', async () => {
    const signed = await ownerRequest({ method: 'GET', path: '/v1/tasks', body: '' });
    await expect(
      authenticateOwner(deps, ownerPub, { ...signed, method: 'POST' }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('REFUSES a body swapped after signing', async () => {
    const signed = await ownerRequest({ body: '{"task":"tsk_1","decision":"approve"}' });
    await expect(
      authenticateOwner(deps, ownerPub, { ...signed, body: '{"task":"tsk_evil"}' }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('REFUSES an AGENT signature presented as an owner signature', async () => {
    // Domain separation. Without the version tag an agent could approve its
    // own side effects by replaying a request it legitimately signed.
    const timestamp = deps.clock.now().toISOString();
    const agentDescriptor = requestDescriptor({
      method: 'POST',
      path: '/v1/approvals',
      query: {},
      body: '{"task":"tsk_1"}',
      timestamp,
    });
    await expect(
      authenticateOwner(deps, ownerPub, {
        method: 'POST',
        path: '/v1/approvals',
        query: {},
        body: '{"task":"tsk_1"}',
        headers: {
          'x-agentbridge-workspace': 'ws',
          'x-agentbridge-timestamp': timestamp,
          'x-agentbridge-owner-signature': await signDescriptor(agentDescriptor, ownerPriv),
        },
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('REFUSES a replay of the very same owner request', async () => {
    const req = await ownerRequest();
    await expect(authenticateOwner(deps, ownerPub, req)).resolves.toBe('ws');
    await expect(authenticateOwner(deps, ownerPub, req)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('reports clock drift here too, not a bare refusal', async () => {
    const stale = new Date(deps.clock.now().getTime() - 400_000).toISOString();
    await expect(
      authenticateOwner(deps, ownerPub, await ownerRequest({ timestamp: stale })),
    ).rejects.toMatchObject({ publicDetail: expect.stringMatching(/400s behind/i) });
  });

  it('REFUSES when the workspace header is missing entirely', async () => {
    const req = await ownerRequest();
    await expect(
      authenticateOwner(deps, ownerPub, {
        ...req,
        headers: { ...req.headers, 'x-agentbridge-workspace': undefined },
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
