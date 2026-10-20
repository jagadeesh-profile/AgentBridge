import { describe, expect, it } from 'vitest';
import { makeFakes } from '../ports/fakes/index.js';
import { registerAgent, requireScope, revokeKey } from './registry.js';

const req = {
  name: 'muse',
  capabilities: { skills: ['job_search'], input: ['text'], output: ['json'] },
  public_key: 'AAAA',
  scopes: ['read', 'message'] as const,
};

describe('registerAgent', () => {
  it('stores the agent with an active key and an agent: ref', () => {
    const deps = makeFakes();
    const a = registerAgent(deps, 'ws', req);
    expect(a.ref).toBe('agent:muse');
    expect(a.keyStatus).toBe('active');
  });

  it('generates a webhook secret only when a webhook url is given', () => {
    const deps = makeFakes();
    expect(registerAgent(deps, 'ws', req).webhookSecret).toBeNull();
    const withHook = registerAgent(deps, 'ws', {
      ...req,
      name: 'muse2',
      webhook_url: 'https://m.example/hook',
    });
    expect(withHook.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes an audit row for the registration', () => {
    const deps = makeFakes();
    registerAgent(deps, 'ws', req);
    expect(deps.store.listAudit('ws', 0, 10).map((r) => r.action)).toContain('agent.register');
  });

  it('rejects a duplicate agent name in the same workspace', () => {
    const deps = makeFakes();
    registerAgent(deps, 'ws', req);
    expect(() => registerAgent(deps, 'ws', req)).toThrow();
  });

  it('allows the same agent name in a different workspace', () => {
    const deps = makeFakes();
    registerAgent(deps, 'ws', req);
    expect(registerAgent(deps, 'other', req).ref).toBe('agent:muse');
  });

  it('defaults to read + message when scopes are omitted', () => {
    const deps = makeFakes();
    const { scopes: _omitted, ...withoutScopes } = req;
    const a = registerAgent(deps, 'ws', withoutScopes);
    expect(a.scopes).toEqual(['read', 'message']);
  });
});

describe('requireScope', () => {
  it('throws scope_denied when the scope is absent', () => {
    const deps = makeFakes();
    const a = registerAgent(deps, 'ws', req);
    expect(() => requireScope(a, 'create_task')).toThrow(
      expect.objectContaining({ code: 'scope_denied' }),
    );
  });

  it('passes when the scope is present', () => {
    const deps = makeFakes();
    const a = registerAgent(deps, 'ws', {
      ...req,
      scopes: ['read', 'message', 'create_task'],
    });
    expect(() => requireScope(a, 'create_task')).not.toThrow();
  });
});

describe('revokeKey', () => {
  it("marks the key revoked and drops that agent's pending deliveries", () => {
    const deps = makeFakes();
    registerAgent(deps, 'ws', req);
    deps.store.putOutbox({
      id: 'ob_1',
      workspace: 'ws',
      thread: 'thr_1',
      recipient: 'agent:muse',
      messageId: 'msg_1',
      attempts: 0,
      nextAttemptAt: '2026-10-20T00:00:00.000Z',
      state: 'pending',
      ackedAt: null,
      createdAt: '2026-10-20T00:00:00.000Z',
    });
    revokeKey(deps, 'ws', 'agent:muse');
    expect(deps.store.getAgent('ws', 'agent:muse')?.keyStatus).toBe('revoked');
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10)).toHaveLength(0);
  });

  it('audits the revocation', () => {
    const deps = makeFakes();
    registerAgent(deps, 'ws', req);
    revokeKey(deps, 'ws', 'agent:muse');
    expect(deps.store.listAudit('ws', 0, 10).map((r) => r.action)).toContain('agent.revoke');
  });

  it('throws not_found for an unknown agent', () => {
    const deps = makeFakes();
    expect(() => revokeKey(deps, 'ws', 'agent:ghost')).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
  });
});

describe('audit chaining', () => {
  it('links each row to the previous hash', () => {
    const deps = makeFakes();
    registerAgent(deps, 'ws', req);
    registerAgent(deps, 'ws', { ...req, name: 'claude' });
    const rows = deps.store.listAudit('ws', 0, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.prevHash).toBe('');
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
  });

  it('gives every row a distinct hash', () => {
    const deps = makeFakes();
    registerAgent(deps, 'ws', req);
    registerAgent(deps, 'ws', { ...req, name: 'claude' });
    const rows = deps.store.listAudit('ws', 0, 10);
    expect(rows[0]?.hash).not.toBe(rows[1]?.hash);
  });
});
