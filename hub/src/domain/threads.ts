import { AgentBridgeError } from '@agentbridge/contracts';
import type { AgentRecord, Deps } from '../ports/index.js';
import { appendAudit } from './audit.js';
import { requireScope } from './registry.js';

/** CLAUDE.md §1: max turns per thread, default 6. */
export const DEFAULT_TURN_CAP = 6;

/**
 * Placeholder trace id used when no caller supplies one. Task 19 wires the real
 * OpenTelemetry trace id in from the HTTP layer; a test asserts the stored value
 * is never this.
 */
export const UNSET_TRACE_ID = '0'.repeat(32);

export interface UntrustedEnvelope<T> {
  untrusted: true;
  provenance: { from: string; sigVerified: boolean; receivedAt: string };
  value: T;
}

/**
 * Wraps agent content so it cannot be mistaken for instructions
 * (CLAUDE.md §1.1). Everything leaving the hub toward another agent goes
 * through this.
 */
export function wrapUntrusted<T>(
  from: string,
  sigVerified: boolean,
  receivedAt: string,
  value: T,
): UntrustedEnvelope<T> {
  return { untrusted: true, provenance: { from, sigVerified, receivedAt }, value };
}

export interface PostMessageInput {
  thread: string;
  to: readonly string[];
  body?: unknown;
  side_effect: boolean;
  idempotency_key: string;
  trace_id?: string | undefined;
}

export function postMessage(deps: Deps, agent: AgentRecord, req: PostMessageInput): { id: string } {
  requireScope(agent, 'message');
  const ws = agent.workspace;
  const now = deps.clock.now().toISOString();

  // The cap check runs BEFORE the write transaction, and the pause is committed
  // in its own transaction. Pausing inside the transaction that then throws
  // would roll the pause back, leaving the thread open at the cap.
  const existing = deps.store.getThread(ws, req.thread);
  if (existing && (existing.paused || existing.turnCount >= DEFAULT_TURN_CAP)) {
    if (!existing.paused) {
      deps.store.transaction(() => {
        deps.store.setThreadPaused(ws, req.thread, true);
        appendAudit(deps, ws, 'thread.pause', agent.ref, `${req.thread}:turn_cap`);
      });
    }
    throw new AgentBridgeError('turn_cap_exceeded', `thread ${req.thread}`);
  }

  return deps.store.transaction(() => {
    if (!existing) {
      deps.store.upsertThread({
        id: req.thread,
        workspace: ws,
        turnCount: 0,
        paused: false,
        createdAt: now,
      });
    }

    // Validate every recipient before writing anything addressed to them, so a
    // bad recipient cannot leave a half-delivered message behind.
    for (const to of req.to) {
      if (!deps.store.getAgent(ws, to)) {
        throw new AgentBridgeError('not_found', `unknown recipient ${to}`);
      }
    }

    const id = deps.ids.ulid('msg');
    deps.store.putMessage({
      id,
      workspace: ws,
      thread: req.thread,
      from: agent.ref,
      to: [...req.to],
      type: 'message.post',
      task: null,
      body: req.body,
      sideEffect: req.side_effect,
      traceId: req.trace_id ?? UNSET_TRACE_ID,
      sig: '',
      createdAt: now,
    });
    deps.store.bumpTurn(ws, req.thread);

    for (const to of req.to) {
      deps.store.putOutbox({
        id: deps.ids.ulid('ob'),
        workspace: ws,
        thread: req.thread,
        recipient: to,
        messageId: id,
        attempts: 0,
        nextAttemptAt: now,
        state: 'pending',
        ackedAt: null,
        createdAt: now,
      });
    }

    appendAudit(deps, ws, 'message.post', agent.ref, id);
    return { id };
  });
}

/** Enqueues one message to one recipient. Shared by tasks and approvals. */
export function enqueueTo(
  deps: Deps,
  opts: {
    workspace: string;
    thread: string;
    from: string;
    recipient: string;
    type: string;
    task: string | null;
    body: unknown;
    sideEffect: boolean;
    traceId?: string;
    now: string;
  },
): string {
  const messageId = deps.ids.ulid('msg');
  deps.store.putMessage({
    id: messageId,
    workspace: opts.workspace,
    thread: opts.thread,
    from: opts.from,
    to: [opts.recipient],
    type: opts.type,
    task: opts.task,
    body: opts.body,
    sideEffect: opts.sideEffect,
    traceId: opts.traceId ?? UNSET_TRACE_ID,
    sig: '',
    createdAt: opts.now,
  });
  deps.store.putOutbox({
    id: deps.ids.ulid('ob'),
    workspace: opts.workspace,
    thread: opts.thread,
    recipient: opts.recipient,
    messageId,
    attempts: 0,
    nextAttemptAt: opts.now,
    state: 'pending',
    ackedAt: null,
    createdAt: opts.now,
  });
  return messageId;
}
