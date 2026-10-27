// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { describeError } from './page';

/**
 * The `unauthenticated` message, which cost real debugging time.
 *
 * It read "check the workspace name, that this is the owner key, and that your
 * clock is right". When it fired, the key WAS the configured owner key by
 * derivation, the clock had zero skew against the container, and the workspace
 * was correct — so all three suggestions pointed away from the fault.
 *
 * Naming the workspace was not just unhelpful, it was wrong: owner auth
 * verifies a signature against the hub's configured owner key and never
 * consults the workspace, so a wrong workspace authenticates and returns an
 * empty list. It cannot produce this error.
 */
describe('describeError — unauthenticated', () => {
  const msg = () => describeError({ code: 'unauthenticated' });

  it('names the two things that CAN cause it', () => {
    expect(msg()).toContain('AGENTBRIDGE_OWNER_PUBLIC_KEY');
    expect(msg()).toContain('clock');
  });

  it('says a wrong workspace is NOT the cause, since that misdirects', () => {
    expect(msg()).toContain('wrong workspace is not the cause');
  });

  it('no longer tells the owner to check the workspace name', () => {
    // The specific wording that sent two people hunting the wrong thing.
    expect(msg()).not.toMatch(/check the workspace name/i);
  });
});

describe('describeError — other codes', () => {
  it('explains a hash mismatch as the payload having moved', () => {
    expect(describeError({ code: 'approval_hash_mismatch' })).toContain('payload changed');
  });

  it('reports an unknown code rather than swallowing it', () => {
    expect(describeError({ code: 'teapot' })).toContain('teapot');
  });

  it('falls back to the message for a plain Error', () => {
    expect(describeError(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('says it could not reach the hub when there is nothing to report', () => {
    expect(describeError(undefined)).toContain('Could not reach the hub');
  });
});
