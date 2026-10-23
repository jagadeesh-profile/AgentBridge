import { describe, expect, it } from 'vitest';
import type { AgentRecord, Store, TaskRecord } from './index.js';

/**
 * One behavioural spec every `Store` implementation must satisfy.
 *
 * The hub's own tests run against the in-memory fake while production runs
 * SQLite, so the two being interchangeable is an assumption the whole test
 * suite rests on — and nothing was checking it. Ordering in
 * `listTasksByState` already had to be hand-matched between them once, which
 * is precisely the kind of divergence that lets a test pass against the fake
 * and fail against the real store.
 *
 * It is also the acceptance test for Phase 1. "DynamoDB drops in as one new
 * file" is only a claim until something can be run against it; this is that
 * something.
 */
export function describeStoreConformance(name: string, makeStore: () => Store): void {
  const agent = (ref: string, over: Partial<AgentRecord> = {}): AgentRecord => ({
    ref,
    workspace: 'ws',
    name: ref.replace('agent:', ''),
    publicKey: 'AAAA',
    webhookUrl: null,
    webhookSecret: null,
    scopes: ['read', 'message'],
    keyStatus: 'active',
    capabilities: { skills: ['x'] },
    createdAt: '2026-10-20T00:00:00.000Z',
    ...over,
  });

  const task = (id: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
    id,
    workspace: 'ws',
    thread: 'thr_1',
    creator: 'agent:claude',
    assignee: 'agent:muse',
    title: `t-${id}`,
    payload: { n: 1 },
    payloadHash: 'f'.repeat(64),
    state: 'submitted',
    sideEffect: false,
    dueAt: null,
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    ...over,
  });

  describe(`Store conformance: ${name}`, () => {
    describe('workspace isolation', () => {
      // Every read is scoped by workspace. A store that leaked across them
      // would breach the boundary the whole product is organised around, and
      // no amount of care at the route layer would fix it.
      it('never returns an agent from another workspace', () => {
        const s = makeStore();
        s.putAgent(agent('agent:a'));
        s.putAgent({ ...agent('agent:a'), workspace: 'ws_other', publicKey: 'ZZZZ' });
        expect(s.getAgent('ws', 'agent:a')?.publicKey).toBe('AAAA');
        expect(s.listAgents('ws')).toHaveLength(1);
      });

      it('never returns a task from another workspace', () => {
        const s = makeStore();
        s.putTask(task('tsk_1'));
        s.putTask({ ...task('tsk_1'), workspace: 'ws_other' });
        expect(s.listTasksByState('ws', null, 10)).toHaveLength(1);
        expect(s.getTask('ws_other', 'tsk_1')?.workspace).toBe('ws_other');
      });

      it('keeps audit chains separate per workspace', () => {
        const s = makeStore();
        const row = (workspace: string, hash: string) => ({
          workspace,
          action: 'x',
          actor: 'owner',
          subject: 's',
          prevHash: '',
          hash,
          createdAt: '2026-10-20T00:00:00.000Z',
        });
        s.appendAudit(row('ws', 'h1'));
        s.appendAudit(row('ws_other', 'h2'));
        expect(s.lastAuditHash('ws')).toBe('h1');
        expect(s.lastAuditHash('ws_other')).toBe('h2');
      });
    });

    describe('transactions', () => {
      it('rolls every write back when the body throws', () => {
        const s = makeStore();
        expect(() =>
          s.transaction(() => {
            s.putAgent(agent('agent:a'));
            s.putTask(task('tsk_1'));
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.getAgent('ws', 'agent:a')).toBeNull();
        expect(s.getTask('ws', 'tsk_1')).toBeNull();
      });

      it('commits every write when the body returns', () => {
        const s = makeStore();
        s.transaction(() => {
          s.putAgent(agent('agent:a'));
          s.putTask(task('tsk_1'));
        });
        expect(s.getAgent('ws', 'agent:a')).not.toBeNull();
        expect(s.getTask('ws', 'tsk_1')).not.toBeNull();
      });

      it('lets a nested call join the outer transaction rather than commit early', () => {
        // The domain composes transactional helpers (enqueueTo inside
        // createTask, for instance). If the inner one committed, an outer
        // failure would leave half the work behind.
        const s = makeStore();
        expect(() =>
          s.transaction(() => {
            s.transaction(() => s.putAgent(agent('agent:a')));
            throw new Error('outer');
          }),
        ).toThrow('outer');
        expect(s.getAgent('ws', 'agent:a')).toBeNull();
      });

      it('returns the body value', () => {
        expect(makeStore().transaction(() => 42)).toBe(42);
      });

      it('READS ITS OWN WRITES inside the transaction', () => {
        // The domain does read-modify-write constantly: getTask then
        // setTaskState then appendAudit. A store whose reads did not see
        // uncommitted writes would break all of it — and this is exactly
        // what a DynamoDB TransactWriteItems adapter cannot do.
        const s = makeStore();
        const seen = s.transaction(() => {
          s.putTask(task('tsk_1'));
          return s.getTask('ws', 'tsk_1');
        });
        expect(seen?.id).toBe('tsk_1');
      });
    });

    describe('tasks', () => {
      it('round-trips every field, including the payload and its hash', () => {
        const s = makeStore();
        s.putTask(task('tsk_1', { payload: { deep: { a: [1, 'two'] } }, sideEffect: true }));
        const got = s.getTask('ws', 'tsk_1');
        expect(got?.payload).toEqual({ deep: { a: [1, 'two'] } });
        expect(got?.sideEffect).toBe(true);
        expect(got?.dueAt).toBeNull();
      });

      it('orders listTasksByState oldest first, with id breaking ties', () => {
        const s = makeStore();
        s.putTask(task('tsk_b', { createdAt: '2026-10-20T12:00:01.000Z' }));
        s.putTask(task('tsk_a', { createdAt: '2026-10-20T12:00:01.000Z' }));
        s.putTask(task('tsk_c', { createdAt: '2026-10-20T12:00:00.000Z' }));
        expect(s.listTasksByState('ws', null, 10).map((t) => t.id)).toEqual([
          'tsk_c',
          'tsk_a',
          'tsk_b',
        ]);
      });

      it('filters listTasksByState by state and honours the limit', () => {
        const s = makeStore();
        s.putTask(task('tsk_1', { state: 'needs-approval' }));
        s.putTask(task('tsk_2', { state: 'completed' }));
        s.putTask(task('tsk_3', { state: 'needs-approval' }));
        expect(s.listTasksByState('ws', 'needs-approval', 10)).toHaveLength(2);
        expect(s.listTasksByState('ws', 'needs-approval', 1)).toHaveLength(1);
      });

      it('upserts rather than duplicating on a repeated put', () => {
        const s = makeStore();
        s.putTask(task('tsk_1'));
        s.putTask(task('tsk_1', { title: 'renamed' }));
        expect(s.listTasksByState('ws', null, 10)).toHaveLength(1);
      });

      it('returns null for a task that does not exist', () => {
        expect(makeStore().getTask('ws', 'tsk_nope')).toBeNull();
      });
    });

    describe('agents', () => {
      it('round-trips scopes and capabilities through whatever encoding is used', () => {
        const s = makeStore();
        s.putAgent(agent('agent:a', { scopes: ['read', 'message', 'create_task'] }));
        const got = s.getAgent('ws', 'agent:a');
        expect(got?.scopes).toEqual(['read', 'message', 'create_task']);
        expect(got?.capabilities).toEqual({ skills: ['x'] });
      });

      it('applies setKeyStatus and leaves everything else alone', () => {
        const s = makeStore();
        s.putAgent(agent('agent:a', { webhookUrl: 'https://x.example/h' }));
        s.setKeyStatus('ws', 'agent:a', 'revoked');
        const got = s.getAgent('ws', 'agent:a');
        expect(got?.keyStatus).toBe('revoked');
        expect(got?.webhookUrl).toBe('https://x.example/h');
      });

      it('distinguishes an absent webhook from an empty one', () => {
        const s = makeStore();
        s.putAgent(agent('agent:a'));
        expect(s.getAgent('ws', 'agent:a')?.webhookUrl).toBeNull();
      });
    });

    describe('nonces', () => {
      it('reports a nonce as unseen before it is recorded and seen after', () => {
        const s = makeStore();
        expect(s.seenNonce('agent:a', 'n1')).toBe(false);
        s.recordNonce('agent:a', 'n1', '2030-01-01T00:00:00.000Z');
        expect(s.seenNonce('agent:a', 'n1')).toBe(true);
      });

      it('scopes a nonce to its agent, so two agents do not collide', () => {
        const s = makeStore();
        s.recordNonce('agent:a', 'n1', '2030-01-01T00:00:00.000Z');
        expect(s.seenNonce('agent:b', 'n1')).toBe(false);
      });
    });

    describe('a2a push config', () => {
      const cfg = {
        workspace: 'ws',
        task: 'tsk_1',
        agentRef: 'agent:a',
        url: 'https://x.example/cb',
        token: 'tok',
        createdAt: '2026-10-20T12:00:00.000Z',
      };

      it('round-trips and upserts on the same task', () => {
        const s = makeStore();
        s.putPushConfig(cfg);
        s.putPushConfig({ ...cfg, url: 'https://x.example/other' });
        expect(s.getPushConfig('ws', 'tsk_1')?.url).toBe('https://x.example/other');
      });

      it('keeps a null token null rather than coercing it', () => {
        const s = makeStore();
        s.putPushConfig({ ...cfg, token: null });
        expect(s.getPushConfig('ws', 'tsk_1')?.token).toBeNull();
      });

      it('does not leak across workspaces', () => {
        const s = makeStore();
        s.putPushConfig(cfg);
        expect(s.getPushConfig('ws_other', 'tsk_1')).toBeNull();
      });
    });

    describe('audit', () => {
      const row = (hash: string, prevHash: string) => ({
        workspace: 'ws',
        action: 'task.create',
        actor: 'agent:a',
        subject: 'tsk_1',
        prevHash,
        hash,
        createdAt: '2026-10-20T12:00:00.000Z',
      });

      it('assigns strictly increasing seq numbers', () => {
        const s = makeStore();
        s.appendAudit(row('h1', ''));
        s.appendAudit(row('h2', 'h1'));
        const seqs = s.listAudit('ws', 0, 10).map((r) => r.seq);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(new Set(seqs).size).toBe(seqs.length);
      });

      it('lists from an exclusive cursor', () => {
        const s = makeStore();
        s.appendAudit(row('h1', ''));
        s.appendAudit(row('h2', 'h1'));
        const first = s.listAudit('ws', 0, 10)[0];
        expect(first).toBeDefined();
        const rest = s.listAudit('ws', first?.seq ?? 0, 10);
        expect(rest.every((r) => r.seq > (first?.seq ?? 0))).toBe(true);
      });

      it('reports an empty chain as an empty last hash', () => {
        expect(makeStore().lastAuditHash('ws')).toBe('');
      });
    });
  });
}
