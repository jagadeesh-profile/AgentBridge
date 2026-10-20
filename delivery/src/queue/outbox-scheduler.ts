import type { Clock, OutboxRow, Queue, Store } from '@agentbridge/hub/ports';

export interface Scheduler extends Queue {
  claimNext(now: Date): OutboxRow | null;
  recoverInflight(now: Date): void;
}

/**
 * Per-thread FIFO scheduler over the durable outbox.
 *
 * The outbox is the queue; this is only the scheduler over it, so a restart
 * loses nothing (spec §6.1). `Store.claimNextOutbox` enforces the ordering
 * rule in SQL — the oldest live row of a thread, only when that thread has
 * nothing inflight, only when due, and only for agents with a webhook URL.
 *
 * A later row never overtakes an earlier one that is waiting out its backoff;
 * that is what preserves per-thread ordering (CLAUDE.md §1.5) and is the
 * semantics SQS FIFO's MessageGroupId gives at Phase 1.
 */
export function makeScheduler(deps: { store: Store; clock: Clock }): Scheduler {
  /** Threads with a row currently handed out to a worker. */
  const inflightThreads = new Set<string>();

  function release(id: string): OutboxRow | null {
    const row = deps.store.getOutbox(id);
    if (row) inflightThreads.delete(row.thread);
    return row;
  }

  return {
    async enqueue(row: OutboxRow): Promise<void> {
      deps.store.putOutbox(row);
    },

    claimNext(now: Date): OutboxRow | null {
      const candidate = deps.store.claimNextOutbox(now.toISOString());
      if (!candidate) return null;
      // Belt and braces: the SQL excludes threads with an inflight row, and
      // this excludes threads this process has already handed out.
      if (inflightThreads.has(candidate.thread)) return null;
      inflightThreads.add(candidate.thread);
      deps.store.updateOutbox(candidate.id, { state: 'inflight' });
      return { ...candidate, state: 'inflight' };
    },

    async complete(id: string): Promise<void> {
      release(id);
      deps.store.updateOutbox(id, {
        state: 'delivered',
        ackedAt: deps.clock.now().toISOString(),
      });
    },

    /** nextAttemptAt null ⇒ the retry budget is spent; dead-letter the row. */
    async fail(id: string, nextAttemptAt: Date | null): Promise<void> {
      const row = release(id);
      if (nextAttemptAt === null) {
        deps.store.updateOutbox(id, { state: 'dead' });
        return;
      }
      deps.store.updateOutbox(id, {
        state: 'pending',
        attempts: (row?.attempts ?? 0) + 1,
        nextAttemptAt: nextAttemptAt.toISOString(),
      });
    },

    /**
     * After a crash, rows left `inflight` belong to nobody: the worker that
     * claimed them is gone. Return them to pending so they are retried rather
     * than blocking their thread forever.
     */
    recoverInflight(now: Date): void {
      inflightThreads.clear();
      for (const row of deps.store.listInflight()) {
        deps.store.updateOutbox(row.id, {
          state: 'pending',
          nextAttemptAt: now.toISOString(),
        });
      }
    },
  };
}
