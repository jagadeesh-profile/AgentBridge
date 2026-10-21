import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every route is classified, and the classification is checked mechanically.
 *
 * Three routes shipped with owner semantics behind `requireAgent`: the kill
 * switch, owner cancel, and (before ADR 0006) the approval decision. Each was
 * found by hand, one at a time, which does not scale and did not work. The
 * guard below fails when a route is added, moved between buckets, or left
 * unclassified, so the next one has to be a deliberate choice rather than an
 * oversight.
 *
 * Read from source rather than from Fastify's route table because the bucket
 * is decided by which helper the handler calls, which only the source shows.
 */

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');

/** method + path -> who may call it. Update deliberately, never to go green. */
const EXPECTED: Record<string, 'open' | 'owner' | 'agent'> = {
  'GET /healthz': 'open',
  // Enrolment: the agent has no key yet, so the OWNER signs it (ADR 0005).
  'POST /v1/agents': 'open',

  // The owner's surface (ADR 0006).
  'GET /v1/agents': 'owner',
  'DELETE /v1/agents/:ref/key': 'owner',
  'GET /v1/tasks': 'owner',
  'DELETE /v1/tasks/:id': 'owner',
  'POST /v1/approvals': 'owner',

  // Agent work.
  'POST /v1/messages': 'agent',
  'POST /v1/tasks': 'agent',
  'GET /v1/tasks/:id': 'agent',
  'PATCH /v1/tasks/:id': 'agent',
  'POST /v1/artifacts': 'agent',
  'GET /v1/inbox': 'agent',
  'POST /v1/inbox/ack': 'agent',

  // Read-only views with owner semantics, still on agent auth. Recorded as a
  // known gap rather than quietly tolerated: both leak workspace-wide state to
  // any single agent. Moving them belongs with the audit viewer.
  'GET /v1/audit/verify': 'agent',
  'GET /v1/dlq': 'agent',
};

/** Every `app.<verb>(...)` registration, with the guard its handler calls. */
function registeredRoutes(): Map<string, 'open' | 'owner' | 'agent'> {
  const found = new Map<string, 'open' | 'owner' | 'agent'>();
  // Match the registration and the body up to the next registration.
  const re =
    /app\.(get|post|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'([\s\S]*?)(?=\n {2}app\.|\n {2}return app;)/g;
  for (const m of SRC.matchAll(re)) {
    const [, verb, path, body] = m;
    const key = `${(verb ?? '').toUpperCase()} ${path ?? ''}`;
    const guard = (body ?? '').includes('requireOwner(req)')
      ? 'owner'
      : (body ?? '').includes('requireAgent(req)')
        ? 'agent'
        : 'open';
    found.set(key, guard);
  }
  return found;
}

describe('route classification', () => {
  const routes = registeredRoutes();

  it('finds every route, so the checks below cannot pass vacuously', () => {
    expect(routes.size).toBe(Object.keys(EXPECTED).length);
  });

  it('classifies each route exactly as declared', () => {
    expect(Object.fromEntries([...routes].sort())).toEqual(
      Object.fromEntries(Object.entries(EXPECTED).sort()),
    );
  });

  it('keeps OWNER_ROUTES in step with the handlers that call requireOwner', () => {
    // Two places must agree: the preHandler decides which routes authenticate
    // the owner, and the handler decides which require one. A route in the
    // first but not the second authenticates nobody useful; in the second but
    // not the first it always 401s. Either way it is broken.
    const declared = new Set(
      [...SRC.matchAll(/\['(GET|POST|PATCH|DELETE)', '([^']+)'\]/g)].map((m) => `${m[1]} ${m[2]}`),
    );
    const enforced = new Set([...routes].filter(([, g]) => g === 'owner').map(([k]) => k));
    expect([...declared].sort()).toEqual([...enforced].sort());
  });

  it('never leaves a destructive route open or agent-authenticated', () => {
    // cancelTaskAsOwner and revokeKey both write audit rows attributed to the
    // owner. An agent reaching them forges that attribution in an append-only,
    // hash-chained log — the damage outlasts the request.
    for (const key of ['DELETE /v1/tasks/:id', 'DELETE /v1/agents/:ref/key']) {
      expect(routes.get(key), key).toBe('owner');
    }
  });
});
