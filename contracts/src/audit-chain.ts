import { payloadHash } from './signing.js';

/**
 * The hash-chain rule for audit rows (CLAUDE.md §1.9), in one place.
 *
 * Lives in `contracts` rather than the hub because two parties compute it and
 * they must not drift: the hub when appending, and the owner console when
 * checking. `GET /v1/audit/verify` asks the hub whether its own log is intact,
 * which a compromised or buggy hub answers "yes" to — so the console
 * recomputes the chain from the rows it was given instead. That is the same
 * reasoning as recomputing an approval's payload hash, and it is the entire
 * reason a chain exists rather than a plain table.
 *
 * Isomorphic by construction: `payloadHash` uses `@noble/hashes`, so this runs
 * unchanged in a browser.
 */

export interface AuditRowLike {
  seq: number;
  workspace: string;
  action: string;
  actor: string;
  subject: string;
  prevHash: string;
  hash: string;
  createdAt: string;
}

/** The hash a row must carry, given the hash of the row before it. */
export function auditRowHash(
  row: Pick<AuditRowLike, 'workspace' | 'action' | 'actor' | 'subject' | 'createdAt'>,
  prevHash: string,
): string {
  return payloadHash({
    prevHash,
    workspace: row.workspace,
    action: row.action,
    actor: row.actor,
    subject: row.subject,
    createdAt: row.createdAt,
  });
}

export interface AuditVerification {
  ok: boolean;
  /** Rows checked before the walk stopped. */
  checked: number;
  /** `seq` of the first row that did not reconcile, or null. */
  brokenAtSeq: number | null;
  reason: 'ok' | 'hash-mismatch' | 'prev-hash-mismatch' | 'sequence-gap' | 'empty';
}

/**
 * Walks `rows` in order and reports the first that does not reconcile.
 *
 * `startPrevHash` is the hash of the row preceding the first one given, so a
 * page out of the middle of the chain can be checked. It is `''` for the head
 * of the chain.
 *
 * A gap in `seq` is a failure, not a skip: rows are append-only, so a missing
 * seq means something was deleted or withheld, which is exactly what the chain
 * is meant to surface. Without this check a caller could hide a row by serving
 * the page around it and the hashes either side would still link.
 */
export function verifyAuditChain(
  rows: readonly AuditRowLike[],
  startPrevHash = '',
): AuditVerification {
  if (rows.length === 0) {
    return { ok: true, checked: 0, brokenAtSeq: null, reason: 'empty' };
  }

  let prevHash = startPrevHash;
  let expectedSeq: number | null = null;
  let checked = 0;

  for (const row of rows) {
    if (expectedSeq !== null && row.seq !== expectedSeq) {
      return { ok: false, checked, brokenAtSeq: row.seq, reason: 'sequence-gap' };
    }
    if (row.prevHash !== prevHash) {
      return { ok: false, checked, brokenAtSeq: row.seq, reason: 'prev-hash-mismatch' };
    }
    if (row.hash !== auditRowHash(row, prevHash)) {
      return { ok: false, checked, brokenAtSeq: row.seq, reason: 'hash-mismatch' };
    }
    prevHash = row.hash;
    expectedSeq = row.seq + 1;
    checked += 1;
  }

  return { ok: true, checked, brokenAtSeq: null, reason: 'ok' };
}
