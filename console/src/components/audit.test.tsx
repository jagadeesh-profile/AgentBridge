// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { auditRowHash, verifyAuditChain } from '@agentbridge/contracts';
import type { AuditEntry, DeadLetter } from '@agentbridge/sdk/owner';
import { Audit } from './audit.js';

/**
 * The audit viewer, rendered.
 *
 * The chain rule itself is unit-tested in `contracts`; what was never tested
 * is this page's rendering of a verdict — the part an owner actually acts on.
 * It had been checked once by hand, by dropping the database's append-only
 * triggers and editing a row, which left nothing behind that a reviewer could
 * re-run.
 *
 * The verdicts here are produced by the REAL `verifyAuditChain` over rows
 * built with the real hashing, not by hand-written `AuditVerification`
 * literals. A fabricated verdict object would test the component against a
 * shape rather than against the thing it reports, and would keep passing if
 * the verifier's contract changed underneath it.
 */

afterEach(cleanup);

/** Builds a genuinely valid chain, so a break can be introduced deliberately. */
function chain(count: number): AuditEntry[] {
  const rows: AuditEntry[] = [];
  // `''` is the head-of-chain convention `verifyAuditChain` expects. A
  // plausible-looking 64 zeros makes row 1 fail, which flags the whole table
  // and quietly turns the "from the break onward" case into "everything".
  let prevHash = '';
  for (let i = 1; i <= count; i += 1) {
    const row = {
      seq: i,
      workspace: 'ws',
      action: `task.create`,
      actor: 'agent:claude',
      subject: `tsk_${i}`,
      createdAt: `2026-10-20T10:0${i}:00.000Z`,
      prevHash,
      hash: '',
    };
    // The shared rule from `contracts` — the same function the hub appends
    // with and the console verifies with. Restating the hashing here would be
    // the duplication ADR 0008 exists to prevent.
    row.hash = auditRowHash(row, prevHash);
    prevHash = row.hash;
    rows.push(row as AuditEntry);
  }
  return rows;
}

describe('Audit — a chain that verifies', () => {
  it('says the rows were recomputed in this page, not taken from the hub', () => {
    // The wording matters: it is the difference between the owner checking the
    // log and the hub asserting its own integrity.
    const rows = chain(3);
    render(<Audit rows={rows} verification={verifyAuditChain(rows)} deadLetters={[]} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Chain verifies');
    expect(text).toContain('recomputed in this page');
    expect(text).toContain('3');
  });

  it('marks no row as suspect when nothing is wrong', () => {
    const rows = chain(3);
    render(<Audit rows={rows} verification={verifyAuditChain(rows)} deadLetters={[]} />);
    expect(document.querySelectorAll('tr.suspect').length).toBe(0);
  });
});

describe('Audit — a chain that does NOT verify', () => {
  it('reports the break, its seq and its reason when a row was EDITED', () => {
    // The hand-check this replaces: edit a row behind the triggers' back.
    const rows = chain(3);
    rows[1] = { ...(rows[1] as AuditEntry), subject: 'tampered' };
    const verdict = verifyAuditChain(rows);

    expect(verdict.ok).toBe(false); // the fixture really is broken
    render(<Audit rows={rows} verification={verdict} deadLetters={[]} />);

    const text = document.body.textContent ?? '';
    expect(text).toContain('Chain does NOT verify');
    expect(text).toContain('2');
    expect(text).toContain(verdict.reason);
  });

  it('flags every row from the break onward, not just the broken one', () => {
    // Everything after a break is unprovable, not merely unverified, and the
    // owner needs to see that extent rather than one highlighted row.
    const rows = chain(4);
    rows[1] = { ...(rows[1] as AuditEntry), subject: 'tampered' };
    const verdict = verifyAuditChain(rows);
    render(<Audit rows={rows} verification={verdict} deadLetters={[]} />);

    const suspect = [...document.querySelectorAll('tr.suspect')];
    const seqs = suspect.map((tr) => Number(tr.querySelector('td')?.textContent));
    expect(seqs.sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it('detects a DELETED row, which hash-linking alone would miss', () => {
    // The gap check: serving the page around a removed row leaves every
    // remaining hash self-consistent, so only `seq` continuity catches it.
    const rows = chain(4);
    const withGap = [rows[0], rows[2], rows[3]] as AuditEntry[];
    const verdict = verifyAuditChain(withGap);

    expect(verdict.ok).toBe(false);
    render(<Audit rows={withGap} verification={verdict} deadLetters={[]} />);
    expect(document.body.textContent).toContain('Chain does NOT verify');
  });

  it('still renders the history, so the owner can see what is claimed', () => {
    // A break must not blank the table: the disputed rows are the evidence.
    const rows = chain(3);
    rows[1] = { ...(rows[1] as AuditEntry), subject: 'tampered' };
    render(<Audit rows={rows} verification={verifyAuditChain(rows)} deadLetters={[]} />);
    expect(document.querySelectorAll('tbody tr').length).toBe(3);
  });
});

describe('Audit — dead letters and empties', () => {
  it('lists dead letters with their recipient and attempt count', () => {
    const dead: DeadLetter[] = [
      {
        id: 'ob_1',
        recipient: 'agent:muse',
        thread: 'thr_1',
        messageId: 'msg_1',
        attempts: 7,
      } as DeadLetter,
    ];
    render(<Audit rows={chain(1)} verification={verifyAuditChain(chain(1))} deadLetters={dead} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('agent:muse');
    expect(text).toContain('7');
  });

  it('shows no dead-letter section when there are none', () => {
    render(<Audit rows={chain(1)} verification={verifyAuditChain(chain(1))} deadLetters={[]} />);
    expect(document.body.textContent).not.toContain('Dead letters');
  });

  it('says nothing has happened rather than showing an empty table', () => {
    render(<Audit rows={[]} verification={verifyAuditChain([])} deadLetters={[]} />);
    expect(document.body.textContent).toContain('Nothing recorded yet');
  });
});
