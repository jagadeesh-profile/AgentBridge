import type { TaskState } from '@agentbridge/contracts';

/**
 * Translation between AgentBridge's model and A2A's.
 *
 * Kept in one file because every lossy edge lives here, and a mapping spread
 * across handlers is one that drifts.
 */

/** A2A task states. */
export type A2AState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'unknown';

/**
 * AgentBridge state → A2A state.
 *
 * Two mappings deserve explanation:
 *
 * - **`needs-approval` → `auth-required`.** A2A has no notion of a human
 *   approval gate. `auth-required` is the closest honest answer: the task is
 *   blocked pending an authorisation the caller cannot supply themselves.
 *   Mapping it to `working` would be a lie — nothing is happening — and
 *   `input-required` would invite the caller to send input that would not
 *   release it. The remote agent learns it must wait, which is true.
 * - **`accepted` → `working`.** A2A has no separate accepted state. Collapsing
 *   it loses the distinction between "assignee acknowledged" and "assignee is
 *   working", which A2A callers have no way to act on anyway.
 */
const STATE_TO_A2A: Record<TaskState, A2AState> = {
  submitted: 'submitted',
  accepted: 'working',
  working: 'working',
  'input-required': 'input-required',
  'needs-approval': 'auth-required',
  completed: 'completed',
  failed: 'failed',
  canceled: 'canceled',
};

export function toA2AState(state: TaskState | string): A2AState {
  return STATE_TO_A2A[state as TaskState] ?? 'unknown';
}

/** A2A content part. Only the two kinds AgentBridge can produce. */
export type Part = { kind: 'text'; text: string } | { kind: 'data'; data: unknown };

/**
 * Wraps an AgentBridge body or payload as A2A parts.
 *
 * A string becomes a TextPart and anything else a DataPart. AgentBridge
 * payloads are arbitrary JSON, so DataPart is the common case; text is special
 * cased because an A2A caller handling only text should still get something
 * readable.
 */
export function toParts(value: unknown): Part[] {
  if (typeof value === 'string') return [{ kind: 'text', text: value }];
  if (value === undefined || value === null) return [];
  return [{ kind: 'data', data: value }];
}

/**
 * Collapses A2A parts back into one AgentBridge payload.
 *
 * A single part becomes its own value, so a lone DataPart round-trips to the
 * object the caller sent rather than to a one-element array. Several parts
 * stay an array, because discarding any of them would silently drop content
 * the caller meant to send.
 */
export function fromParts(parts: readonly Part[]): unknown {
  if (parts.length === 0) return {};
  if (parts.length === 1) {
    const only = parts[0] as Part;
    return only.kind === 'text' ? only.text : only.data;
  }
  return parts.map((p) => (p.kind === 'text' ? p.text : p.data));
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: { state: A2AState; timestamp: string };
  kind: 'task';
  metadata: {
    /**
     * Surfaced rather than hidden: an A2A caller cannot see AgentBridge's
     * approval gate in the state alone, and "auth-required" with no
     * explanation is a dead end.
     */
    'agentbridge/state': string;
    'agentbridge/side_effect': boolean;
    'agentbridge/assignee': string;
  };
}

export function toA2ATask(task: {
  id: string;
  thread: string;
  state: string;
  sideEffect: boolean;
  assignee: string;
  updatedAt?: string;
}): A2ATask {
  return {
    id: task.id,
    // A2A's contextId groups related interactions, which is what a thread is.
    contextId: task.thread,
    status: {
      state: toA2AState(task.state),
      timestamp: task.updatedAt ?? new Date().toISOString(),
    },
    kind: 'task',
    metadata: {
      'agentbridge/state': task.state,
      'agentbridge/side_effect': task.sideEffect,
      'agentbridge/assignee': task.assignee,
    },
  };
}
