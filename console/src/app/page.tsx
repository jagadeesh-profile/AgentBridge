'use client';

import { useCallback, useState } from 'react';
import { canonicalize, payloadHash } from '@agentbridge/contracts';
import { OwnerClient, type PendingTask } from '@agentbridge/sdk/owner';
import { OwnerKeyError, parseOwnerKey, wipeKey } from '@/lib/owner-key';

/**
 * The approvals queue.
 *
 * A client component on purpose. The owner key is read from a file the owner
 * picks, parsed here, and kept in component state — it never reaches the
 * Next.js server, which exists only to serve this page and proxy /v1/* to the
 * hub unchanged (see next.config.mjs).
 */
/** The key stays here, alongside the client built from it, so `lock` can wipe it. */
interface Session {
  client: OwnerClient;
  key: Uint8Array;
  workspace: string;
}

export default function ApprovalsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<PendingTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async (c: OwnerClient) => {
    try {
      setTasks(await c.listPendingApprovals());
      setError(null);
    } catch (err) {
      setTasks(null);
      setError(describe(err));
    }
  }, []);

  // No load-on-mount effect: `unlock` performs the first fetch itself, so a
  // bad key never reaches this screen.

  async function unlock(file: File, ws: string) {
    setError(null);
    let key: Uint8Array;
    try {
      key = parseOwnerKey(await file.text());
    } catch (err) {
      setError(err instanceof OwnerKeyError ? err.message : 'Could not read that key file.');
      return;
    }
    // Same origin: next.config.mjs rewrites /v1/* to the hub with the path
    // intact, so what the browser signs is what the hub verifies.
    const client = new OwnerClient({ baseUrl: '', workspace: ws, privateKey: key });

    // Prove the key before unlocking. Parsing cannot tell an owner key from
    // any other 32 bytes — only the hub can — and a key it refuses must not
    // leave the owner on a signed-in screen, holding a key, wondering why
    // every button fails.
    try {
      setTasks(await client.listPendingApprovals());
    } catch (err) {
      wipeKey(key);
      setError(describe(err));
      return;
    }
    setSession({ client, key, workspace: ws });
  }

  function lock() {
    // Best effort: zero the bytes, then drop every reference to them.
    if (session !== null) wipeKey(session.key);
    setSession(null);
    setTasks(null);
    setError(null);
  }

  async function decide(task: PendingTask, decision: 'approve' | 'reject') {
    if (session === null) return;
    setBusy(task.id);
    try {
      await session.client.decide(task, decision);
      await refresh(session.client);
    } catch (err) {
      setError(describe(err));
      // Re-read regardless: an approval_hash_mismatch means the payload moved
      // under us, and the stale copy on screen is the thing not to act on.
      await refresh(session.client);
    } finally {
      setBusy(null);
    }
  }

  if (session === null) {
    return (
      <main>
        <h1>AgentBridge approvals</h1>
        <p className="sub">
          Your agents wait here for permission. Nothing with a side effect runs until you decide.
        </p>
        {error !== null && <p className="error">{error}</p>}
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const file = form.get('key');
            const ws = String(form.get('workspace') ?? '').trim();
            if (file instanceof File && file.size > 0 && ws !== '') void unlock(file, ws);
            else setError('Pick your owner key file and name the workspace.');
          }}
        >
          <label htmlFor="workspace">Workspace</label>
          <input id="workspace" name="workspace" type="text" placeholder="ws_jagadeesh" required />

          <label htmlFor="key">
            Owner key (the file `agentbridge keygen --out owner.key` wrote)
          </label>
          <input id="key" name="key" type="file" required />

          <button className="primary" type="submit">
            Unlock
          </button>
          <p className="warn">
            The key is read in this tab and held in memory only — never uploaded, never stored.
            Closing the tab ends the session, and you will pick the file again next time. That is
            deliberate: this key authorises every side effect in the workspace.
          </p>
        </form>
      </main>
    );
  }

  return (
    <main>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Awaiting your decision</h1>
        <div className="row">
          <button onClick={() => void refresh(session.client)}>Refresh</button>
          <button onClick={lock}>Lock</button>
        </div>
      </div>
      <p className="sub">
        Workspace <code>{session.workspace}</code>
      </p>

      {error !== null && <p className="error">{error}</p>}

      {/* Not merely `tasks === null`: a failed load leaves tasks null, and
          "Loading…" under an error message reads as a request still in flight. */}
      {tasks === null && error === null && <p className="empty">Loading…</p>}
      {tasks !== null && tasks.length === 0 && (
        <p className="empty">Nothing is waiting. Your agents are unblocked.</p>
      )}

      {tasks?.map((task) => {
        // Recomputed here, from the payload rendered below. This is the value
        // that gets signed — never task.payloadHash, which is the hub's claim
        // about its own data. Showing it lets the owner compare against the
        // CLI if they ever want to.
        const hash = payloadHash(task.payload);
        return (
          <section className="panel task" key={task.id}>
            <h2>{task.title}</h2>
            <p className="meta">
              <code>{task.id}</code> · {task.creator} → {task.assignee} · waiting since{' '}
              {new Date(task.createdAt).toLocaleString()}
            </p>
            <pre>{canonicalize(task.payload)}</pre>
            <p className="hash">
              payload sha256 {hash}
              {hash !== task.payloadHash && ' — DISAGREES WITH THE HUB; refuse this one'}
            </p>
            <div className="row">
              <button
                className="primary"
                disabled={busy !== null}
                onClick={() => void decide(task, 'approve')}
              >
                {busy === task.id ? 'Signing…' : 'Approve'}
              </button>
              <button
                className="danger"
                disabled={busy !== null}
                onClick={() => void decide(task, 'reject')}
              >
                Reject
              </button>
            </div>
          </section>
        );
      })}

      <p className="warn">
        Read the payload, not the title — the title is written by the agent that asked. Your
        signature covers the payload shown above and nothing else; if it changes before you decide,
        the hub refuses the approval rather than applying it to the new one.
      </p>
    </main>
  );
}

function describe(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code: unknown }).code);
    if (code === 'unauthenticated') {
      return 'The hub refused that key for this workspace. Check the workspace name, that this is the owner key, and that your clock is right.';
    }
    if (code === 'approval_hash_mismatch') {
      return 'The payload changed after this page loaded, so the decision was refused. The list below is current — review it again.';
    }
    if (code === 'approval_consumed') {
      return 'That task already has a decision recorded.';
    }
    return `The hub refused the request (${code}).`;
  }
  return err instanceof Error ? err.message : 'Could not reach the hub.';
}
