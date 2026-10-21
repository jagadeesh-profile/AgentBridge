'use client';

import { useState } from 'react';
import type { OwnerClient, PendingTask } from '@agentbridge/sdk/owner';

/**
 * The task board: every task in the workspace, grouped by state.
 *
 * Payloads are deliberately absent here (`include_payload=false`). The board
 * answers "what is my workspace doing", which titles and states cover; the
 * approvals view is where a payload is read, because that is where one gets
 * signed.
 */

/** Pipeline order, then the terminal states. Mirrors the transition table. */
const COLUMNS: readonly { state: string; label: string }[] = [
  { state: 'needs-approval', label: 'Needs approval' },
  { state: 'submitted', label: 'Submitted' },
  { state: 'accepted', label: 'Accepted' },
  { state: 'working', label: 'Working' },
  { state: 'input-required', label: 'Input required' },
  { state: 'completed', label: 'Completed' },
  { state: 'failed', label: 'Failed' },
  { state: 'canceled', label: 'Canceled' },
];

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

export function Board({
  client,
  tasks,
  onChanged,
}: {
  client: OwnerClient;
  tasks: PendingTask[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function cancel(task: PendingTask) {
    setBusy(task.id);
    setError(null);
    try {
      await client.cancelTask(task.id);
      onChanged();
    } catch (err) {
      setError(
        err !== null && typeof err === 'object' && 'code' in err
          ? `Could not cancel: ${String((err as { code: unknown }).code)}.`
          : 'Could not cancel that task.',
      );
    } finally {
      setBusy(null);
    }
  }

  if (tasks.length === 0) {
    return <p className="empty">No tasks in this workspace yet.</p>;
  }

  return (
    <>
      {error !== null && <p className="error">{error}</p>}
      {COLUMNS.map(({ state, label }) => {
        const inState = tasks.filter((t) => t.state === state);
        if (inState.length === 0) return null;
        return (
          <section key={state} className="column">
            <h2 className="column-head">
              {label} <span className="count">{inState.length}</span>
            </h2>
            {inState.map((task) => (
              <div className="panel task" key={task.id}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{task.title}</strong>
                  {task.sideEffect && <span className="effect-tag">side effect</span>}
                </div>
                <p className="meta">
                  <code>{task.id}</code> · {task.creator} → {task.assignee} · updated{' '}
                  {new Date(task.updatedAt).toLocaleString()}
                </p>
                {!TERMINAL.has(task.state) && (
                  <button
                    className="danger"
                    disabled={busy !== null}
                    onClick={() => void cancel(task)}
                  >
                    {busy === task.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                )}
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}
