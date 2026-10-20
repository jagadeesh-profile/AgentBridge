import { AgentBridgeError, canTransition, payloadHash } from '@agentbridge/contracts';
import type { Actor, TaskState } from '@agentbridge/contracts';
import type { AgentRecord, Deps, TaskRecord } from '../ports/index.js';
import { appendAudit } from './audit.js';
import { requireScope } from './registry.js';
import { enqueueTo } from './threads.js';

/**
 * Which role an agent plays on a task. The owner is never an agent — owner
 * actions arrive through their own entry points (cancelTaskAsOwner,
 * decideApproval) signed by the owner key, so there is no synthetic
 * "agent:<ws>-owner" ref to impersonate.
 */
export function actorFor(task: TaskRecord, agentRef: string): Actor | null {
  if (agentRef === task.assignee) return 'assignee';
  if (agentRef === task.creator) return 'creator';
  return null;
}

export interface CreateTaskInput {
  thread: string;
  assignee: string;
  title: string;
  payload?: unknown;
  side_effect: boolean;
  due_at?: string | undefined;
  trace_id?: string | undefined;
}

export function createTask(deps: Deps, agent: AgentRecord, req: CreateTaskInput): TaskRecord {
  requireScope(agent, 'create_task');
  if (req.side_effect) requireScope(agent, 'request_side_effect');

  const ws = agent.workspace;
  const now = deps.clock.now().toISOString();

  return deps.store.transaction(() => {
    if (!deps.store.getAgent(ws, req.assignee)) {
      throw new AgentBridgeError('not_found', `unknown assignee ${req.assignee}`);
    }
    if (!deps.store.getThread(ws, req.thread)) {
      deps.store.upsertThread({
        id: req.thread,
        workspace: ws,
        turnCount: 0,
        paused: false,
        createdAt: now,
      });
    }

    const task: TaskRecord = {
      id: deps.ids.ulid('tsk'),
      workspace: ws,
      thread: req.thread,
      creator: agent.ref,
      assignee: req.assignee,
      title: req.title,
      payload: req.payload,
      payloadHash: payloadHash(req.payload),
      // Spec §5.4: a side-effect task is created into needs-approval and never
      // reaches submitted until the owner releases it.
      state: req.side_effect ? 'needs-approval' : 'submitted',
      sideEffect: req.side_effect,
      dueAt: req.due_at ?? null,
      createdAt: now,
      updatedAt: now,
    };
    deps.store.putTask(task);

    // No outbox row while the task is gated: the assignee must not be able to
    // start work on an unapproved side effect.
    if (task.state === 'submitted') {
      enqueueTo(deps, {
        workspace: ws,
        thread: task.thread,
        from: agent.ref,
        recipient: task.assignee,
        type: 'task.create',
        task: task.id,
        body: { title: task.title, payload: task.payload, state: task.state },
        sideEffect: task.sideEffect,
        ...(req.trace_id === undefined ? {} : { traceId: req.trace_id }),
        now,
      });
    }

    appendAudit(deps, ws, 'task.create', agent.ref, task.id);
    return task;
  });
}

export function updateTask(
  deps: Deps,
  agent: AgentRecord,
  taskId: string,
  state: TaskState,
  opts: { note?: string | undefined; traceId?: string | undefined } = {},
): TaskRecord {
  const ws = agent.workspace;
  const now = deps.clock.now().toISOString();

  return deps.store.transaction(() => {
    const task = deps.store.getTask(ws, taskId);
    if (!task) throw new AgentBridgeError('not_found', taskId);

    const who = actorFor(task, agent.ref);
    if (who === null || !canTransition(task.state, state, who)) {
      throw new AgentBridgeError(
        'illegal_transition',
        `${task.state} -> ${state} as ${who ?? 'stranger'}`,
      );
    }

    deps.store.setTaskState(ws, taskId, state, now);
    const updated: TaskRecord = { ...task, state, updatedAt: now };

    // Tell the other party: the assignee's progress goes to the creator, and a
    // creator-side change goes to the assignee.
    const recipient = who === 'assignee' ? task.creator : task.assignee;
    enqueueTo(deps, {
      workspace: ws,
      thread: task.thread,
      from: agent.ref,
      recipient,
      type: 'task.update',
      task: task.id,
      body: { state, title: task.title, ...(opts.note === undefined ? {} : { note: opts.note }) },
      sideEffect: task.sideEffect,
      ...(opts.traceId === undefined ? {} : { traceId: opts.traceId }),
      now,
    });

    appendAudit(deps, ws, 'task.update', agent.ref, `${taskId}:${state}`);
    return updated;
  });
}

/**
 * The owner's kill switch for a single task. Signed by the owner key at the
 * route, not by an agent, so it is a separate entry point rather than an actor
 * value an agent could claim.
 */
export function cancelTaskAsOwner(
  deps: Deps,
  workspace: string,
  taskId: string,
  opts: { traceId?: string | undefined } = {},
): TaskRecord {
  const now = deps.clock.now().toISOString();

  return deps.store.transaction(() => {
    const task = deps.store.getTask(workspace, taskId);
    if (!task) throw new AgentBridgeError('not_found', taskId);
    if (!canTransition(task.state, 'canceled', 'owner')) {
      throw new AgentBridgeError('illegal_transition', `${task.state} -> canceled as owner`);
    }

    deps.store.setTaskState(workspace, taskId, 'canceled', now);
    for (const recipient of new Set([task.assignee, task.creator])) {
      enqueueTo(deps, {
        workspace,
        thread: task.thread,
        from: task.creator,
        recipient,
        type: 'task.update',
        task: task.id,
        body: { state: 'canceled', title: task.title },
        sideEffect: task.sideEffect,
        ...(opts.traceId === undefined ? {} : { traceId: opts.traceId }),
        now,
      });
    }

    appendAudit(deps, workspace, 'task.cancel', 'owner', `${taskId}:canceled`);
    return { ...task, state: 'canceled', updatedAt: now };
  });
}
