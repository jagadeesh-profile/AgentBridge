import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, type Fakes } from '../ports/fakes/index.js';
import { registerAgent } from './registry.js';
import { DEFAULT_TURN_CAP, postMessage, wrapUntrusted } from './threads.js';
import type { AgentRecord } from '../ports/index.js';

let deps: Fakes;
let muse: AgentRecord;

beforeEach(() => {
  deps = makeFakes();
  muse = registerAgent(deps, 'ws', {
    name: 'muse',
    capabilities: {},
    public_key: 'AAAA',
    scopes: ['read', 'message'],
  });
  registerAgent(deps, 'ws', {
    name: 'claude',
    capabilities: {},
    public_key: 'BBBB',
    scopes: ['read', 'message'],
  });
});

const req = {
  thread: 'thr_1',
  to: ['agent:claude'],
  body: { text: 'hi' },
  side_effect: false,
  idempotency_key: 'k1',
};

describe('postMessage', () => {
  it('writes the message, the audit row and one outbox row per recipient atomically', () => {
    const { id } = postMessage(deps, muse, req);
    expect(deps.store.getMessage('ws', id)).toMatchObject({ from: 'agent:muse' });
    expect(deps.store.listAudit('ws', 0, 10).map((r) => r.action)).toContain('message.post');
    expect(deps.store.listInbox('ws', 'agent:claude', null, 10)).toHaveLength(1);
  });

  it('fans out one outbox row per recipient', () => {
    registerAgent(deps, 'ws', {
      name: 'third',
      capabilities: {},
      public_key: 'CCCC',
      scopes: ['read', 'message'],
    });
    postMessage(deps, muse, { ...req, to: ['agent:claude', 'agent:third'] });
    expect(deps.store.listInbox('ws', 'agent:claude', null, 10)).toHaveLength(1);
    expect(deps.store.listInbox('ws', 'agent:third', null, 10)).toHaveLength(1);
  });

  it('leaves no partial state when a recipient is unknown', () => {
    expect(() => postMessage(deps, muse, { ...req, to: ['agent:ghost'] })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
    // Only the two registrations; no message, no outbox row, no audit row.
    expect(deps.store.listAudit('ws', 0, 10)).toHaveLength(2);
    expect(deps.store.listInbox('ws', 'agent:claude', null, 10)).toHaveLength(0);
  });

  it('leaves no partial state when the second of two recipients is unknown', () => {
    expect(() => postMessage(deps, muse, { ...req, to: ['agent:claude', 'agent:ghost'] })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
    expect(deps.store.listInbox('ws', 'agent:claude', null, 10)).toHaveLength(0);
  });

  it('requires the message scope', () => {
    const readOnly = registerAgent(deps, 'ws', {
      name: 'quiet',
      capabilities: {},
      public_key: 'DDDD',
      scopes: ['read'],
    });
    expect(() => postMessage(deps, readOnly, req)).toThrow(
      expect.objectContaining({ code: 'scope_denied' }),
    );
  });

  it('increments the thread turn count', () => {
    postMessage(deps, muse, req);
    postMessage(deps, muse, { ...req, idempotency_key: 'k2' });
    expect(deps.store.getThread('ws', 'thr_1')?.turnCount).toBe(2);
  });

  it('pauses the thread and throws turn_cap_exceeded at the cap', () => {
    for (let i = 0; i < DEFAULT_TURN_CAP; i += 1) {
      postMessage(deps, muse, { ...req, idempotency_key: `k${i}` });
    }
    expect(() => postMessage(deps, muse, { ...req, idempotency_key: 'over' })).toThrow(
      expect.objectContaining({ code: 'turn_cap_exceeded' }),
    );
    // The pause must SURVIVE the throw — it is not part of the rolled-back write.
    expect(deps.store.getThread('ws', 'thr_1')?.paused).toBe(true);
  });

  it('keeps refusing once the thread is paused', () => {
    deps.store.upsertThread({
      id: 'thr_1',
      workspace: 'ws',
      turnCount: 0,
      paused: true,
      createdAt: '2026-10-20T00:00:00.000Z',
    });
    expect(() => postMessage(deps, muse, req)).toThrow(
      expect.objectContaining({ code: 'turn_cap_exceeded' }),
    );
  });

  it('audits the pause so the owner can see why the thread stopped', () => {
    for (let i = 0; i < DEFAULT_TURN_CAP; i += 1) {
      postMessage(deps, muse, { ...req, idempotency_key: `k${i}` });
    }
    expect(() => postMessage(deps, muse, { ...req, idempotency_key: 'over' })).toThrow();
    expect(deps.store.listAudit('ws', 0, 50).map((r) => r.action)).toContain('thread.pause');
  });

  it('creates the thread on first post', () => {
    expect(deps.store.getThread('ws', 'thr_new')).toBeNull();
    postMessage(deps, muse, { ...req, thread: 'thr_new' });
    expect(deps.store.getThread('ws', 'thr_new')?.turnCount).toBe(1);
  });

  it('does not deliver a message back to its own sender', () => {
    postMessage(deps, muse, { ...req, to: ['agent:claude'] });
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10)).toHaveLength(0);
  });
});

describe('wrapUntrusted', () => {
  it('marks content untrusted with provenance', () => {
    const w = wrapUntrusted('agent:muse', true, '2026-10-20T00:00:00.000Z', { text: 'x' });
    expect(w).toEqual({
      untrusted: true,
      provenance: {
        from: 'agent:muse',
        sigVerified: true,
        receivedAt: '2026-10-20T00:00:00.000Z',
      },
      value: { text: 'x' },
    });
  });
});
