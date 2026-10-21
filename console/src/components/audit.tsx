'use client';

import type { AuditEntry, DeadLetter } from '@agentbridge/sdk/owner';
import type { AuditVerification } from '@agentbridge/contracts';

/**
 * The audit viewer.
 *
 * The banner at the top is the point of the whole screen, and it reports a
 * verdict this page computed from the rows below — not one the hub supplied.
 * A hub that had rewritten a row would happily report its own log as intact,
 * so asking it is worth little; recomputing the chain is what makes the
 * append-only claim checkable by the person it protects.
 */
export function Audit({
  rows,
  verification,
  deadLetters,
}: {
  rows: AuditEntry[];
  verification: AuditVerification | null;
  deadLetters: DeadLetter[];
}) {
  return (
    <>
      {verification !== null && (
        <div className={verification.ok ? 'panel verdict ok-verdict' : 'panel verdict bad-verdict'}>
          {verification.ok ? (
            <>
              <strong>Chain verifies.</strong> {verification.checked}{' '}
              {verification.checked === 1 ? 'row' : 'rows'} recomputed in this page — not taken from
              the hub.
              {verification.reason === 'empty' && ' Nothing has happened in this workspace yet.'}
            </>
          ) : (
            <>
              <strong>Chain does NOT verify.</strong> It breaks at seq{' '}
              {verification.brokenAtSeq ?? '?'} ({verification.reason}) after {verification.checked}{' '}
              good {verification.checked === 1 ? 'row' : 'rows'}. The history below cannot be
              trusted from that point on. Treat this as evidence the hub&rsquo;s storage was
              altered.
            </>
          )}
        </div>
      )}

      {deadLetters.length > 0 && (
        <section className="column">
          <h2 className="column-head">
            Dead letters <span className="count">{deadLetters.length}</span>
          </h2>
          {deadLetters.map((d) => (
            <div className="panel task" key={d.id}>
              <strong>{d.recipient}</strong>
              <p className="meta">
                gave up after {d.attempts} attempts · thread <code>{d.thread}</code> · message{' '}
                <code>{d.messageId}</code>
              </p>
            </div>
          ))}
        </section>
      )}

      {rows.length === 0 ? (
        <p className="empty">Nothing recorded yet.</p>
      ) : (
        <div className="audit-table">
          <table>
            <thead>
              <tr>
                <th>seq</th>
                <th>when</th>
                <th>actor</th>
                <th>action</th>
                <th>subject</th>
              </tr>
            </thead>
            <tbody>
              {/* Newest first to read, while verification walked them in order. */}
              {[...rows].reverse().map((r) => (
                <tr
                  key={r.seq}
                  className={
                    verification !== null &&
                    !verification.ok &&
                    verification.brokenAtSeq !== null &&
                    r.seq >= verification.brokenAtSeq
                      ? 'suspect'
                      : undefined
                  }
                >
                  <td>{r.seq}</td>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>{r.actor}</td>
                  <td>{r.action}</td>
                  <td className="subject">{r.subject}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
