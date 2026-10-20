export const TASK_STATES = [
  'submitted',
  'accepted',
  'working',
  'input-required',
  'needs-approval',
  'completed',
  'failed',
  'canceled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type Actor = 'creator' | 'assignee' | 'owner';

export interface Transition {
  readonly from: TaskState;
  readonly to: TaskState;
  readonly who: Actor;
}

const CANCELABLE: readonly TaskState[] = [
  'submitted',
  'accepted',
  'working',
  'input-required',
  'needs-approval',
];

/**
 * The task state machine, as data. The hub is a lookup against this table
 * rather than a switch, so there is exactly one place that decides whether a
 * transition is legal (spec §6.1).
 */
export const TRANSITIONS: readonly Transition[] = [
  // The approval gate. A side-effect task is created into needs-approval and
  // only the owner releases it. See spec §5.4.
  { from: 'needs-approval', to: 'submitted', who: 'owner' },
  { from: 'needs-approval', to: 'failed', who: 'owner' },

  { from: 'submitted', to: 'accepted', who: 'assignee' },
  { from: 'submitted', to: 'failed', who: 'assignee' },
  { from: 'accepted', to: 'working', who: 'assignee' },
  { from: 'working', to: 'input-required', who: 'assignee' },
  { from: 'input-required', to: 'working', who: 'assignee' },
  { from: 'working', to: 'completed', who: 'assignee' },
  { from: 'working', to: 'failed', who: 'assignee' },

  ...CANCELABLE.map((from): Transition => ({ from, to: 'canceled', who: 'owner' })),
  ...CANCELABLE.map((from): Transition => ({ from, to: 'canceled', who: 'creator' })),
];

export function canTransition(from: TaskState, to: TaskState, who: Actor): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.who === who);
}
