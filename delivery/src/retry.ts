/** CLAUDE.md §1: retries back off exponentially with jitter for 24 h, then DLQ. */
export const TOTAL_BUDGET_MS = 24 * 60 * 60 * 1000;
const BASE_MS = 1_000;
const MAX_SINGLE_MS = 60 * 60 * 1000;
const MAX_SHIFT = 32;

function ceilingFor(attempt: number): number {
  return Math.min(BASE_MS * 2 ** Math.min(attempt, MAX_SHIFT), MAX_SINGLE_MS);
}

/**
 * Exponential backoff with full jitter. Returns null once the cumulative budget
 * is spent, which is the signal to dead-letter the row.
 *
 * `spent` is computed from the full ceiling of each prior attempt, an upper
 * bound — so the schedule always terminates rather than creeping past 24 h when
 * jitter happens to come in low every time.
 */
export function nextBackoff(attempts: number, rand: () => number = Math.random): number | null {
  if (attempts < 1) return null;

  let spent = 0;
  for (let i = 1; i < attempts; i += 1) spent += ceilingFor(i);
  if (spent >= TOTAL_BUDGET_MS) return null;

  // Full jitter, floored at 1 ms so a delay is never zero.
  const delay = Math.max(1, Math.floor(rand() * ceilingFor(attempts)));
  return spent + delay > TOTAL_BUDGET_MS ? null : delay;
}
