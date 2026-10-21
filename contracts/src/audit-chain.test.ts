import { describe, expect, it } from 'vitest';
import { auditRowHash, verifyAuditChain, type AuditRowLike } from './audit-chain.js';

/** Builds a well-formed chain of `n` rows. */
function chain(n: number, overrides: Partial<AuditRowLike>[] = []): AuditRowLike[] {
  const rows: AuditRowLike[] = [];
  let prevHash = '';
  for (let i = 0; i < n; i += 1) {
    const base = {
      seq: i + 1,
      workspace: 'ws',
      action: `event.${i}`,
      actor: 'agent:claude',
      subject: `subject-${i}`,
      createdAt: `2026-10-20T12:00:0${i}.000Z`,
      ...overrides[i],
    };
    const hash = auditRowHash(base, prevHash);
    rows.push({ ...base, prevHash, hash });
    prevHash = hash;
  }
  return rows;
}

describe('verifyAuditChain', () => {
  it('accepts an untampered chain', () => {
    expect(verifyAuditChain(chain(5))).toMatchObject({ ok: true, checked: 5, reason: 'ok' });
  });

  it('treats an empty log as intact, not as a failure', () => {
    expect(verifyAuditChain([])).toMatchObject({ ok: true, checked: 0, reason: 'empty' });
  });

  it('catches an EDITED row and names where', () => {
    const rows = chain(5);
    // Rewrite history: change what the third row says happened.
    rows[2] = { ...(rows[2] as AuditRowLike), subject: 'something-else' };
    expect(verifyAuditChain(rows)).toMatchObject({
      ok: false,
      brokenAtSeq: 3,
      reason: 'hash-mismatch',
    });
  });

  it('catches an edit even when the hash is recomputed to match it', () => {
    // The sophisticated version: forge row 3 AND its own hash. The chain still
    // breaks, because row 4 commits to the old hash. This is the property the
    // whole design rests on.
    const rows = chain(5);
    const third = rows[2] as AuditRowLike;
    const forged = { ...third, subject: 'something-else' };
    rows[2] = { ...forged, hash: auditRowHash(forged, third.prevHash) };
    expect(verifyAuditChain(rows)).toMatchObject({ ok: false, brokenAtSeq: 4 });
  });

  it('catches a DELETED row via the sequence gap', () => {
    // Removing a row and serving the rest would otherwise link up only if the
    // hashes were also rewritten; the seq gap catches the lazy version.
    const rows = chain(5);
    rows.splice(2, 1);
    expect(verifyAuditChain(rows)).toMatchObject({ ok: false, reason: 'sequence-gap' });
  });

  it('catches a REORDERED pair', () => {
    const rows = chain(5);
    const [a, b] = [rows[1] as AuditRowLike, rows[2] as AuditRowLike];
    rows[1] = b;
    rows[2] = a;
    expect(verifyAuditChain(rows).ok).toBe(false);
  });

  it('catches an APPENDED row that was not part of the chain', () => {
    const rows = chain(3);
    rows.push({
      seq: 4,
      workspace: 'ws',
      action: 'task.cancel',
      actor: 'owner',
      subject: 'tsk_x:canceled',
      prevHash: 'f'.repeat(64),
      hash: 'e'.repeat(64),
      createdAt: '2026-10-20T13:00:00.000Z',
    });
    expect(verifyAuditChain(rows)).toMatchObject({ ok: false, brokenAtSeq: 4 });
  });

  it('verifies a page from the MIDDLE when given the preceding hash', () => {
    const rows = chain(6);
    const page = rows.slice(3);
    expect(verifyAuditChain(page, (rows[2] as AuditRowLike).hash).ok).toBe(true);
  });

  it('REFUSES a middle page when the preceding hash is wrong', () => {
    const rows = chain(6);
    expect(verifyAuditChain(rows.slice(3), 'f'.repeat(64)).ok).toBe(false);
  });

  it('refuses a chain that does not start at the beginning without a prevHash', () => {
    // A caller that silently dropped the first rows must not get "ok".
    const rows = chain(5);
    expect(verifyAuditChain(rows.slice(2)).ok).toBe(false);
  });

  it('binds every field, so none can be altered unnoticed', () => {
    for (const field of ['workspace', 'action', 'actor', 'subject', 'createdAt'] as const) {
      const rows = chain(3);
      rows[1] = { ...(rows[1] as AuditRowLike), [field]: 'tampered' };
      expect(verifyAuditChain(rows).ok, field).toBe(false);
    }
  });
});
