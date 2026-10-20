import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, type Fakes } from '@agentbridge/hub/ports/fakes';
import type { OutboxRow } from '@agentbridge/hub/ports';
import { makeScheduler } from './outbox-scheduler.js';

let deps: Fakes;
let sched: ReturnType<typeof makeScheduler>;

function row(id: string, thread: string, nextAttemptAt = '2026-10-20T12:00:00.000Z'): OutboxRow {
  return {
    id,
    workspace: 'ws',
    thread,
    recipient: 'agent:muse',
    messageId: `msg_${id}`,
    attempts: 0,
    nextAttemptAt,
    state: 'pending',
    ackedAt: null,
    createdAt: '2026-10-20T12:00:00.000Z',
  };
}

beforeEach(() => {
  deps = makeFakes();
  // The claim query only considers agents that registered a webhook URL.
  deps.store.putAgent({
    ref: 'agent:muse',
    workspace: 'ws',
    name: 'muse',
    publicKey: 'AAAA',
    webhookUrl: 'https://muse.example/hook',
    webhookSecret: 'secret',
    scopes: ['read', 'message'],
    keyStatus: 'active',
    capabilities: {},
    createdAt: '2026-10-20T00:00:00.000Z',
  });
  sched = makeScheduler(deps);
});

describe('outbox scheduler', () => {
  it('claims the oldest pending row', () => {
    deps.store.putOutbox(row('ob_2', 'thr_1'));
    deps.store.putOutbox(row('ob_1', 'thr_1'));
    expect(sched.claimNext(deps.clock.now())?.id).toBe('ob_1');
  });

  it('claims nothing when the next attempt is in the future', () => {
    deps.store.putOutbox(row('ob_1', 'thr_1', '2026-10-20T13:00:00.000Z'));
    expect(sched.claimNext(deps.clock.now())).toBeNull();
  });

  it('runs different threads concurrently', () => {
    deps.store.putOutbox(row('ob_1', 'thr_1'));
    deps.store.putOutbox(row('ob_2', 'thr_2'));
    expect(sched.claimNext(deps.clock.now())?.id).toBe('ob_1');
    expect(sched.claimNext(deps.clock.now())?.id).toBe('ob_2');
  });

  it('serializes within a thread — no second claim while one is inflight', () => {
    deps.store.putOutbox(row('ob_1', 'thr_1'));
    deps.store.putOutbox(row('ob_2', 'thr_1'));
    expect(sched.claimNext(deps.clock.now())?.id).toBe('ob_1');
    expect(sched.claimNext(deps.clock.now())).toBeNull();
  });

  it('releases the thread once the inflight row completes', async () => {
    deps.store.putOutbox(row('ob_1', 'thr_1'));
    deps.store.putOutbox(row('ob_2', 'thr_1'));
    const first = sched.claimNext(deps.clock.now());
    expect(first).not.toBeNull();
    await sched.complete((first as OutboxRow).id);
    expect(sched.claimNext(deps.clock.now())?.id).toBe('ob_2');
  });

  // Review Focus item 3 — ordering must hold while row 1 is mid-backoff.
  it('does NOT let a later row overtake one that is retrying', async () => {
    deps.store.putOutbox(row('ob_1', 'thr_1'));
    deps.store.putOutbox(row('ob_2', 'thr_1'));
    const first = sched.claimNext(deps.clock.now());
    expect(first).not.toBeNull();
    // ob_1 failed and retries in 30 s. It is NOT done, so the thread is blocked.
    await sched.fail((first as OutboxRow).id, new Date(deps.clock.now().getTime() + 30_000));
    expect(sched.claimNext(deps.clock.now()), 'ob_2 must not overtake a retrying ob_1').toBeNull();
    deps.clock.advance(30_000);
    expect(sched.claimNext(deps.clock.now())?.id).toBe('ob_1');
  });

  it('lets the thread proceed once a row is dead-lettered', async () => {
    deps.store.putOutbox(row('ob_1', 'thr_1'));
    deps.store.putOutbox(row('ob_2', 'thr_1'));
    const first = sched.claimNext(deps.clock.now());
    expect(first).not.toBeNull();
    await sched.fail((first as OutboxRow).id, null);
    expect(deps.store.getOutbox('ob_1')?.state).toBe('dead');
    expect(sched.claimNext(deps.clock.now())?.id).toBe('ob_2');
  });

  it('counts attempts across retries', async () => {
    deps.store.putOutbox(row('ob_1', 'thr_1'));
    const first = sched.claimNext(deps.clock.now());
    await sched.fail((first as OutboxRow).id, new Date(deps.clock.now().getTime() + 1));
    deps.clock.advance(10);
    const again = sched.claimNext(deps.clock.now());
    expect(again?.attempts).toBe(1);
  });

  it('marks a completed row delivered and acknowledged', async () => {
    deps.store.putOutbox(row('ob_1', 'thr_1'));
    const first = sched.claimNext(deps.clock.now());
    await sched.complete((first as OutboxRow).id);
    const stored = deps.store.getOutbox('ob_1');
    expect(stored?.state).toBe('delivered');
    expect(stored?.ackedAt).not.toBeNull();
  });

  it('recovers orphaned inflight rows after a restart', () => {
    deps.store.putOutbox(row('ob_1', 'thr_1'));
    sched.claimNext(deps.clock.now());
    // A crash leaves ob_1 inflight and the in-memory thread lock lost.
    const fresh = makeScheduler(deps);
    fresh.recoverInflight(deps.clock.now());
    expect(fresh.claimNext(deps.clock.now())?.id).toBe('ob_1');
  });

  it('never claims a row for a pull-only agent', () => {
    deps.store.putAgent({
      ref: 'agent:pull',
      workspace: 'ws',
      name: 'pull',
      publicKey: 'BBBB',
      webhookUrl: null,
      webhookSecret: null,
      scopes: ['read'],
      keyStatus: 'active',
      capabilities: {},
      createdAt: '2026-10-20T00:00:00.000Z',
    });
    deps.store.putOutbox({ ...row('ob_1', 'thr_pull'), recipient: 'agent:pull' });
    expect(sched.claimNext(deps.clock.now())).toBeNull();
    expect(deps.store.listInbox('ws', 'agent:pull', null, 10)).toHaveLength(1);
  });
});
