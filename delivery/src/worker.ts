import type { Clock, Store } from '@agentbridge/hub/ports';
import { makeScheduler, type Scheduler } from './queue/outbox-scheduler.js';
import { pushOnce, type PushDeps } from './push.js';
import { nextBackoff } from './retry.js';

export interface WorkerDeps extends PushDeps {
  store: Store;
  clock: Clock;
}

export interface Worker {
  /** Drains every currently-claimable row. Returns how many were attempted. */
  tick(): Promise<number>;
  stop(): void;
  readonly scheduler: Scheduler;
}

/**
 * The push worker. In Phase 0 it runs in the hub process; DELIVERY_MODE=worker
 * splits it into its own process with no code change (spec §2.4).
 */
export function makeWorker(deps: WorkerDeps, opts: { intervalMs?: number } = {}): Worker {
  const scheduler = makeScheduler(deps);
  // Rows left inflight by a crashed worker belong to nobody; reclaim them.
  scheduler.recoverInflight(deps.clock.now());

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function tick(): Promise<number> {
    let attempted = 0;
    for (;;) {
      if (stopped) break;
      const row = scheduler.claimNext(deps.clock.now());
      if (!row) break;
      attempted += 1;

      const outcome = await pushOnce(deps, row);
      if (outcome === 'acked') {
        await scheduler.complete(row.id);
      } else if (outcome === 'dead') {
        await scheduler.fail(row.id, null);
      } else {
        const delay = nextBackoff(row.attempts + 1);
        await scheduler.fail(
          row.id,
          delay === null ? null : new Date(deps.clock.now().getTime() + delay),
        );
      }
    }
    return attempted;
  }

  if (opts.intervalMs !== undefined) {
    timer = setInterval(() => {
      void tick();
    }, opts.intervalMs);
    timer.unref();
  }

  return {
    tick,
    stop(): void {
      stopped = true;
      if (timer !== null) clearInterval(timer);
    },
    scheduler,
  };
}
