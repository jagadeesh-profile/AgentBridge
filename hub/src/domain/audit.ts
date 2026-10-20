import { payloadHash } from '@agentbridge/contracts';
import type { Deps } from '../ports/index.js';

/**
 * Appends one hash-chained audit row (CLAUDE.md §1.9). The hash covers the
 * previous hash, so altering any earlier row breaks every row after it.
 * Append-only is additionally enforced by SQLite triggers.
 */
export function appendAudit(
  deps: Pick<Deps, 'store' | 'clock'>,
  workspace: string,
  action: string,
  actor: string,
  subject: string,
): void {
  const prevHash = deps.store.lastAuditHash(workspace);
  const createdAt = deps.clock.now().toISOString();
  const hash = payloadHash({ prevHash, workspace, action, actor, subject, createdAt });
  deps.store.appendAudit({ workspace, action, actor, subject, prevHash, hash, createdAt });
}

export interface AuditVerification {
  ok: boolean;
  checked: number;
  brokenAtSeq: number | null;
}

/** Walks the chain and reports the first row whose hash does not reconcile. */
export function verifyAuditChain(deps: Pick<Deps, 'store'>, workspace: string): AuditVerification {
  let prevHash = '';
  let checked = 0;
  let fromSeq = 0;

  for (;;) {
    const page = deps.store.listAudit(workspace, fromSeq, 500);
    if (page.length === 0) break;
    for (const row of page) {
      const expected = payloadHash({
        prevHash,
        workspace: row.workspace,
        action: row.action,
        actor: row.actor,
        subject: row.subject,
        createdAt: row.createdAt,
      });
      if (row.prevHash !== prevHash || row.hash !== expected) {
        return { ok: false, checked, brokenAtSeq: row.seq };
      }
      prevHash = row.hash;
      checked += 1;
      fromSeq = row.seq;
    }
  }

  return { ok: true, checked, brokenAtSeq: null };
}
