import { payloadHash } from '@agentbridge/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, type Fakes } from '../ports/fakes/index.js';
import { registerAgent } from './registry.js';
import { cancelTaskAsOwner, createTask, updateTask } from './tasks.js';
import type { AgentRecord } from '../ports/index.js';

let deps: Fakes;
let claude: AgentRecord;
let muse: AgentRecord;

beforeEach(() => {
  deps = makeFakes();
  claude = registerAgent(deps, 'ws', {
    name: 'claude',
    capabilities: {},
    public_key: 'A',
    scopes: ['read', 'message', 'create_task', 'request_side_effect'],
  });
  muse = registerAgent(deps, 'ws', {
    name: 'muse',
    capabilities: {},
    public_key: 'B',
    scopes: ['read', 'message', 'create_task'],
  });
});

const base = {
  thread: 'thr_1',
  assignee: 'agent:muse',
  title: 'list job matches',
  payload: { count: 3 },
  side_effect: false,
};

describe('createTask', () => {
  it('creates a plain task into submitted', () => {
    expect(createTask(deps, claude, base).state).toBe('submitted');
  });

  it('creates a side-effect task directly into needs-approval, never submitted', () => {
    const t = createTask(deps, claude, {
      ...base,
      side_effect: true,
      payload: { to: 'a@b.com' },
    });
    expect(t.state).toBe('needs-approval');
  });

  it('stores the payload hash so an approval can bind to it', () => {
    const payload = { to: 'a@b.com' };
    const t = createTask(deps, claude, { ...base, side_effect: true, payload });
    expect(t.payloadHash).toBe(payloadHash(payload));
  });

  it('requires create_task scope', () => {
    const quiet = registerAgent(deps, 'ws', {
      name: 'quiet',
      capabilities: {},
      public_key: 'C',
      scopes: ['read', 'message'],
    });
    expect(() => createTask(deps, quiet, base)).toThrow(
      expect.objectContaining({ code: 'scope_denied' }),
    );
  });

  it('requires request_side_effect scope for a side-effect task', () => {
    expect(() => createTask(deps, muse, { ...base, side_effect: true })).toThrow(
      expect.objectContaining({ code: 'scope_denied' }),
    );
  });

  it('rejects an unknown assignee', () => {
    expect(() => createTask(deps, claude, { ...base, assignee: 'agent:ghost' })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('writes an outbox row for the assignee', () => {
    createTask(deps, claude, base);
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10)).toHaveLength(1);
  });

  it('does NOT write an outbox row for a task stuck in needs-approval', () => {
    createTask(deps, claude, { ...base, side_effect: true, payload: { to: 'a@b.com' } });
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10)).toHaveLength(0);
  });

  it('audits the creation', () => {
    const t = createTask(deps, claude, base);
    const rows = deps.store.listAudit('ws', 0, 20);
    expect(rows.some((r) => r.action === 'task.create' && r.subject === t.id)).toBe(true);
  });
});

describe('updateTask', () => {
  it('lets the assignee walk submitted -> accepted -> working -> completed', () => {
    const t = createTask(deps, claude, base);
    expect(updateTask(deps, muse, t.id, 'accepted').state).toBe('accepted');
    expect(updateTask(deps, muse, t.id, 'working').state).toBe('working');
    expect(updateTask(deps, muse, t.id, 'completed').state).toBe('completed');
  });

  it('refuses an illegal transition without coercing it', () => {
    const t = createTask(deps, claude, base);
    expect(() => updateTask(deps, muse, t.id, 'completed')).toThrow(
      expect.objectContaining({ code: 'illegal_transition' }),
    );
    expect(deps.store.getTask('ws', t.id)?.state).toBe('submitted');
  });

  it('refuses the creator acting as the assignee', () => {
    const t = createTask(deps, claude, base);
    expect(() => updateTask(deps, claude, t.id, 'accepted')).toThrow(
      expect.objectContaining({ code: 'illegal_transition' }),
    );
  });

  it('refuses an assignee releasing needs-approval', () => {
    const t = createTask(deps, claude, {
      ...base,
      side_effect: true,
      payload: { to: 'a@b.com' },
    });
    expect(() => updateTask(deps, muse, t.id, 'submitted')).toThrow(
      expect.objectContaining({ code: 'illegal_transition' }),
    );
    expect(deps.store.getTask('ws', t.id)?.state).toBe('needs-approval');
  });

  it('refuses a stranger who is neither creator nor assignee', () => {
    const t = createTask(deps, claude, base);
    const stranger = registerAgent(deps, 'ws', {
      name: 'stranger',
      capabilities: {},
      public_key: 'D',
      scopes: ['read', 'message'],
    });
    expect(() => updateTask(deps, stranger, t.id, 'accepted')).toThrow(
      expect.objectContaining({ code: 'illegal_transition' }),
    );
  });

  it('refuses any transition out of a terminal state', () => {
    const t = createTask(deps, claude, base);
    updateTask(deps, muse, t.id, 'accepted');
    updateTask(deps, muse, t.id, 'working');
    updateTask(deps, muse, t.id, 'completed');
    expect(() => updateTask(deps, muse, t.id, 'working')).toThrow(
      expect.objectContaining({ code: 'illegal_transition' }),
    );
  });

  it('notifies the creator when the assignee completes', () => {
    const t = createTask(deps, claude, base);
    updateTask(deps, muse, t.id, 'accepted');
    updateTask(deps, muse, t.id, 'working');
    updateTask(deps, muse, t.id, 'completed');
    expect(deps.store.listInbox('ws', 'agent:claude', null, 10).length).toBeGreaterThan(0);
  });

  it('throws not_found for an unknown task', () => {
    expect(() => updateTask(deps, muse, 'tsk_ghost', 'accepted')).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('audits every transition', () => {
    const t = createTask(deps, claude, base);
    updateTask(deps, muse, t.id, 'accepted');
    const actions = deps.store.listAudit('ws', 0, 20).map((r) => r.action);
    expect(actions).toContain('task.create');
    expect(actions).toContain('task.update');
  });
});

describe('cancelTaskAsOwner', () => {
  it('lets the owner cancel a non-terminal task', () => {
    const t = createTask(deps, claude, base);
    expect(cancelTaskAsOwner(deps, 'ws', t.id).state).toBe('canceled');
  });

  it('lets the owner cancel a task waiting for approval', () => {
    const t = createTask(deps, claude, {
      ...base,
      side_effect: true,
      payload: { to: 'a@b.com' },
    });
    expect(cancelTaskAsOwner(deps, 'ws', t.id).state).toBe('canceled');
  });

  it('refuses to cancel a completed task', () => {
    const t = createTask(deps, claude, base);
    updateTask(deps, muse, t.id, 'accepted');
    updateTask(deps, muse, t.id, 'working');
    updateTask(deps, muse, t.id, 'completed');
    expect(() => cancelTaskAsOwner(deps, 'ws', t.id)).toThrow(
      expect.objectContaining({ code: 'illegal_transition' }),
    );
  });
});
