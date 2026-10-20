import { describe, expect, it } from 'vitest';
import { TRANSITIONS, canTransition } from './task-states.js';

describe('task transition table', () => {
  it('allows the assignee to accept a submitted task', () => {
    expect(canTransition('submitted', 'accepted', 'assignee')).toBe(true);
  });

  it("forbids the creator from accepting on the assignee's behalf", () => {
    expect(canTransition('submitted', 'accepted', 'creator')).toBe(false);
  });

  it('forbids skipping from submitted straight to completed', () => {
    expect(canTransition('submitted', 'completed', 'assignee')).toBe(false);
  });

  it('releases needs-approval only for the owner', () => {
    expect(canTransition('needs-approval', 'submitted', 'owner')).toBe(true);
    expect(canTransition('needs-approval', 'submitted', 'assignee')).toBe(false);
  });

  it('treats completed, failed and canceled as terminal', () => {
    for (const terminal of ['completed', 'failed', 'canceled'] as const) {
      const out = TRANSITIONS.filter((t) => t.from === terminal);
      expect(out, `${terminal} must have no outgoing transitions`).toEqual([]);
    }
  });

  it('lets the assignee ask for input and resume', () => {
    expect(canTransition('working', 'input-required', 'assignee')).toBe(true);
    expect(canTransition('input-required', 'working', 'assignee')).toBe(true);
  });

  it('lets the owner cancel from any non-terminal state', () => {
    for (const s of [
      'submitted',
      'accepted',
      'working',
      'input-required',
      'needs-approval',
    ] as const) {
      expect(canTransition(s, 'canceled', 'owner'), `owner must cancel from ${s}`).toBe(true);
    }
  });
});
