'use client';

import { useState } from 'react';
import type { AgentSummary, OwnerClient } from '@agentbridge/sdk/owner';

/**
 * The kill switch.
 *
 * Revoking stops an agent on its very next request and drops whatever was
 * already queued for it. There is no un-revoke in Phase 0 — the agent has to
 * be re-enrolled with a fresh key — so this asks the owner to type the agent's
 * name rather than accepting a single click. That is the same bar as the CLI's
 * `--yes`, placed where a misclick is likeliest.
 */
export function Agents({
  client,
  agents,
  onChanged,
}: {
  client: OwnerClient;
  agents: AgentSummary[];
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke(ref: string) {
    setBusy(true);
    setError(null);
    try {
      await client.revokeAgentKey(ref);
      setConfirming(null);
      setTyped('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed.');
    } finally {
      setBusy(false);
    }
  }

  if (agents.length === 0) {
    return <p className="empty">No agents registered in this workspace.</p>;
  }

  return (
    <>
      {error !== null && <p className="error">{error}</p>}
      {agents.map((a) => {
        const revoked = a.keyStatus === 'revoked';
        return (
          <section className="panel task" key={a.ref}>
            <h2>
              {a.ref} {revoked && <span className="revoked-tag">key revoked</span>}
            </h2>
            <p className="meta">
              scopes {a.scopes.length === 0 ? '(none)' : a.scopes.join(', ')} ·{' '}
              {a.webhookUrl === null ? 'pull inbox' : `webhook ${a.webhookUrl}`} · registered{' '}
              {new Date(a.createdAt).toLocaleDateString()}
            </p>

            {revoked ? (
              <p className="meta">
                This key can no longer sign anything. Re-enrol the agent with a new key to bring it
                back.
              </p>
            ) : confirming === a.ref ? (
              <div>
                <p className="meta">
                  This stops <code>{a.ref}</code> on its next request and discards anything already
                  queued for it. It cannot be undone. Type <code>{a.name}</code> to confirm.
                </p>
                <input
                  type="text"
                  value={typed}
                  autoFocus
                  placeholder={a.name}
                  onChange={(e) => setTyped(e.target.value)}
                />
                <div className="row">
                  <button
                    className="danger"
                    disabled={busy || typed !== a.name}
                    onClick={() => void revoke(a.ref)}
                  >
                    {busy ? 'Revoking…' : `Revoke ${a.ref}`}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                      setTyped('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="danger"
                onClick={() => {
                  setConfirming(a.ref);
                  setTyped('');
                  setError(null);
                }}
              >
                Revoke key
              </button>
            )}
          </section>
        );
      })}
    </>
  );
}
