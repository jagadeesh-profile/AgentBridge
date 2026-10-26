/**
 * Phase 0 schema. Kept as a TS string rather than a .sql file so the compiled
 * package carries it without a build step that copies assets.
 */
export const MIGRATION_001 = `
CREATE TABLE agents (
  workspace TEXT NOT NULL, ref TEXT NOT NULL, name TEXT NOT NULL,
  public_key TEXT NOT NULL, webhook_url TEXT, webhook_secret TEXT,
  scopes TEXT NOT NULL, key_status TEXT NOT NULL CHECK (key_status IN ('active','revoked')),
  capabilities TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, ref)
);
CREATE UNIQUE INDEX agents_name ON agents (workspace, name);

CREATE TABLE threads (
  workspace TEXT NOT NULL, id TEXT NOT NULL, turn_count INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE TABLE messages (
  workspace TEXT NOT NULL, id TEXT NOT NULL, thread TEXT NOT NULL, sender TEXT NOT NULL,
  recipients TEXT NOT NULL, type TEXT NOT NULL, task TEXT, body TEXT NOT NULL,
  side_effect INTEGER NOT NULL, trace_id TEXT NOT NULL, sig TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX messages_thread ON messages (workspace, thread, id);

CREATE TABLE tasks (
  workspace TEXT NOT NULL, id TEXT NOT NULL, thread TEXT NOT NULL,
  creator TEXT NOT NULL, assignee TEXT NOT NULL, title TEXT NOT NULL,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL,
  side_effect INTEGER NOT NULL, due_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX tasks_assignee ON tasks (workspace, assignee, state);

CREATE TABLE artifacts (
  workspace TEXT NOT NULL, id TEXT NOT NULL, task TEXT NOT NULL, version INTEGER NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT NOT NULL,
  inline TEXT, blob_key TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, id),
  UNIQUE (workspace, task, name, version)
);

CREATE TABLE approvals (
  workspace TEXT NOT NULL, id TEXT NOT NULL, task TEXT NOT NULL,
  payload_hash TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  issued_at TEXT NOT NULL, sig TEXT NOT NULL, consumed_at TEXT,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX approvals_task ON approvals (workspace, task, consumed_at);

CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, action TEXT NOT NULL,
  actor TEXT NOT NULL, subject TEXT NOT NULL, prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX audit_ws ON audit (workspace, seq);

-- CLAUDE.md §1.9: append-only, enforced by the database rather than by
-- convention. No application code path can update or delete an audit row.
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TABLE outbox (
  id TEXT PRIMARY KEY, workspace TEXT NOT NULL, thread TEXT NOT NULL,
  recipient TEXT NOT NULL, message_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','inflight','delivered','dead')),
  acked_at TEXT, created_at TEXT NOT NULL
);
-- Supports the per-thread claim rule: oldest live row per thread.
CREATE INDEX outbox_live ON outbox (state, thread, id);
CREATE INDEX outbox_inbox ON outbox (workspace, recipient, acked_at, id);

CREATE TABLE idempotency (
  workspace TEXT NOT NULL, agent TEXT NOT NULL, key TEXT NOT NULL,
  request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, agent, key)
);

-- Keyed on the request SIGNATURE, not the timestamp: two distinct requests in
-- the same clock tick must both be allowed, while replaying one identical
-- request must not.
CREATE TABLE nonces (
  agent TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TEXT NOT NULL,
  PRIMARY KEY (agent, nonce)
);
CREATE INDEX nonces_expiry ON nonces (expires_at);
`;

/**
 * The owner's approval queue reads tasks by state, oldest first. `tasks_assignee`
 * leads with `assignee`, so it cannot serve a query that does not know one.
 */
const MIGRATION_002 = `
CREATE INDEX IF NOT EXISTS tasks_state ON tasks (workspace, state, created_at, id);
`;

/**
 * A2A push notification config, one per task.
 *
 * `url` is constrained at the route to share an origin with the agent's
 * registered webhook — the origin the owner signed at enrolment (ADR 0005) —
 * so this table can never name a destination the owner did not authorise.
 * Without that rule it would be an SSRF primitive: an endpoint where a
 * caller picks a URL the hub then POSTs to.
 */
const MIGRATION_003 = `
CREATE TABLE IF NOT EXISTS a2a_push (
  workspace TEXT NOT NULL,
  task TEXT NOT NULL,
  agent_ref TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, task)
);
CREATE INDEX IF NOT EXISTS a2a_push_agent ON a2a_push (workspace, agent_ref);
`;

/**
 * Idempotency becomes a RESERVATION rather than a record of what happened.
 *
 * The old shape stored the response only after `fn()` had run, so two
 * processes could both find no record, both execute — the effect happening
 * twice — and only the second *response* be discarded. CLAUDE.md §1.4 asks for
 * exactly-once effect, not exactly-once response. In-process coalescing hid
 * this while the hub was one container; it stops working the moment delivery
 * splits out, which is the Phase 1 topology.
 *
 * `response` is therefore nullable: a row with NULL means "someone is running
 * this right now". `reserved_at` lets a reservation left behind by a crashed
 * process be reclaimed instead of wedging that key forever.
 *
 * Rebuilt rather than ALTERed because SQLite cannot drop a NOT NULL. Existing
 * rows are preserved as completed, which they are.
 */
const MIGRATION_004 = `
CREATE TABLE idempotency_v2 (
  workspace TEXT NOT NULL, agent TEXT NOT NULL, key TEXT NOT NULL,
  request_hash TEXT NOT NULL, response TEXT, reserved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, agent, key)
);
INSERT INTO idempotency_v2 (workspace, agent, key, request_hash, response, reserved_at, created_at)
  SELECT workspace, agent, key, request_hash, response, created_at, created_at FROM idempotency;
DROP TABLE idempotency;
ALTER TABLE idempotency_v2 RENAME TO idempotency;
`;

export const MIGRATIONS: readonly { readonly id: number; readonly sql: string }[] = [
  { id: 1, sql: MIGRATION_001 },
  { id: 2, sql: MIGRATION_002 },
  { id: 3, sql: MIGRATION_003 },
  { id: 4, sql: MIGRATION_004 },
];
