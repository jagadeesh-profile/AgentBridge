import { describe, expect, it } from 'vitest';
import { makeFakes } from './index.js';
import type { AgentRecord } from '../index.js';

function agent(ref: string): AgentRecord {
  return {
    ref,
    workspace: 'ws',
    name: ref.slice('agent:'.length),
    publicKey: 'AAAA',
    webhookUrl: null,
    webhookSecret: null,
    scopes: ['read', 'message'],
    keyStatus: 'active',
    capabilities: {},
    createdAt: '2026-10-20T00:00:00.000Z',
  };
}

describe('fakes', () => {
  it('rolls back every write when a transaction throws', () => {
    const { store } = makeFakes();
    expect(() =>
      store.transaction(() => {
        store.putAgent(agent('agent:a'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.getAgent('ws', 'agent:a')).toBeNull();
  });

  it('keeps writes that happen in a committed transaction', () => {
    const { store } = makeFakes();
    store.transaction(() => store.putAgent(agent('agent:a')));
    expect(store.getAgent('ws', 'agent:a')?.ref).toBe('agent:a');
  });

  it('joins a nested transaction to the outer one, rolling back together', () => {
    const { store } = makeFakes();
    expect(() =>
      store.transaction(() => {
        store.putAgent(agent('agent:a'));
        store.transaction(() => store.putAgent(agent('agent:b')));
        throw new Error('outer fails');
      }),
    ).toThrow('outer fails');
    expect(store.getAgent('ws', 'agent:a')).toBeNull();
    expect(store.getAgent('ws', 'agent:b')).toBeNull();
  });

  it('isolates agents by workspace', () => {
    const { store } = makeFakes();
    store.putAgent(agent('agent:a'));
    expect(store.getAgent('other-ws', 'agent:a')).toBeNull();
  });

  it('advances the fake clock deterministically', () => {
    const { clock } = makeFakes();
    const t0 = clock.now().getTime();
    clock.advance(5000);
    expect(clock.now().getTime() - t0).toBe(5000);
  });

  it('generates monotonically increasing prefixed ids', () => {
    const { ids } = makeFakes();
    const a = ids.ulid('msg');
    const b = ids.ulid('msg');
    expect(a.startsWith('msg_')).toBe(true);
    expect(b > a).toBe(true);
  });

  it('refuses a duplicate idempotency key and lets the caller read it back', () => {
    const { store } = makeFakes();
    expect(store.tryPutIdempotent('ws', 'agent:a', 'k', 'h', '{"ok":1}')).toBe(true);
    expect(store.tryPutIdempotent('ws', 'agent:a', 'k', 'h', '{"ok":2}')).toBe(false);
    expect(store.findIdempotent('ws', 'agent:a', 'k')?.response).toBe('{"ok":1}');
  });

  it('records and detects a replayed nonce', () => {
    const { store, clock } = makeFakes();
    const ts = clock.now().toISOString();
    expect(store.seenNonce('agent:a', ts)).toBe(false);
    store.recordNonce('agent:a', ts, new Date(clock.now().getTime() + 300_000).toISOString());
    expect(store.seenNonce('agent:a', ts)).toBe(true);
    expect(store.seenNonce('agent:b', ts)).toBe(false);
  });

  it('stores and reads blobs', async () => {
    const { blob } = makeFakes();
    await blob.put('k', new Uint8Array([1, 2, 3]), 'application/octet-stream');
    expect(await blob.get('k')).toEqual(new Uint8Array([1, 2, 3]));
  });
});
