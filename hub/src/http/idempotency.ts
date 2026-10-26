import { AgentBridgeError } from '@agentbridge/contracts';
import type { Store } from '../ports/index.js';

/**
 * At-least-once delivery, exactly-once **effect** (CLAUDE.md §1.4).
 *
 * The key is reserved in the database *before* the body runs, not after. The
 * earlier shape recorded the response once `fn()` had already returned, which
 * meant two callers could both find no record, both execute — the effect
 * happening twice — and only the loser's *response* be discarded. Discarding
 * a duplicate's response is not the same as not performing its effect.
 *
 * In-process coalescing papered over that while the hub was a single
 * container, and would stop doing so the moment delivery splits into its own
 * process, which is the Phase 1 topology (ADR 0008).
 *
 * The reservation is a single conditional write, so the database decides the
 * race rather than a read-then-write window in application code.
 */

/**
 * How long a reservation may sit unfinished before another caller may take
 * it. Longer than any request the hub will serve — the body is bounded by the
 * HTTP timeout — but short enough that a crashed process does not wedge a key
 * for a human-noticeable time.
 */
export const RESERVATION_STALE_MS = 60_000;

/** How long a caller waits for an in-flight twin before giving up. */
const WAIT_TOTAL_MS = 5_000;
const WAIT_STEP_MS = 25;

export async function withIdempotency<T>(
  deps: { store: Store },
  workspace: string,
  agent: string,
  key: string | undefined,
  requestHash: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (key === undefined) return await fn();

  const outcome = deps.store.reserveIdempotent(
    workspace,
    agent,
    key,
    requestHash,
    new Date(),
    RESERVATION_STALE_MS,
  );

  if (outcome.kind === 'replay') return replay<T>(outcome.hit, requestHash);

  if (outcome.kind === 'in-flight') {
    // Someone else holds the reservation. Wait for their answer rather than
    // performing the effect again — that is the entire point.
    const hit = await waitForCompletion(deps.store, workspace, agent, key);
    if (hit) return replay<T>(hit, requestHash);
    // Still unfinished after the wait. Reporting a conflict is wrong (nothing
    // conflicts) and executing is wrong (the twin may yet succeed), so this
    // is a retryable refusal.
    throw new AgentBridgeError(
      'rate_limited',
      'another request with this idempotency key is still in flight; retry shortly',
    );
  }

  // We hold the reservation.
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    // Release so a genuine failure can be retried. Without this, one failed
    // attempt would make the key permanently unusable until it went stale.
    deps.store.releaseIdempotent(workspace, agent, key);
    throw err;
  }

  deps.store.completeIdempotent(workspace, agent, key, JSON.stringify(result ?? null), new Date());
  return result;
}

async function waitForCompletion(
  store: Store,
  workspace: string,
  agent: string,
  key: string,
): Promise<{ requestHash: string; response: string } | null> {
  const deadline = Date.now() + WAIT_TOTAL_MS;
  for (;;) {
    const hit = store.findIdempotent(workspace, agent, key);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
}

function replay<T>(hit: { requestHash: string; response: string }, requestHash: string): T {
  if (hit.requestHash !== requestHash) {
    throw new AgentBridgeError('idempotency_conflict', 'key reused with a different payload');
  }
  return JSON.parse(hit.response) as T;
}
