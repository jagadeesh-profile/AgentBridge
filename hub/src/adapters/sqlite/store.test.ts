import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type SqliteStore } from './store.js';
import type { AgentRecord } from '../../ports/index.js';

const open: SqliteStore[] = [];
function store(): SqliteStore {
  const s = openStore(':memory:');
  open.push(s);
  return s;
}
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function agent(ref = 'agent:a', webhookUrl: string | null = null): AgentRecord {
  return {
    ref,
    workspace: 'ws',
    name: ref.slice('agent:'.length),
    publicKey: 'AAAA',
    webhookUrl,
    webhookSecret: webhookUrl === null ? null : 'secret',
    scopes: ['read', 'message'],
    keyStatus: 'active',
    capabilities: { skills: ['x'] },
    createdAt: '2026-10-20T00:00:00.000Z',
  };
}

function auditRow(action: string, prevHash = '') {
  return {
    workspace: 'ws',
    action,
    actor: 'agent:a',
    subject: 'x',
    prevHash,
    hash: `h-${action}`,
    createdAt: '2026-10-20T00:00:00.000Z',
  };
}

describe('sqlite store', () => {
  it('round-trips an agent including its JSON columns', () => {
    const s = store();
    s.putAgent(agent());
    const got = s.getAgent('ws', 'agent:a');
    expect(got?.scopes).toEqual(['read', 'message']);
    expect(got?.capabilities).toEqual({ skills: ['x'] });
  });

  it('rolls back on throw', () => {
    const s = store();
    expect(() =>
      s.transaction(() => {
        s.putAgent(agent());
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.getAgent('ws', 'agent:a')).toBeNull();
  });

  it('joins a nested transaction to the outer one', () => {
    const s = store();
    expect(() =>
      s.transaction(() => {
        s.putAgent(agent('agent:a'));
        s.transaction(() => s.putAgent(agent('agent:b')));
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect(s.getAgent('ws', 'agent:a')).toBeNull();
    expect(s.getAgent('ws', 'agent:b')).toBeNull();
  });

  it('isolates by workspace', () => {
    const s = store();
    s.putAgent(agent());
    expect(s.getAgent('other', 'agent:a')).toBeNull();
  });

  // The next two go through raw SQL deliberately: they prove the DATABASE
  // refuses mutation, not merely that the Store API omits an update method.
  it('REFUSES to update an audit row', () => {
    const s = store();
    s.appendAudit(auditRow('created'));
    expect(() => s.exec("UPDATE audit SET action = 'tampered' WHERE seq = 1")).toThrow(
      /append-only/i,
    );
  });

  it('REFUSES to delete an audit row', () => {
    const s = store();
    s.appendAudit(auditRow('created'));
    expect(() => s.exec('DELETE FROM audit WHERE seq = 1')).toThrow(/append-only/i);
  });

  it('chains audit hashes so each row references the previous', () => {
    const s = store();
    s.appendAudit(auditRow('one'));
    const first = s.lastAuditHash('ws');
    s.appendAudit(auditRow('two', first));
    const rows = s.listAudit('ws', 0, 10);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
  });

  it('returns an empty last hash for a workspace with no audit rows', () => {
    expect(store().lastAuditHash('ws')).toBe('');
  });

  it('enforces the idempotency unique index', () => {
    const s = store();
    expect(s.tryPutIdempotent('ws', 'agent:a', 'k', 'h', '{"a":1}')).toBe(true);
    expect(s.tryPutIdempotent('ws', 'agent:a', 'k', 'h', '{"a":2}')).toBe(false);
    expect(s.findIdempotent('ws', 'agent:a', 'k')?.response).toBe('{"a":1}');
  });

  it('scopes idempotency keys per agent', () => {
    const s = store();
    expect(s.tryPutIdempotent('ws', 'agent:a', 'k', 'h', '1')).toBe(true);
    expect(s.tryPutIdempotent('ws', 'agent:b', 'k', 'h', '2')).toBe(true);
  });

  it('versions artifacts per task and name', () => {
    const s = store();
    expect(s.nextArtifactVersion('ws', 'tsk_1', 'matches.json')).toBe(1);
    s.putArtifact({
      id: 'art_1',
      workspace: 'ws',
      task: 'tsk_1',
      version: 1,
      kind: 'json',
      name: 'matches.json',
      contentType: 'application/json',
      inline: { hits: 3 },
      blobKey: null,
      createdAt: '2026-10-20T00:00:00.000Z',
    });
    expect(s.nextArtifactVersion('ws', 'tsk_1', 'matches.json')).toBe(2);
    expect(s.nextArtifactVersion('ws', 'tsk_1', 'other.json')).toBe(1);
    expect(s.listArtifacts('ws', 'tsk_1')[0]?.inline).toEqual({ hits: 3 });
  });

  it('records and prunes nonces', () => {
    const s = store();
    s.recordNonce('agent:a', 'ts1', '2026-10-20T12:05:00.000Z');
    expect(s.seenNonce('agent:a', 'ts1')).toBe(true);
    s.pruneNonces('2026-10-20T12:10:00.000Z');
    expect(s.seenNonce('agent:a', 'ts1')).toBe(false);
  });

  it('only claims outbox rows for agents that have a webhook url', () => {
    const s = store();
    s.putAgent(agent('agent:pull', null));
    s.putAgent(agent('agent:push', 'https://push.example/hook'));
    const base = {
      workspace: 'ws',
      thread: 'thr_1',
      messageId: 'msg_1',
      attempts: 0,
      nextAttemptAt: '2026-10-20T12:00:00.000Z',
      state: 'pending' as const,
      ackedAt: null,
      createdAt: '2026-10-20T12:00:00.000Z',
    };
    s.putOutbox({ ...base, id: 'ob_1', recipient: 'agent:pull', thread: 'thr_pull' });
    s.putOutbox({ ...base, id: 'ob_2', recipient: 'agent:push', thread: 'thr_push' });

    expect(s.claimNextOutbox('2026-10-20T12:00:00.000Z')?.id).toBe('ob_2');
    // The pull-only agent's row is never claimed, but stays readable.
    expect(s.listInbox('ws', 'agent:pull', null, 10).map((r) => r.id)).toEqual(['ob_1']);
  });

  it('persists to a file so state survives reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-store-'));
    const path = join(dir, 'test.sqlite');
    try {
      const first = openStore(path);
      first.putAgent(agent());
      first.close();
      const second = openStore(path);
      expect(second.getAgent('ws', 'agent:a')?.ref).toBe('agent:a');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
