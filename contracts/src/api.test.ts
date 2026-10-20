import { describe, expect, it } from 'vitest';
import {
  ApprovalDecisionRequest,
  CreateTaskRequest,
  InboxQuery,
  RegisterAgentRequest,
  UntrustedWrapper,
} from './api.js';

describe('RegisterAgentRequest', () => {
  it('defaults a new agent to read + message only', () => {
    const parsed = RegisterAgentRequest.parse({
      name: 'muse',
      capabilities: { skills: ['job_search'], input: ['text'], output: ['json'] },
      public_key: 'AAAA',
    });
    expect(parsed.scopes).toEqual(['read', 'message']);
  });

  it('rejects an unknown scope', () => {
    expect(() =>
      RegisterAgentRequest.parse({
        name: 'muse',
        capabilities: { skills: [], input: [], output: [] },
        public_key: 'AAAA',
        scopes: ['admin'],
      }),
    ).toThrow();
  });

  it('rejects a name that is not a safe slug', () => {
    for (const name of ['Muse', 'mu se', '-muse', 'agent:muse', '']) {
      expect(
        () =>
          RegisterAgentRequest.parse({
            name,
            capabilities: { skills: [], input: [], output: [] },
            public_key: 'AAAA',
          }),
        name,
      ).toThrow();
    }
  });
});

describe('CreateTaskRequest', () => {
  it('requires side_effect explicitly', () => {
    expect(() =>
      CreateTaskRequest.parse({ thread: 't', assignee: 'agent:muse', title: 'x', payload: {} }),
    ).toThrow();
  });

  it('accepts a side-effect task with a payload', () => {
    const parsed = CreateTaskRequest.parse({
      thread: 't',
      assignee: 'agent:muse',
      title: 'send email',
      payload: { to: 'a@b.com' },
      side_effect: true,
    });
    expect(parsed.side_effect).toBe(true);
  });

  it('rejects an assignee without the agent: prefix', () => {
    expect(() =>
      CreateTaskRequest.parse({
        thread: 't',
        assignee: 'muse',
        title: 'x',
        payload: {},
        side_effect: false,
      }),
    ).toThrow();
  });
});

describe('InboxQuery', () => {
  it('defaults limit to 50 and caps it at 200', () => {
    expect(InboxQuery.parse({}).limit).toBe(50);
    expect(() => InboxQuery.parse({ limit: 500 })).toThrow();
  });

  it('coerces a string limit, since it arrives from a query string', () => {
    expect(InboxQuery.parse({ limit: '25' }).limit).toBe(25);
  });
});

describe('ApprovalDecisionRequest', () => {
  it('requires a 64-hex payload hash', () => {
    expect(() =>
      ApprovalDecisionRequest.parse({
        task: 'tsk_1',
        decision: 'approve',
        payload_hash: 'short',
        issued_at: '2026-10-20T20:50:46Z',
        sig: 'ed25519:AAAA',
      }),
    ).toThrow();
  });

  it('accepts a well-formed approve decision', () => {
    const parsed = ApprovalDecisionRequest.parse({
      task: 'tsk_1',
      decision: 'approve',
      payload_hash: 'a'.repeat(64),
      issued_at: '2026-10-20T20:50:46Z',
      sig: 'ed25519:AAAA',
    });
    expect(parsed.decision).toBe('approve');
  });

  it('rejects a decision that is neither approve nor reject', () => {
    expect(() =>
      ApprovalDecisionRequest.parse({
        task: 'tsk_1',
        decision: 'maybe',
        payload_hash: 'a'.repeat(64),
        issued_at: '2026-10-20T20:50:46Z',
        sig: 'ed25519:AAAA',
      }),
    ).toThrow();
  });
});

describe('UntrustedWrapper', () => {
  it('forces untrusted to be literally true', () => {
    expect(() =>
      UntrustedWrapper.parse({
        untrusted: false,
        provenance: { from: 'agent:muse', sigVerified: true, receivedAt: '2026-10-20T20:50:46Z' },
        value: {},
      }),
    ).toThrow();
  });

  it('accepts a well-formed wrapper', () => {
    const parsed = UntrustedWrapper.parse({
      untrusted: true,
      provenance: { from: 'agent:muse', sigVerified: true, receivedAt: '2026-10-20T20:50:46Z' },
      value: { text: 'hi' },
    });
    expect(parsed.provenance.from).toBe('agent:muse');
  });
});
