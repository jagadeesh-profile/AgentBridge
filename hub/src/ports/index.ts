import type { OutboxRow, Store } from './store.js';

export type {
  AgentRecord,
  ApprovalRecord,
  ArtifactRecord,
  AuditRow,
  IdempotencyHit,
  MessageRecord,
  OutboxRow,
  PushConfigRow,
  ReservationOutcome,
  Store,
  TaskRecord,
  ThreadRecord,
} from './store.js';

/** Injected so no test reads the wall clock (spec §4.1). */
export interface Clock {
  now(): Date;
}

/** Injected so ids are deterministic in tests. Returns `${prefix}_${ULID}`. */
export interface IdGen {
  ulid(prefix: string): string;
}

export interface Signer {
  sign(bytes: Uint8Array): Promise<string>;
  publicKey(): Promise<Uint8Array>;
}

export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

export interface Queue {
  enqueue(row: OutboxRow): Promise<void>;
  claimNext(now: Date): OutboxRow | null;
  complete(id: string): Promise<void>;
  /** nextAttemptAt null ⇒ give up and dead-letter. */
  fail(id: string, nextAttemptAt: Date | null): Promise<void>;
  recoverInflight(now: Date): void;
}

/** The dependency bundle every domain module takes. */
export interface Deps {
  store: Store;
  clock: Clock;
  ids: IdGen;
}
