import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStore, type SqliteStore } from '../adapters/sqlite/store.js';
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

describe('exactly-once EFFECT across processes', () => {
  // Two Store handles on one database file is what two hub processes are, as
  // far as idempotency is concerned. The in-process WeakMap that used to
  // provide this guarantee cannot span them, which is why it had to go.
  const dirs: string[] = [];
  const stores: SqliteStore[] = [];

  function twoProcesses(): [SqliteStore, SqliteStore] {
    const dir = mkdtempSync(join(tmpdir(), 'ab-idem-'));
    dirs.push(dir);
    const path = join(dir, 'idem.sqlite');
    const a = openStore(path);
    const b = openStore(path);
    stores.push(a, b);
    return [a, b];
  }

  afterEach(() => {
    while (stores.length > 0) stores.pop()?.close();
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it('runs the body ONCE when two processes race the same key', async () => {
    const [a, b] = twoProcesses();
    let runs = 0;
    const body = async () => {
      runs += 1;
      // Hold the reservation across a tick so the two genuinely overlap.
      await new Promise((r) => setTimeout(r, 40));
      return { ok: runs };
    };

    const [one, two] = await Promise.all([
      withIdempotency({ store: a }, 'ws', 'agent:a', 'k1', 'h1', body),
      withIdempotency({ store: b }, 'ws', 'agent:a', 'k1', 'h1', body),
    ]);

    expect(runs).toBe(1);
    expect(one).toEqual(two);
  });

  it('reserves BEFORE the body runs, so a twin cannot slip in behind it', async () => {
    // The precise defect in the old shape: the record appeared only after
    // fn() returned, leaving the whole execution window unprotected.
    const [a, b] = twoProcesses();
    let seenByTwinDuringBody: string | null = null;

    await withIdempotency({ store: a }, 'ws', 'agent:a', 'k1', 'h1', async () => {
      const outcome = b.reserveIdempotent('ws', 'agent:a', 'k1', 'h1', new Date(), 60_000);
      seenByTwinDuringBody = outcome.kind;
      return { ok: true };
    });

    expect(seenByTwinDuringBody).toBe('in-flight');
  });

  it('frees the key when the body throws, so a real retry can succeed', async () => {
    const [a] = twoProcesses();
    await expect(
      withIdempotency({ store: a }, 'ws', 'agent:a', 'k1', 'h1', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const retried = await withIdempotency({ store: a }, 'ws', 'agent:a', 'k1', 'h1', () => ({
      ok: true,
    }));
    expect(retried).toEqual({ ok: true });
  });

  it('reclaims a reservation whose holder died', async () => {
    // Without this a crashed process wedges that key until a human notices.
    const [a, b] = twoProcesses();
    const longAgo = new Date(Date.now() - 10 * 60_000);
    expect(a.reserveIdempotent('ws', 'agent:a', 'k1', 'h1', longAgo, 60_000).kind).toBe('reserved');

    const result = await withIdempotency({ store: b }, 'ws', 'agent:a', 'k1', 'h1', () => ({
      ok: true,
    }));
    expect(result).toEqual({ ok: true });
  });

  it('still refuses the same key with a different payload', async () => {
    const [a, b] = twoProcesses();
    await withIdempotency({ store: a }, 'ws', 'agent:a', 'k1', 'hash-one', () => ({ ok: 1 }));
    await expect(
      withIdempotency({ store: b }, 'ws', 'agent:a', 'k1', 'hash-two', () => ({ ok: 2 })),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('does not treat a bare reservation as a replayable result', async () => {
    // findIdempotent must ignore an unfinished row, or a waiting caller would
    // parse NULL as a response.
    const [a] = twoProcesses();
    a.reserveIdempotent('ws', 'agent:a', 'k1', 'h1', new Date(), 60_000);
    expect(a.findIdempotent('ws', 'agent:a', 'k1')).toBeNull();
  });
});
