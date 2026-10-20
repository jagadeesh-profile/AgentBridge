import type { AgentRecord, Deps } from '../ports/index.js';
import { wrapUntrusted } from './threads.js';

export interface InboxItem {
  id: string;
  thread: string;
  type: string;
  task: string | null;
  body: ReturnType<typeof wrapUntrusted<unknown>>;
  created_at: string;
}

export interface InboxPage {
  items: InboxItem[];
  cursor: string | null;
}

/**
 * The pull fallback (FR-7). An unacknowledged row whose push failed is still
 * readable here, which is the guarantee that a failed push never loses a
 * message. Dead-lettered rows are excluded and surface only via the DLQ view.
 */
export function listInbox(
  deps: Pick<Deps, 'store'>,
  agent: AgentRecord,
  q: { since?: string | undefined; limit: number },
): InboxPage {
  const rows = deps.store.listInbox(agent.workspace, agent.ref, q.since ?? null, q.limit);

  const items: InboxItem[] = [];
  for (const row of rows) {
    const message = deps.store.getMessage(row.workspace, row.messageId);
    if (!message) continue;
    items.push({
      id: row.id,
      thread: row.thread,
      type: message.type,
      task: message.task,
      // Everything leaving the hub toward an agent is wrapped untrusted
      // (CLAUDE.md §1.1), on the pull path exactly as on the push path.
      body: wrapUntrusted(message.from, true, message.createdAt, message.body),
      created_at: message.createdAt,
    });
  }

  const last = items.at(-1);
  return { items, cursor: last === undefined ? null : last.id };
}

/** Advances the cursor. Idempotent: a second ack of the same range reports 0. */
export function ackInbox(
  deps: Pick<Deps, 'store' | 'clock'>,
  agent: AgentRecord,
  upTo: string,
): { acked: number } {
  const acked = deps.store.ackInboxUpTo(
    agent.workspace,
    agent.ref,
    upTo,
    deps.clock.now().toISOString(),
  );
  return { acked };
}
