import type { TaskState } from '@agentbridge/contracts';
import type {
  AgentRecord,
  ApprovalRecord,
  ArtifactRecord,
  AuditRow,
  BlobStore,
  Clock,
  IdGen,
  IdempotencyHit,
  MessageRecord,
  OutboxRow,
  Signer,
  Store,
  TaskRecord,
  ThreadRecord,
} from '../index.js';

export class FakeClock implements Clock {
  constructor(private t = new Date('2026-10-20T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export class FakeIds implements IdGen {
  private n = 0;
  ulid(prefix: string): string {
    this.n += 1;
    return `${prefix}_${String(this.n).padStart(26, '0')}`;
  }
}

class FakeBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(key, new Uint8Array(bytes));
  }
  async get(key: string): Promise<Uint8Array> {
    const found = this.blobs.get(key);
    if (!found) throw new Error(`no such blob: ${key}`);
    return new Uint8Array(found);
  }
}

class FakeSigner implements Signer {
  async sign(): Promise<string> {
    return 'ed25519:FAKE';
  }
  async publicKey(): Promise<Uint8Array> {
    return new Uint8Array(32);
  }
}

const key = (workspace: string, id: string): string => `${workspace}/${id}`;

/**
 * Map-backed Store. `transaction` snapshots every collection and restores the
 * snapshots on throw, so rollback semantics match SQLite — which is what makes
 * the domain's atomicity tests meaningful against the fake (spec §4.1).
 */
export class FakeStore implements Store {
  private agents = new Map<string, AgentRecord>();
  private threads = new Map<string, ThreadRecord>();
  private messages = new Map<string, MessageRecord>();
  private tasks = new Map<string, TaskRecord>();
  private artifacts = new Map<string, ArtifactRecord>();
  private approvals = new Map<string, ApprovalRecord>();
  private audit: AuditRow[] = [];
  private outbox = new Map<string, OutboxRow>();
  private idempotency = new Map<string, IdempotencyHit>();
  private nonces = new Map<string, string>();
  private depth = 0;

  transaction<T>(fn: () => T): T {
    // A nested call joins the outer transaction: only the outermost snapshots.
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    }

    const snapshot = {
      agents: new Map(this.agents),
      threads: new Map(this.threads),
      messages: new Map(this.messages),
      tasks: new Map(this.tasks),
      artifacts: new Map(this.artifacts),
      approvals: new Map(this.approvals),
      audit: [...this.audit],
      outbox: new Map(this.outbox),
      idempotency: new Map(this.idempotency),
      nonces: new Map(this.nonces),
    };

    this.depth = 1;
    try {
      return fn();
    } catch (err) {
      this.agents = snapshot.agents;
      this.threads = snapshot.threads;
      this.messages = snapshot.messages;
      this.tasks = snapshot.tasks;
      this.artifacts = snapshot.artifacts;
      this.approvals = snapshot.approvals;
      this.audit = snapshot.audit;
      this.outbox = snapshot.outbox;
      this.idempotency = snapshot.idempotency;
      this.nonces = snapshot.nonces;
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  putAgent(a: AgentRecord): void {
    this.agents.set(key(a.workspace, a.ref), { ...a, scopes: [...a.scopes] });
  }
  getAgent(workspace: string, ref: string): AgentRecord | null {
    return this.agents.get(key(workspace, ref)) ?? null;
  }
  listAgents(workspace: string): readonly AgentRecord[] {
    return [...this.agents.values()].filter((a) => a.workspace === workspace);
  }
  setKeyStatus(workspace: string, ref: string, status: 'active' | 'revoked'): void {
    const found = this.agents.get(key(workspace, ref));
    if (found) this.agents.set(key(workspace, ref), { ...found, keyStatus: status });
  }

  upsertThread(t: ThreadRecord): void {
    this.threads.set(key(t.workspace, t.id), { ...t });
  }
  getThread(workspace: string, id: string): ThreadRecord | null {
    return this.threads.get(key(workspace, id)) ?? null;
  }
  bumpTurn(workspace: string, id: string): number {
    const found = this.threads.get(key(workspace, id));
    if (!found) return 0;
    const next = { ...found, turnCount: found.turnCount + 1 };
    this.threads.set(key(workspace, id), next);
    return next.turnCount;
  }
  setThreadPaused(workspace: string, id: string, paused: boolean): void {
    const found = this.threads.get(key(workspace, id));
    if (found) this.threads.set(key(workspace, id), { ...found, paused });
  }
  putMessage(m: MessageRecord): void {
    this.messages.set(key(m.workspace, m.id), { ...m, to: [...m.to] });
  }
  getMessage(workspace: string, id: string): MessageRecord | null {
    return this.messages.get(key(workspace, id)) ?? null;
  }

  putTask(t: TaskRecord): void {
    this.tasks.set(key(t.workspace, t.id), { ...t });
  }
  getTask(workspace: string, id: string): TaskRecord | null {
    return this.tasks.get(key(workspace, id)) ?? null;
  }
  setTaskState(workspace: string, id: string, state: TaskState, updatedAt: string): void {
    const found = this.tasks.get(key(workspace, id));
    if (found) this.tasks.set(key(workspace, id), { ...found, state, updatedAt });
  }
  listTasksByState(
    workspace: string,
    state: TaskState | null,
    limit: number,
  ): readonly TaskRecord[] {
    return (
      [...this.tasks.values()]
        .filter((t) => t.workspace === workspace && (state === null || t.state === state))
        // Same total order as the SQLite adapter: oldest first, id breaking ties.
        // A fake that ordered differently would let a test pass here and fail in
        // the real store.
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((t) => ({ ...t }))
    );
  }

  putArtifact(a: ArtifactRecord): void {
    this.artifacts.set(key(a.workspace, a.id), { ...a });
  }
  nextArtifactVersion(workspace: string, task: string, name: string): number {
    const versions = [...this.artifacts.values()]
      .filter((a) => a.workspace === workspace && a.task === task && a.name === name)
      .map((a) => a.version);
    return versions.length === 0 ? 1 : Math.max(...versions) + 1;
  }
  listArtifacts(workspace: string, task: string): readonly ArtifactRecord[] {
    return [...this.artifacts.values()]
      .filter((a) => a.workspace === workspace && a.task === task)
      .sort((x, y) => (x.id < y.id ? -1 : 1));
  }

  putApproval(a: ApprovalRecord): void {
    this.approvals.set(key(a.workspace, a.id), { ...a });
  }
  findUnconsumedApproval(workspace: string, task: string): ApprovalRecord | null {
    return (
      [...this.approvals.values()].find(
        (a) => a.workspace === workspace && a.task === task && a.consumedAt === null,
      ) ?? null
    );
  }
  findAnyApproval(workspace: string, task: string): ApprovalRecord | null {
    return (
      [...this.approvals.values()].find((a) => a.workspace === workspace && a.task === task) ?? null
    );
  }
  consumeApproval(workspace: string, id: string, at: string): boolean {
    const found = this.approvals.get(key(workspace, id));
    if (!found || found.consumedAt !== null) return false;
    this.approvals.set(key(workspace, id), { ...found, consumedAt: at });
    return true;
  }

  /**
   * Overwrites a stored audit row in place, simulating tampering at the
   * storage layer — someone editing the database file, not calling the API.
   * SQLite triggers block UPDATE and DELETE through the hub, which is exactly
   * why the hash chain exists: it is the defence against the edit that does
   * not go through the hub at all. Tests only.
   */
  replaceAuditRowForTest(row: AuditRow): void {
    const i = this.audit.findIndex((r) => r.workspace === row.workspace && r.seq === row.seq);
    if (i >= 0) this.audit[i] = { ...row };
  }

  appendAudit(row: Omit<AuditRow, 'seq'>): void {
    this.audit.push({ ...row, seq: this.audit.length + 1 });
  }
  lastAuditHash(workspace: string): string {
    const rows = this.audit.filter((r) => r.workspace === workspace);
    return rows.length === 0 ? '' : (rows[rows.length - 1]?.hash ?? '');
  }
  listAudit(workspace: string, fromSeq: number, limit: number): readonly AuditRow[] {
    return this.audit.filter((r) => r.workspace === workspace && r.seq > fromSeq).slice(0, limit);
  }

  putOutbox(row: OutboxRow): void {
    this.outbox.set(row.id, { ...row });
  }
  getOutbox(id: string): OutboxRow | null {
    return this.outbox.get(id) ?? null;
  }
  claimNextOutbox(now: string): OutboxRow | null {
    const live = [...this.outbox.values()]
      .filter((r) => r.state === 'pending' || r.state === 'inflight')
      .sort((a, b) => (a.id < b.id ? -1 : 1));

    const blocked = new Set(live.filter((r) => r.state === 'inflight').map((r) => r.thread));
    const seenThread = new Set<string>();

    for (const row of live) {
      // Only the oldest live row of each thread is ever a candidate.
      if (seenThread.has(row.thread)) continue;
      seenThread.add(row.thread);
      if (blocked.has(row.thread)) continue;
      if (row.nextAttemptAt > now) continue;
      const agent = this.getAgent(row.workspace, row.recipient);
      if (!agent?.webhookUrl) continue;
      return row;
    }
    return null;
  }
  listInflight(): readonly OutboxRow[] {
    return [...this.outbox.values()].filter((r) => r.state === 'inflight');
  }
  updateOutbox(
    id: string,
    patch: Partial<Pick<OutboxRow, 'attempts' | 'nextAttemptAt' | 'state' | 'ackedAt'>>,
  ): void {
    const found = this.outbox.get(id);
    if (found) this.outbox.set(id, { ...found, ...patch });
  }
  listInbox(
    workspace: string,
    recipient: string,
    since: string | null,
    limit: number,
  ): readonly OutboxRow[] {
    return [...this.outbox.values()]
      .filter(
        (r) =>
          r.workspace === workspace &&
          r.recipient === recipient &&
          r.ackedAt === null &&
          r.state !== 'dead' &&
          (since === null || r.id > since),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }
  listDead(workspace: string): readonly OutboxRow[] {
    return [...this.outbox.values()].filter((r) => r.workspace === workspace && r.state === 'dead');
  }
  ackInboxUpTo(workspace: string, recipient: string, upTo: string, at: string): number {
    let n = 0;
    for (const row of this.outbox.values()) {
      if (
        row.workspace === workspace &&
        row.recipient === recipient &&
        row.ackedAt === null &&
        row.state !== 'dead' &&
        row.id <= upTo
      ) {
        this.outbox.set(row.id, { ...row, ackedAt: at, state: 'delivered' });
        n += 1;
      }
    }
    return n;
  }
  dropPendingFor(workspace: string, recipient: string): number {
    let n = 0;
    for (const row of [...this.outbox.values()]) {
      if (
        row.workspace === workspace &&
        row.recipient === recipient &&
        (row.state === 'pending' || row.state === 'inflight')
      ) {
        this.outbox.delete(row.id);
        n += 1;
      }
    }
    return n;
  }

  findIdempotent(workspace: string, agent: string, k: string): IdempotencyHit | null {
    return this.idempotency.get(`${workspace}/${agent}/${k}`) ?? null;
  }
  tryPutIdempotent(
    workspace: string,
    agent: string,
    k: string,
    requestHash: string,
    response: string,
  ): boolean {
    const id = `${workspace}/${agent}/${k}`;
    if (this.idempotency.has(id)) return false;
    this.idempotency.set(id, { requestHash, response });
    return true;
  }

  seenNonce(agent: string, nonce: string): boolean {
    return this.nonces.has(`${agent}/${nonce}`);
  }
  recordNonce(agent: string, nonce: string, expiresAt: string): void {
    this.nonces.set(`${agent}/${nonce}`, expiresAt);
  }
  pruneNonces(now: string): void {
    for (const [k, expiresAt] of [...this.nonces.entries()]) {
      if (expiresAt <= now) this.nonces.delete(k);
    }
  }

  close(): void {
    // nothing to release
  }
}

export interface Fakes {
  // FakeStore, not Store: tests reach for fake-only affordances here just as
  // they do for FakeClock.advance.
  store: FakeStore;
  clock: FakeClock;
  ids: IdGen;
  blob: BlobStore;
  signer: Signer;
}

export function makeFakes(): Fakes {
  return {
    store: new FakeStore(),
    clock: new FakeClock(),
    ids: new FakeIds(),
    blob: new FakeBlobStore(),
    signer: new FakeSigner(),
  };
}
