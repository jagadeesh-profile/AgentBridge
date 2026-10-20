import { describe, expect, it, vi } from 'vitest';
import { makeFakes } from '../ports/fakes/index.js';
import { withIdempotency } from './idempotency.js';

describe('withIdempotency', () => {
  it('runs the body once and replays the stored response', async () => {
    const deps = makeFakes();
    const fn = vi.fn(() => ({ id: 'tsk_1' }));
    const a = await withIdempotency(deps, 'ws', 'agent:a', 'k', 'h', fn);
    const b = await withIdempotency(deps, 'ws', 'agent:a', 'k', 'h', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('runs the body every time when no key is supplied', async () => {
    const deps = makeFakes();
    const fn = vi.fn(() => ({ id: 'x' }));
    await withIdempotency(deps, 'ws', 'agent:a', undefined, 'h', fn);
    await withIdempotency(deps, 'ws', 'agent:a', undefined, 'h', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // Review Focus item 2 — concurrent writes on one key.
  it('gives BOTH concurrent callers the same response and runs the body once', async () => {
    const deps = makeFakes();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      // Yield, so both callers are inside the body before either stores.
      await Promise.resolve();
      return { id: `tsk_${calls}` };
    };
    const [a, b] = await Promise.all([
      withIdempotency(deps, 'ws', 'agent:a', 'k', 'h', fn),
      withIdempotency(deps, 'ws', 'agent:a', 'k', 'h', fn),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it('rejects the same key reused with a different payload', async () => {
    const deps = makeFakes();
    await withIdempotency(deps, 'ws', 'agent:a', 'k', 'hash-one', () => ({ ok: 1 }));
    await expect(
      withIdempotency(deps, 'ws', 'agent:a', 'k', 'hash-two', () => ({ ok: 2 })),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('scopes keys per agent', async () => {
    const deps = makeFakes();
    await withIdempotency(deps, 'ws', 'agent:a', 'k', 'h', () => ({ who: 'a' }));
    await expect(
      withIdempotency(deps, 'ws', 'agent:b', 'k', 'h', () => ({ who: 'b' })),
    ).resolves.toEqual({ who: 'b' });
  });

  it('scopes keys per workspace', async () => {
    const deps = makeFakes();
    await withIdempotency(deps, 'ws1', 'agent:a', 'k', 'h', () => ({ ws: 1 }));
    await expect(
      withIdempotency(deps, 'ws2', 'agent:a', 'k', 'h', () => ({ ws: 2 })),
    ).resolves.toEqual({ ws: 2 });
  });

  it('does NOT cache a failure, so a retry can succeed', async () => {
    const deps = makeFakes();
    await expect(
      withIdempotency(deps, 'ws', 'agent:a', 'k', 'h', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      withIdempotency(deps, 'ws', 'agent:a', 'k', 'h', () => ({ ok: 1 })),
    ).resolves.toEqual({ ok: 1 });
  });
});
