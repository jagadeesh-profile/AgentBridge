import { auditRowHash, verifyAuditChain, type AuditVerification } from '@agentbridge/contracts';
import type { Deps } from '../ports/index.js';

export type { AuditVerification };

/**
 * Appends one hash-chained audit row (CLAUDE.md §1.9). The hash covers the
 * previous hash, so altering any earlier row breaks every row after it.
 * Append-only is additionally enforced by SQLite triggers.
 *
 * The hash rule itself lives in `contracts` because the owner console checks
 * the chain independently rather than trusting the hub's own verdict; two
 * implementations of the rule would eventually disagree, and the disagreement
 * would read as tampering.
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
  const hash = auditRowHash({ workspace, action, actor, subject, createdAt }, prevHash);
  deps.store.appendAudit({ workspace, action, actor, subject, prevHash, hash, createdAt });
}

/** Walks the whole chain in pages and reports the first row that fails. */
export function verifyWholeChain(deps: Pick<Deps, 'store'>, workspace: string): AuditVerification {
  let prevHash = '';
  let fromSeq = 0;
  let checked = 0;

  for (;;) {
    const page = deps.store.listAudit(workspace, fromSeq, 500);
    if (page.length === 0) break;

    const result = verifyAuditChain(page, prevHash);
    if (!result.ok) {
      return { ...result, checked: checked + result.checked };
    }
    checked += result.checked;
    const last = page.at(-1);
    if (last === undefined) break;
    prevHash = last.hash;
    fromSeq = last.seq;
  }

  return { ok: true, checked, brokenAtSeq: null, reason: checked === 0 ? 'empty' : 'ok' };
}
