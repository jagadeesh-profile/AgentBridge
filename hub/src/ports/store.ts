import type { Scope, TaskState } from '@agentbridge/contracts';

export interface AgentRecord {
  ref: string;
  workspace: string;
  name: string;
  publicKey: string;
  webhookUrl: string | null;
  webhookSecret: string | null;
  scopes: readonly Scope[];
  keyStatus: 'active' | 'revoked';
  capabilities: unknown;
  createdAt: string;
}

export interface ThreadRecord {
  id: string;
  workspace: string;
  turnCount: number;
  paused: boolean;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  workspace: string;
  thread: string;
  from: string;
  to: readonly string[];
  type: string;
  task: string | null;
  body: unknown;
  sideEffect: boolean;
  traceId: string;
  sig: string;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  workspace: string;
  thread: string;
  creator: string;
  assignee: string;
  title: string;
  payload: unknown;
  payloadHash: string;
  state: TaskState;
  sideEffect: boolean;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  workspace: string;
  task: string;
  version: number;
  kind: 'text' | 'json' | 'file' | 'link';
  name: string;
  contentType: string;
  inline: unknown;
  blobKey: string | null;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  workspace: string;
  task: string;
  payloadHash: string;
  decision: 'approve' | 'reject';
  issuedAt: string;
  sig: string;
  consumedAt: string | null;
}

export interface AuditRow {
  seq: number;
  workspace: string;
  action: string;
  actor: string;
  subject: string;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface OutboxRow {
  id: string;
  workspace: string;
  thread: string;
  recipient: string;
  messageId: string;
  attempts: number;
  nextAttemptAt: string;
  state: 'pending' | 'inflight' | 'delivered' | 'dead';
  ackedAt: string | null;
  createdAt: string;
}

export interface IdempotencyHit {
  response: string;
  requestHash: string;
}

/**
 * The hub's whole persistence surface. Every method is scoped by `workspace`,
 * so a cross-workspace read is not expressible (FR-2).
 *
 * `transaction` is synchronous because better-sqlite3 is. That is what lets the
 * task row, the audit row and the outbox row be written atomically with no
 * async interleaving (spec §3 step 4).
 */
export interface Store {
  /** Runs fn inside one transaction. A nested call joins the outer transaction. */
  transaction<T>(fn: () => T): T;

  // registry
  putAgent(a: AgentRecord): void;
  getAgent(workspace: string, ref: string): AgentRecord | null;
  listAgents(workspace: string): readonly AgentRecord[];
  setKeyStatus(workspace: string, ref: string, status: 'active' | 'revoked'): void;

  // threads and messages
  upsertThread(t: ThreadRecord): void;
  getThread(workspace: string, id: string): ThreadRecord | null;
  bumpTurn(workspace: string, id: string): number;
  setThreadPaused(workspace: string, id: string, paused: boolean): void;
  putMessage(m: MessageRecord): void;
  getMessage(workspace: string, id: string): MessageRecord | null;

  // tasks
  putTask(t: TaskRecord): void;
  getTask(workspace: string, id: string): TaskRecord | null;
  setTaskState(workspace: string, id: string, state: TaskState, updatedAt: string): void;

  // artifacts
  putArtifact(a: ArtifactRecord): void;
  nextArtifactVersion(workspace: string, task: string, name: string): number;
  listArtifacts(workspace: string, task: string): readonly ArtifactRecord[];

  // approvals
  putApproval(a: ApprovalRecord): void;
  findUnconsumedApproval(workspace: string, task: string): ApprovalRecord | null;
  findAnyApproval(workspace: string, task: string): ApprovalRecord | null;
  consumeApproval(workspace: string, id: string, at: string): boolean;

  // audit — append only
  appendAudit(row: Omit<AuditRow, 'seq'>): void;
  lastAuditHash(workspace: string): string;
  listAudit(workspace: string, fromSeq: number, limit: number): readonly AuditRow[];

  // outbox
  putOutbox(row: OutboxRow): void;
  getOutbox(id: string): OutboxRow | null;
  /**
   * The oldest non-terminal row of a thread that has nothing in flight, and
   * only if that row is due. Returning a later row while an earlier one waits
   * out its backoff would break per-thread ordering (CLAUDE.md §1.5).
   * Only rows addressed to agents with a webhook URL are candidates: pull-only
   * agents read their inbox instead and must not burn retry budget.
   */
  claimNextOutbox(now: string): OutboxRow | null;
  listInflight(): readonly OutboxRow[];
  updateOutbox(
    id: string,
    patch: Partial<Pick<OutboxRow, 'attempts' | 'nextAttemptAt' | 'state' | 'ackedAt'>>,
  ): void;
  listInbox(
    workspace: string,
    recipient: string,
    since: string | null,
    limit: number,
  ): readonly OutboxRow[];
  listDead(workspace: string): readonly OutboxRow[];
  ackInboxUpTo(workspace: string, recipient: string, upTo: string, at: string): number;
  dropPendingFor(workspace: string, recipient: string): number;

  // idempotency
  findIdempotent(workspace: string, agent: string, key: string): IdempotencyHit | null;
  /** Returns false if the key already exists — the caller then reads it back. */
  tryPutIdempotent(
    workspace: string,
    agent: string,
    key: string,
    requestHash: string,
    response: string,
  ): boolean;

  // replay window
  seenNonce(agent: string, timestamp: string): boolean;
  recordNonce(agent: string, timestamp: string, expiresAt: string): void;
  pruneNonces(now: string): void;

  close(): void;
}
