import { AgentBridgeError } from '@agentbridge/contracts';
import type { Store } from '../ports/index.js';

/**
 * In-flight executions, per Store instance. Keyed by workspace/agent/key.
 *
 * Without this, two concurrent requests sharing one idempotency key both enter
 * the body before either records a response: the second result is discarded,
 * but it has already written its rows. Discarding a duplicate's RESPONSE is not
 * the same as not performing the duplicate's EFFECT, and CLAUDE.md §1.4 asks
 * for the latter. Coalescing onto one promise gives exactly-once in this
 * process, which is the whole hub in Phase 0 (one container, spec §2.1).
 *
 * A WeakMap keyed by the Store keeps this out of module-global state, so tests
 * and multiple hub instances do not share entries.
 */
const inFlight = new WeakMap<Store, Map<string, Promise<unknown>>>();

function flightsFor(store: Store): Map<string, Promise<unknown>> {
  let m = inFlight.get(store);
  if (m === undefined) {
    m = new Map();
    inFlight.set(store, m);
  }
  return m;
}

/**
 * At-least-once delivery, exactly-once effect (CLAUDE.md §1.4).
 *
 * A replay returns the stored response rather than re-executing. A thrown body
 * is never recorded, so a retry after a genuine failure can still succeed.
 */
export async function withIdempotency<T>(
  deps: { store: Store },
  workspace: string,
  agent: string,
  key: string | undefined,
  requestHash: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (key === undefined) return await fn();

  const recorded = deps.store.findIdempotent(workspace, agent, key);
  if (recorded) return replay<T>(recorded, requestHash);

  const flights = flightsFor(deps.store);
  const flightKey = `${workspace}/${agent}/${key}`;

  const running = flights.get(flightKey);
  if (running !== undefined) {
    // Another request with this key is mid-flight. Share its result rather than
    // performing the effect a second time.
    const shared = (await running) as T;
    const after = deps.store.findIdempotent(workspace, agent, key);
    return after ? replay<T>(after, requestHash) : shared;
  }

  const flight = (async () => {
    const result = await fn();
    const won = deps.store.tryPutIdempotent(
      workspace,
      agent,
      key,
      requestHash,
      JSON.stringify(result ?? null),
    );
    if (!won) {
      // Another process won the durable insert. Replay theirs so both callers
      // agree on one answer.
      const theirs = deps.store.findIdempotent(workspace, agent, key);
      if (theirs) return replay<T>(theirs, requestHash);
    }
    return result;
  })();

  flights.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    flights.delete(flightKey);
  }
}

function replay<T>(hit: { requestHash: string; response: string }, requestHash: string): T {
  if (hit.requestHash !== requestHash) {
    throw new AgentBridgeError('idempotency_conflict', 'key reused with a different payload');
  }
  return JSON.parse(hit.response) as T;
}
