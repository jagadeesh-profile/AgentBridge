export const EVENT_TYPES = [
  'message.post',
  'task.create',
  'task.update',
  'task.result',
  'artifact.put',
  'approval.request',
  'approval.decision',
  'inbox.wakeup',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
