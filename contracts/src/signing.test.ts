import * as ed from '@noble/ed25519';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ownerRequestDescriptor,
  payloadHash,
  registrationDescriptor,
  requestDescriptor,
  sha256Hex,
  signDescriptor,
  signEnvelope,
  verifyDescriptor,
  verifyEnvelope,
} from './signing.js';
import type { Envelope } from './envelope.js';

let priv: Uint8Array;
let pub: Uint8Array;
let other: Uint8Array;

beforeAll(async () => {
  priv = ed.utils.randomPrivateKey();
  pub = await ed.getPublicKeyAsync(priv);
  other = await ed.getPublicKeyAsync(ed.utils.randomPrivateKey());
});

const base: Omit<Envelope, 'sig'> = {
  id: 'msg_01J000000000000000000000',
  workspace: 'ws_jagadeesh',
  thread: 'thr_job_search',
  from: 'agent:muse',
  to: ['agent:claude'],
  type: 'task.result',
  body: { text: 'hello 👋' },
  side_effect: false,
  idempotency_key: 'k1',
  trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
  created_at: '2026-10-20T20:50:46Z',
};

describe('envelope signing', () => {
  it('produces an ed25519-prefixed signature that verifies', async () => {
    const sig = await signEnvelope(base, priv);
    expect(sig).toMatch(/^ed25519:/);
    expect(await verifyEnvelope({ ...base, sig }, pub)).toBe(true);
  });

  it('fails verification under a different key', async () => {
    const sig = await signEnvelope(base, priv);
    expect(await verifyEnvelope({ ...base, sig }, other)).toBe(false);
  });

  it('fails when any field is tampered with', async () => {
    const sig = await signEnvelope(base, priv);
    const tampered = { ...base, to: ['agent:attacker'], sig } as Envelope;
    expect(await verifyEnvelope(tampered, pub)).toBe(false);
  });

  it('is insensitive to key insertion order', async () => {
    const sig = await signEnvelope(base, priv);
    const reordered = {
      sig,
      created_at: base.created_at,
      body: base.body,
      to: base.to,
      from: base.from,
      type: base.type,
      thread: base.thread,
      workspace: base.workspace,
      id: base.id,
      side_effect: base.side_effect,
      idempotency_key: base.idempotency_key,
      trace_id: base.trace_id,
    } as Envelope;
    expect(await verifyEnvelope(reordered, pub)).toBe(true);
  });

  it('verifies a body containing emoji and CJK text', async () => {
    const wide = { ...base, body: { text: '日本語 👩‍💻 héllo' } };
    const sig = await signEnvelope(wide, priv);
    expect(await verifyEnvelope({ ...wide, sig }, pub)).toBe(true);
  });

  it('returns false rather than throwing on a malformed signature', async () => {
    expect(await verifyEnvelope({ ...base, sig: 'ed25519:!!!' } as Envelope, pub)).toBe(false);
  });

  it('returns false rather than throwing on a non-ed25519 prefix', async () => {
    expect(await verifyEnvelope({ ...base, sig: 'rsa:AAAA' } as Envelope, pub)).toBe(false);
  });
});

describe('payloadHash', () => {
  it('is stable across key order', () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it('changes when any value changes', () => {
    expect(payloadHash({ to: 'a@b.com' })).not.toBe(payloadHash({ to: 'c@d.com' }));
  });

  it('is 64 lowercase hex characters', () => {
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('request descriptors', () => {
  const r = {
    method: 'get',
    path: '/v1/inbox',
    query: { since: 'msg_01J', limit: '50' },
    body: '',
    timestamp: '2026-10-20T20:50:46Z',
  };

  it('upper-cases the method and sorts the query', () => {
    const d = requestDescriptor(r);
    expect(d.startsWith('GET\n/v1/inbox\nlimit=50&since=msg_01J\n')).toBe(true);
  });

  it('is identical regardless of query parameter order', () => {
    expect(requestDescriptor(r)).toBe(
      requestDescriptor({ ...r, query: { limit: '50', since: 'msg_01J' } }),
    );
  });

  it('changes when the body changes', () => {
    expect(requestDescriptor({ ...r, body: '{}' })).not.toBe(requestDescriptor(r));
  });

  it('changes when the timestamp changes, so a descriptor cannot be replayed', () => {
    expect(requestDescriptor({ ...r, timestamp: '2026-10-20T20:51:46Z' })).not.toBe(
      requestDescriptor(r),
    );
  });

  it('round-trips through sign and verify', async () => {
    const d = requestDescriptor(r);
    const sig = await signDescriptor(d, priv);
    expect(await verifyDescriptor(d, sig, pub)).toBe(true);
    expect(await verifyDescriptor(requestDescriptor({ ...r, path: '/v1/tasks' }), sig, pub)).toBe(
      false,
    );
  });
});

describe('registration descriptors', () => {
  const base = {
    workspace: 'ws_jagadeesh',
    name: 'muse',
    publicKey: 'QUFBQQ==',
    scopes: ['read', 'message'],
    issuedAt: '2026-10-20T20:50:46Z',
  };

  it('binds the workspace, so a signature cannot be replayed into another one', () => {
    expect(registrationDescriptor(base)).not.toBe(
      registrationDescriptor({ ...base, workspace: 'ws_victim' }),
    );
  });

  it('binds the agent name', () => {
    expect(registrationDescriptor(base)).not.toBe(
      registrationDescriptor({ ...base, name: 'impostor' }),
    );
  });

  it('binds the public key, so the key cannot be swapped after signing', () => {
    expect(registrationDescriptor(base)).not.toBe(
      registrationDescriptor({ ...base, publicKey: 'QkJCQg==' }),
    );
  });

  it('binds the scopes, so an agent cannot self-escalate', () => {
    expect(registrationDescriptor(base)).not.toBe(
      registrationDescriptor({ ...base, scopes: ['read', 'message', 'request_side_effect'] }),
    );
  });

  it('binds the webhook url, so delivery cannot be redirected', () => {
    expect(registrationDescriptor(base)).not.toBe(
      registrationDescriptor({ ...base, webhookUrl: 'https://attacker.example/hook' }),
    );
  });

  it('binds the timestamp, so an old signature cannot be reused', () => {
    expect(registrationDescriptor(base)).not.toBe(
      registrationDescriptor({ ...base, issuedAt: '2026-10-21T20:50:46Z' }),
    );
  });

  it('is stable regardless of scope order', () => {
    expect(registrationDescriptor({ ...base, scopes: ['message', 'read'] })).toBe(
      registrationDescriptor({ ...base, scopes: ['read', 'message'] }),
    );
  });

  it('distinguishes an absent webhook url from an empty one', () => {
    expect(registrationDescriptor(base)).not.toBe(
      registrationDescriptor({ ...base, webhookUrl: '' }),
    );
  });

  it('round-trips through sign and verify with the owner key', async () => {
    const d = registrationDescriptor(base);
    const sig = await signDescriptor(d, priv);
    expect(await verifyDescriptor(d, sig, pub)).toBe(true);
    expect(await verifyDescriptor(d, sig, other)).toBe(false);
  });

  it('fails verification when any bound field changed after signing', async () => {
    const sig = await signDescriptor(registrationDescriptor(base), priv);
    const tampered = registrationDescriptor({
      ...base,
      scopes: ['read', 'message', 'create_task'],
    });
    expect(await verifyDescriptor(tampered, sig, pub)).toBe(false);
  });
});

describe('sha256 is isomorphic', () => {
  it('matches the known SHA-256 of the empty string', () => {
    // Pins the implementation against a published vector, so swapping the
    // backing library cannot silently change every hash in the system —
    // including the payload hashes approvals are bound to.
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the known SHA-256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('agrees with node:crypto on non-ASCII input', async () => {
    // The console hashes in a browser and the hub in Node. If the two disagreed
    // on encoding, every non-ASCII payload would fail the approval gate — and
    // only for those payloads, which is the worst way to find out.
    const { createHash } = await import('node:crypto');
    for (const input of ['', 'abc', '👋', 'héllo wörld', '{"to":"a@b.com","note":"café"}']) {
      expect(sha256Hex(input), input).toBe(
        createHash('sha256').update(input, 'utf8').digest('hex'),
      );
    }
  });

  it('does NOT reach for node:crypto, so the browser can hash too', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./signing.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toMatch(/from 'node:crypto'/);
  });
});

describe('ownerRequestDescriptor', () => {
  const base = {
    method: 'POST',
    path: '/v1/approvals',
    query: {},
    body: '{"task":"tsk_1"}',
    workspace: 'ws',
    issuedAt: '2026-10-21T08:00:00.000Z',
  };

  it('binds the workspace, which no header-derived value can be trusted for', () => {
    expect(ownerRequestDescriptor(base)).not.toBe(
      ownerRequestDescriptor({ ...base, workspace: 'ws_other' }),
    );
  });

  it('binds the method, so a signed GET cannot be replayed as a POST', () => {
    expect(ownerRequestDescriptor(base)).not.toBe(
      ownerRequestDescriptor({ ...base, method: 'GET' }),
    );
  });

  it('binds the path and the body', () => {
    expect(ownerRequestDescriptor(base)).not.toBe(
      ownerRequestDescriptor({ ...base, path: '/v1/tasks' }),
    );
    expect(ownerRequestDescriptor(base)).not.toBe(ownerRequestDescriptor({ ...base, body: '{}' }));
  });

  it('is DISTINCT from an agent requestDescriptor over the same request', () => {
    // Domain separation: an agent signature must never be replayable as an
    // owner signature, nor the reverse. The version tag is what guarantees it.
    expect(ownerRequestDescriptor(base)).not.toBe(
      requestDescriptor({ ...base, timestamp: base.issuedAt }),
    );
  });

  it('is DISTINCT from a registration descriptor', () => {
    expect(ownerRequestDescriptor(base).split('\n')[0]).not.toBe(
      registrationDescriptor({
        workspace: 'ws',
        name: 'n',
        publicKey: 'k',
        scopes: [],
        issuedAt: base.issuedAt,
      }).split('\n')[0],
    );
  });

  it('round-trips through sign and verify', async () => {
    const d = ownerRequestDescriptor(base);
    const sig = await signDescriptor(d, priv);
    expect(await verifyDescriptor(d, sig, pub)).toBe(true);
    expect(await verifyDescriptor(d, sig, other)).toBe(false);
  });
});
