import { DatabaseSync } from 'node:sqlite';
import type { TaskState } from '@agentbridge/contracts';
import type {
  AgentRecord,
  ApprovalRecord,
  ArtifactRecord,
  AuditRow,
  MessageRecord,
  OutboxRow,
  Store,
  TaskRecord,
  ThreadRecord,
} from '../../ports/index.js';
import { MIGRATIONS } from './migrations.js';

export interface SqliteStore extends Store {
  /**
   * Escape hatch for migrations and for tests that must prove a DB-level
   * constraint (e.g. the audit triggers). Not part of the Store port, so the
   * domain cannot reach it.
   */
  exec(sql: string): void;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v));
const nullableStr = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const bool = (v: unknown): boolean => num(v) !== 0;
const json = <T>(v: unknown): T => JSON.parse(str(v)) as T;

/** Shared by getTask and listTasksByState so the two cannot drift apart. */
const taskFrom = (r: Row): TaskRecord => ({
  id: str(r.id),
  workspace: str(r.workspace),
  thread: str(r.thread),
  creator: str(r.creator),
  assignee: str(r.assignee),
  title: str(r.title),
  payload: json<unknown>(r.payload),
  payloadHash: str(r.payload_hash),
  state: str(r.state) as TaskState,
  sideEffect: bool(r.side_effect),
  dueAt: nullableStr(r.due_at),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

export function openStore(path: string): SqliteStore {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);

  let depth = 0;

  const toAgent = (r: Row): AgentRecord => ({
    ref: str(r.ref),
    workspace: str(r.workspace),
    name: str(r.name),
    publicKey: str(r.public_key),
    webhookUrl: nullableStr(r.webhook_url),
    webhookSecret: nullableStr(r.webhook_secret),
    scopes: json<AgentRecord['scopes']>(r.scopes),
    keyStatus: str(r.key_status) === 'revoked' ? 'revoked' : 'active',
    capabilities: json<unknown>(r.capabilities),
    createdAt: str(r.created_at),
  });

  const toOutbox = (r: Row): OutboxRow => ({
    id: str(r.id),
    workspace: str(r.workspace),
    thread: str(r.thread),
    recipient: str(r.recipient),
    messageId: str(r.message_id),
    attempts: num(r.attempts),
    nextAttemptAt: str(r.next_attempt_at),
    state: str(r.state) as OutboxRow['state'],
    ackedAt: nullableStr(r.acked_at),
    createdAt: str(r.created_at),
  });

  const store: SqliteStore = {
    exec(sql: string): void {
      db.exec(sql);
    },

    transaction<T>(fn: () => T): T {
      // A nested call joins the outer transaction, matching the fake.
      if (depth > 0) {
        depth += 1;
        try {
          return fn();
        } finally {
          depth -= 1;
        }
      }
      db.exec('BEGIN');
      depth = 1;
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth = 0;
      }
    },

    putAgent(a: AgentRecord): void {
      db.prepare(
        `INSERT INTO agents (workspace, ref, name, public_key, webhook_url, webhook_secret,
           scopes, key_status, capabilities, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (workspace, ref) DO UPDATE SET
           name=excluded.name, public_key=excluded.public_key,
           webhook_url=excluded.webhook_url, webhook_secret=excluded.webhook_secret,
           scopes=excluded.scopes, key_status=excluded.key_status,
           capabilities=excluded.capabilities`,
      ).run(
        a.workspace,
        a.ref,
        a.name,
        a.publicKey,
        a.webhookUrl,
        a.webhookSecret,
        JSON.stringify(a.scopes),
        a.keyStatus,
        JSON.stringify(a.capabilities ?? null),
        a.createdAt,
      );
    },
    getAgent(workspace, ref) {
      const r = db.prepare('SELECT * FROM agents WHERE workspace=? AND ref=?').get(workspace, ref);
      return r ? toAgent(r as Row) : null;
    },
    listAgents(workspace) {
      return db
        .prepare('SELECT * FROM agents WHERE workspace=? ORDER BY ref')
        .all(workspace)
        .map((r) => toAgent(r as Row));
    },
    setKeyStatus(workspace, ref, status) {
      db.prepare('UPDATE agents SET key_status=? WHERE workspace=? AND ref=?').run(
        status,
        workspace,
        ref,
      );
    },

    upsertThread(t: ThreadRecord): void {
      db.prepare(
        `INSERT INTO threads (workspace, id, turn_count, paused, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT (workspace, id) DO NOTHING`,
      ).run(t.workspace, t.id, t.turnCount, t.paused ? 1 : 0, t.createdAt);
    },
    getThread(workspace, id) {
      const r = db.prepare('SELECT * FROM threads WHERE workspace=? AND id=?').get(workspace, id);
      if (!r) return null;
      const row = r as Row;
      return {
        id: str(row.id),
        workspace: str(row.workspace),
        turnCount: num(row.turn_count),
        paused: bool(row.paused),
        createdAt: str(row.created_at),
      };
    },
    bumpTurn(workspace, id) {
      db.prepare('UPDATE threads SET turn_count = turn_count + 1 WHERE workspace=? AND id=?').run(
        workspace,
        id,
      );
      const r = db
        .prepare('SELECT turn_count FROM threads WHERE workspace=? AND id=?')
        .get(workspace, id);
      return r ? num((r as Row).turn_count) : 0;
    },
    setThreadPaused(workspace, id, paused) {
      db.prepare('UPDATE threads SET paused=? WHERE workspace=? AND id=?').run(
        paused ? 1 : 0,
        workspace,
        id,
      );
    },
    putMessage(m: MessageRecord): void {
      db.prepare(
        `INSERT INTO messages (workspace, id, thread, sender, recipients, type, task, body,
           side_effect, trace_id, sig, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        m.workspace,
        m.id,
        m.thread,
        m.from,
        JSON.stringify(m.to),
        m.type,
        m.task,
        JSON.stringify(m.body ?? null),
        m.sideEffect ? 1 : 0,
        m.traceId,
        m.sig,
        m.createdAt,
      );
    },
    getMessage(workspace, id) {
      const r = db.prepare('SELECT * FROM messages WHERE workspace=? AND id=?').get(workspace, id);
      if (!r) return null;
      const row = r as Row;
      return {
        id: str(row.id),
        workspace: str(row.workspace),
        thread: str(row.thread),
        from: str(row.sender),
        to: json<string[]>(row.recipients),
        type: str(row.type),
        task: nullableStr(row.task),
        body: json<unknown>(row.body),
        sideEffect: bool(row.side_effect),
        traceId: str(row.trace_id),
        sig: str(row.sig),
        createdAt: str(row.created_at),
      };
    },

    putTask(t: TaskRecord): void {
      db.prepare(
        `INSERT INTO tasks (workspace, id, thread, creator, assignee, title, payload,
           payload_hash, state, side_effect, due_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (workspace, id) DO UPDATE SET
           payload=excluded.payload, payload_hash=excluded.payload_hash,
           state=excluded.state, updated_at=excluded.updated_at`,
      ).run(
        t.workspace,
        t.id,
        t.thread,
        t.creator,
        t.assignee,
        t.title,
        JSON.stringify(t.payload ?? null),
        t.payloadHash,
        t.state,
        t.sideEffect ? 1 : 0,
        t.dueAt,
        t.createdAt,
        t.updatedAt,
      );
    },
    getTask(workspace, id) {
      const r = db.prepare('SELECT * FROM tasks WHERE workspace=? AND id=?').get(workspace, id);
      return r ? taskFrom(r as Row) : null;
    },
    listTasksByState(workspace, state, limit) {
      // Oldest first: the owner's queue is FIFO, so whatever has been blocking
      // longest is at the top. `id` breaks ties for a total order.
      const rows =
        state === null
          ? db
              .prepare(
                'SELECT * FROM tasks WHERE workspace=? ORDER BY created_at ASC, id ASC LIMIT ?',
              )
              .all(workspace, limit)
          : db
              .prepare(
                `SELECT * FROM tasks WHERE workspace=? AND state=?
                 ORDER BY created_at ASC, id ASC LIMIT ?`,
              )
              .all(workspace, state, limit);
      return (rows as Row[]).map(taskFrom);
    },
    setTaskState(workspace, id, state, updatedAt) {
      db.prepare('UPDATE tasks SET state=?, updated_at=? WHERE workspace=? AND id=?').run(
        state,
        updatedAt,
        workspace,
        id,
      );
    },

    putPushConfig(row) {
      db.prepare(
        `INSERT INTO a2a_push (workspace, task, agent_ref, url, token, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (workspace, task) DO UPDATE SET
           agent_ref=excluded.agent_ref, url=excluded.url, token=excluded.token`,
      ).run(row.workspace, row.task, row.agentRef, row.url, row.token, row.createdAt);
    },
    getPushConfig(workspace, task) {
      const r = db
        .prepare('SELECT * FROM a2a_push WHERE workspace=? AND task=?')
        .get(workspace, task);
      if (!r) return null;
      const row = r as Row;
      return {
        workspace: str(row.workspace),
        task: str(row.task),
        agentRef: str(row.agent_ref),
        url: str(row.url),
        token: nullableStr(row.token),
        createdAt: str(row.created_at),
      };
    },

    putArtifact(a: ArtifactRecord): void {
      db.prepare(
        `INSERT INTO artifacts (workspace, id, task, version, kind, name, content_type,
           inline, blob_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        a.workspace,
        a.id,
        a.task,
        a.version,
        a.kind,
        a.name,
        a.contentType,
        a.inline === undefined ? null : JSON.stringify(a.inline),
        a.blobKey,
        a.createdAt,
      );
    },
    nextArtifactVersion(workspace, task, name) {
      const r = db
        .prepare(
          'SELECT COALESCE(MAX(version), 0) AS v FROM artifacts WHERE workspace=? AND task=? AND name=?',
        )
        .get(workspace, task, name);
      return num((r as Row).v) + 1;
    },
    listArtifacts(workspace, task) {
      return db
        .prepare('SELECT * FROM artifacts WHERE workspace=? AND task=? ORDER BY id')
        .all(workspace, task)
        .map((r): ArtifactRecord => {
          const row = r as Row;
          return {
            id: str(row.id),
            workspace: str(row.workspace),
            task: str(row.task),
            version: num(row.version),
            kind: str(row.kind) as ArtifactRecord['kind'],
            name: str(row.name),
            contentType: str(row.content_type),
            inline: row.inline === null ? null : json<unknown>(row.inline),
            blobKey: nullableStr(row.blob_key),
            createdAt: str(row.created_at),
          };
        });
    },

    putApproval(a: ApprovalRecord): void {
      db.prepare(
        `INSERT INTO approvals (workspace, id, task, payload_hash, decision, issued_at, sig, consumed_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(a.workspace, a.id, a.task, a.payloadHash, a.decision, a.issuedAt, a.sig, a.consumedAt);
    },
    findUnconsumedApproval(workspace, task) {
      const r = db
        .prepare(
          'SELECT * FROM approvals WHERE workspace=? AND task=? AND consumed_at IS NULL LIMIT 1',
        )
        .get(workspace, task);
      return r ? toApproval(r as Row) : null;
    },
    findAnyApproval(workspace, task) {
      const r = db
        .prepare('SELECT * FROM approvals WHERE workspace=? AND task=? LIMIT 1')
        .get(workspace, task);
      return r ? toApproval(r as Row) : null;
    },
    consumeApproval(workspace, id, at) {
      const res = db
        .prepare(
          'UPDATE approvals SET consumed_at=? WHERE workspace=? AND id=? AND consumed_at IS NULL',
        )
        .run(at, workspace, id);
      return num(res.changes) === 1;
    },

    appendAudit(row: Omit<AuditRow, 'seq'>): void {
      db.prepare(
        `INSERT INTO audit (workspace, action, actor, subject, prev_hash, hash, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(
        row.workspace,
        row.action,
        row.actor,
        row.subject,
        row.prevHash,
        row.hash,
        row.createdAt,
      );
    },
    lastAuditHash(workspace) {
      const r = db
        .prepare('SELECT hash FROM audit WHERE workspace=? ORDER BY seq DESC LIMIT 1')
        .get(workspace);
      return r ? str((r as Row).hash) : '';
    },
    listAudit(workspace, fromSeq, limit) {
      return db
        .prepare('SELECT * FROM audit WHERE workspace=? AND seq>? ORDER BY seq LIMIT ?')
        .all(workspace, fromSeq, limit)
        .map((r): AuditRow => {
          const row = r as Row;
          return {
            seq: num(row.seq),
            workspace: str(row.workspace),
            action: str(row.action),
            actor: str(row.actor),
            subject: str(row.subject),
            prevHash: str(row.prev_hash),
            hash: str(row.hash),
            createdAt: str(row.created_at),
          };
        });
    },

    putOutbox(row: OutboxRow): void {
      db.prepare(
        `INSERT INTO outbox (id, workspace, thread, recipient, message_id, attempts,
           next_attempt_at, state, acked_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.id,
        row.workspace,
        row.thread,
        row.recipient,
        row.messageId,
        row.attempts,
        row.nextAttemptAt,
        row.state,
        row.ackedAt,
        row.createdAt,
      );
    },
    getOutbox(id) {
      const r = db.prepare('SELECT * FROM outbox WHERE id=?').get(id);
      return r ? toOutbox(r as Row) : null;
    },
    /**
     * The oldest live row of each thread, skipping threads that already have
     * something inflight, and only if that row is due. A later row must never
     * overtake an earlier one waiting out its backoff (CLAUDE.md §1.5).
     * Pull-only agents (no webhook_url) are excluded: they read their inbox.
     */
    claimNextOutbox(now) {
      const r = db
        .prepare(
          `SELECT o.* FROM outbox o
             JOIN agents a ON a.workspace = o.workspace AND a.ref = o.recipient
            WHERE o.state = 'pending'
              AND a.webhook_url IS NOT NULL
              AND o.next_attempt_at <= ?
              AND o.id = (SELECT MIN(i.id) FROM outbox i
                           WHERE i.thread = o.thread
                             AND i.workspace = o.workspace
                             AND i.state IN ('pending','inflight'))
              AND NOT EXISTS (SELECT 1 FROM outbox f
                               WHERE f.thread = o.thread
                                 AND f.workspace = o.workspace
                                 AND f.state = 'inflight')
            ORDER BY o.id LIMIT 1`,
        )
        .get(now);
      return r ? toOutbox(r as Row) : null;
    },
    listInflight() {
      return db
        .prepare("SELECT * FROM outbox WHERE state='inflight' ORDER BY id")
        .all()
        .map((r) => toOutbox(r as Row));
    },
    updateOutbox(id, patch) {
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      if (patch.attempts !== undefined) {
        sets.push('attempts=?');
        args.push(patch.attempts);
      }
      if (patch.nextAttemptAt !== undefined) {
        sets.push('next_attempt_at=?');
        args.push(patch.nextAttemptAt);
      }
      if (patch.state !== undefined) {
        sets.push('state=?');
        args.push(patch.state);
      }
      if (patch.ackedAt !== undefined) {
        sets.push('acked_at=?');
        args.push(patch.ackedAt);
      }
      if (sets.length === 0) return;
      args.push(id);
      db.prepare(`UPDATE outbox SET ${sets.join(', ')} WHERE id=?`).run(...args);
    },
    listInbox(workspace, recipient, since, limit) {
      return db
        .prepare(
          `SELECT * FROM outbox
            WHERE workspace=? AND recipient=? AND acked_at IS NULL AND state != 'dead'
              AND (? IS NULL OR id > ?)
            ORDER BY id LIMIT ?`,
        )
        .all(workspace, recipient, since, since, limit)
        .map((r) => toOutbox(r as Row));
    },
    listDead(workspace) {
      return db
        .prepare("SELECT * FROM outbox WHERE workspace=? AND state='dead' ORDER BY id")
        .all(workspace)
        .map((r) => toOutbox(r as Row));
    },
    ackInboxUpTo(workspace, recipient, upTo, at) {
      const res = db
        .prepare(
          `UPDATE outbox SET acked_at=?, state='delivered'
            WHERE workspace=? AND recipient=? AND acked_at IS NULL AND state != 'dead' AND id <= ?`,
        )
        .run(at, workspace, recipient, upTo);
      return num(res.changes);
    },
    dropPendingFor(workspace, recipient) {
      const res = db
        .prepare(
          "DELETE FROM outbox WHERE workspace=? AND recipient=? AND state IN ('pending','inflight')",
        )
        .run(workspace, recipient);
      return num(res.changes);
    },

    findIdempotent(workspace, agent, key) {
      const r = db
        .prepare(
          `SELECT request_hash, response FROM idempotency
           WHERE workspace=? AND agent=? AND key=? AND response IS NOT NULL`,
        )
        .get(workspace, agent, key);
      if (!r) return null;
      const row = r as Row;
      return { requestHash: str(row.request_hash), response: str(row.response) };
    },

    /**
     * One statement decides the race. INSERT ... ON CONFLICT DO UPDATE with a
     * WHERE clause claims the row only when it is free — unreserved, or
     * reserved so long ago the holder must be gone — so two processes
     * attempting it concurrently cannot both win.
     */
    reserveIdempotent(workspace, agent, key, requestHash, now, staleAfterMs) {
      const nowIso = now.toISOString();
      const staleBefore = new Date(now.getTime() - staleAfterMs).toISOString();
      const res = db
        .prepare(
          `INSERT INTO idempotency (workspace, agent, key, request_hash, response,
             reserved_at, created_at)
           VALUES (?,?,?,?,NULL,?,?)
           ON CONFLICT (workspace, agent, key) DO UPDATE SET
             reserved_at = excluded.reserved_at,
             request_hash = excluded.request_hash
           WHERE idempotency.response IS NULL AND idempotency.reserved_at < ?`,
        )
        .run(workspace, agent, key, requestHash, nowIso, nowIso, staleBefore);

      if (num(res.changes) === 1) return { kind: 'reserved' };

      const existing = store.findIdempotent(workspace, agent, key);
      if (existing) return { kind: 'replay', hit: existing };
      return { kind: 'in-flight' };
    },

    completeIdempotent(workspace, agent, key, response, now) {
      db.prepare(
        `UPDATE idempotency SET response=?, created_at=?
         WHERE workspace=? AND agent=? AND key=?`,
      ).run(response, now.toISOString(), workspace, agent, key);
    },

    releaseIdempotent(workspace, agent, key) {
      // Only an uncompleted reservation: a completed record must survive.
      db.prepare(
        'DELETE FROM idempotency WHERE workspace=? AND agent=? AND key=? AND response IS NULL',
      ).run(workspace, agent, key);
    },
    /** The database decides the race, closing the read-then-write window. */
    tryPutIdempotent(workspace, agent, key, requestHash, response) {
      const res = db
        .prepare(
          `INSERT INTO idempotency (workspace, agent, key, request_hash, response,
             reserved_at, created_at)
           VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
        )
        .run(
          workspace,
          agent,
          key,
          requestHash,
          response,
          new Date(0).toISOString(),
          new Date(0).toISOString(),
        );
      return num(res.changes) === 1;
    },

    seenNonce(agent, nonce) {
      return (
        db.prepare('SELECT 1 FROM nonces WHERE agent=? AND nonce=?').get(agent, nonce) !== undefined
      );
    },
    recordNonce(agent, nonce, expiresAt) {
      db.prepare(
        'INSERT INTO nonces (agent, nonce, expires_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
      ).run(agent, nonce, expiresAt);
    },
    pruneNonces(now) {
      db.prepare('DELETE FROM nonces WHERE expires_at <= ?').run(now);
    },

    close() {
      db.close();
    },
  };

  return store;
}

function toApproval(row: Row): ApprovalRecord {
  return {
    id: str(row.id),
    workspace: str(row.workspace),
    task: str(row.task),
    payloadHash: str(row.payload_hash),
    decision: str(row.decision) as ApprovalRecord['decision'],
    issuedAt: str(row.issued_at),
    sig: str(row.sig),
    consumedAt: nullableStr(row.consumed_at),
  };
}

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY)');
  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_version')
      .all()
      .map((r) => num((r as Row).id)),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (id) VALUES (?)').run(m.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
