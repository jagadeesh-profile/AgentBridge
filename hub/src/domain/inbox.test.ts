import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, type Fakes } from '../ports/fakes/index.js';
import { registerAgent } from './registry.js';
import { ackInbox, listInbox } from './inbox.js';
import type { AgentRecord } from '../ports/index.js';

let deps: Fakes;
let muse: AgentRecord;

beforeEach(() => {
  deps = makeFakes();
  muse = registerAgent(deps, 'ws', {
    name: 'muse',
    capabilities: {},
    public_key: 'A',
    scopes: ['read', 'message'],
  });
  registerAgent(deps, 'ws', {
    name: 'claude',
    capabilities: {},
    public_key: 'B',
    scopes: ['read', 'message'],
  });
});

/** Writes a message plus its outbox row, the way the domain does. */
function deliver(
  id: string,
  opts: { body?: unknown; thread?: string; recipient?: string; task?: string | null } = {},
): string {
  const messageId = `msg_${id}`;
  deps.store.putMessage({
    id: messageId,
    workspace: 'ws',
    thread: opts.thread ?? 'thr_1',
    from: 'agent:claude',
    to: [opts.recipient ?? 'agent:muse'],
    type: 'message.post',
    task: opts.task ?? null,
    body: opts.body ?? { n: id },
    sideEffect: false,
    traceId: '0'.repeat(32),
    sig: '',
    createdAt: '2026-10-20T12:00:00.000Z',
  });
  deps.store.putOutbox({
    id,
    workspace: 'ws',
    thread: opts.thread ?? 'thr_1',
    recipient: opts.recipient ?? 'agent:muse',
    messageId,
    attempts: 0,
    nextAttemptAt: '2026-10-20T12:00:00.000Z',
    state: 'pending',
    ackedAt: null,
    createdAt: '2026-10-20T12:00:00.000Z',
  });
  return id;
}

/** An outbox row whose message is absent — the orphan case. */
function orphan(id: string, thread = 'thr_1'): string {
  deps.store.putOutbox({
    id,
    workspace: 'ws',
    thread,
    recipient: 'agent:muse',
    messageId: 'msg_missing',
    attempts: 0,
    nextAttemptAt: '2026-10-20T12:00:00.000Z',
    state: 'pending',
    ackedAt: null,
    createdAt: '2026-10-20T12:00:00.000Z',
  });
  return id;
}

describe('listInbox', () => {
  it('returns items oldest first', () => {
    deliver('ob_2');
    deliver('ob_1');
    deliver('ob_3');
    expect(listInbox(deps, muse, { limit: 10 }).items.map((i) => i.id)).toEqual([
      'ob_1',
      'ob_2',
      'ob_3',
    ]);
  });

  it('returns a cursor equal to the last item id', () => {
    deliver('ob_1');
    deliver('ob_2');
    expect(listInbox(deps, muse, { limit: 10 }).cursor).toBe('ob_2');
  });

  it('returns a null cursor when there is nothing at all', () => {
    expect(listInbox(deps, muse, { limit: 10 })).toEqual({ items: [], cursor: null });
  });

  it('returns only items after the cursor', () => {
    deliver('ob_1');
    deliver('ob_2');
    deliver('ob_3');
    const page = listInbox(deps, muse, { since: 'ob_1', limit: 10 });
    expect(page.items.map((i) => i.id)).toEqual(['ob_2', 'ob_3']);
  });

  it('honours the limit and leaves the rest for the next call', () => {
    for (const n of [1, 2, 3, 4, 5]) deliver(`ob_${n}`);
    const first = listInbox(deps, muse, { limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(['ob_1', 'ob_2']);
    const second = listInbox(deps, muse, { since: first.cursor ?? undefined, limit: 2 });
    expect(second.items.map((i) => i.id)).toEqual(['ob_3', 'ob_4']);
  });

  it('scopes strictly to the calling agent', () => {
    deliver('ob_mine');
    deliver('ob_theirs', { recipient: 'agent:claude' });
    expect(listInbox(deps, muse, { limit: 10 }).items.map((i) => i.id)).toEqual(['ob_mine']);
  });

  it('scopes strictly to the workspace', () => {
    deliver('ob_1');
    const otherWorkspace: AgentRecord = { ...muse, workspace: 'ws_other' };
    expect(listInbox(deps, otherWorkspace, { limit: 10 }).items).toHaveLength(0);
  });

  it('still returns an unacknowledged row whose push failed', () => {
    deliver('ob_1');
    // Three failed attempts: the row is still pending, so it must stay readable.
    deps.store.updateOutbox('ob_1', { attempts: 3, state: 'pending' });
    expect(listInbox(deps, muse, { limit: 10 }).items.map((i) => i.id)).toEqual(['ob_1']);
  });

  it('excludes rows already acknowledged', () => {
    deliver('ob_1');
    deliver('ob_2');
    ackInbox(deps, muse, 'ob_1');
    expect(listInbox(deps, muse, { limit: 10 }).items.map((i) => i.id)).toEqual(['ob_2']);
  });

  it('excludes dead-lettered rows, which belong to the DLQ view', () => {
    deliver('ob_1');
    deps.store.updateOutbox('ob_1', { state: 'dead' });
    expect(listInbox(deps, muse, { limit: 10 }).items).toHaveLength(0);
  });

  it('wraps every body as untrusted with provenance', () => {
    deliver('ob_1', { body: { text: 'hi' } });
    const item = listInbox(deps, muse, { limit: 10 }).items[0];
    expect(item?.body.untrusted).toBe(true);
    expect(item?.body.provenance).toEqual({
      from: 'agent:claude',
      sigVerified: true,
      receivedAt: '2026-10-20T12:00:00.000Z',
    });
    expect(item?.body.value).toEqual({ text: 'hi' });
  });

  it('carries the task id through for task-bearing messages', () => {
    deliver('ob_1', { task: 'tsk_7' });
    expect(listInbox(deps, muse, { limit: 10 }).items[0]?.task).toBe('tsk_7');
  });

  // An outbox row and its message are written in one transaction, so an orphan
  // should be impossible — but the code has a branch for it, and that branch
  // must not be able to wedge the queue.
  describe('an orphaned row (message missing)', () => {
    it('skips the orphan rather than failing the whole page', () => {
      orphan('ob_1');
      deliver('ob_2');
      expect(listInbox(deps, muse, { limit: 10 }).items.map((i) => i.id)).toEqual(['ob_2']);
    });

    it('does NOT wedge the cursor when the orphan is last in the page', () => {
      deliver('ob_1');
      orphan('ob_2');
      const page = listInbox(deps, muse, { limit: 10 });
      expect(page.items.map((i) => i.id)).toEqual(['ob_1']);
      // The cursor must advance past the orphan. If it stops at ob_1, the next
      // poll returns the same window forever and this agent never progresses.
      expect(page.cursor).toBe('ob_2');
    });

    it('does NOT report an empty page as "nothing new" when rows remain', () => {
      orphan('ob_1');
      const page = listInbox(deps, muse, { limit: 10 });
      expect(page.items).toHaveLength(0);
      // A null cursor here tells the client to keep asking from the same place.
      expect(page.cursor).toBe('ob_1');
    });

    it('lets a client drain past a run of orphans', () => {
      orphan('ob_1');
      orphan('ob_2');
      deliver('ob_3');
      const first = listInbox(deps, muse, { limit: 2 });
      expect(first.items).toHaveLength(0);
      expect(first.cursor).toBe('ob_2');
      const second = listInbox(deps, muse, { since: first.cursor ?? undefined, limit: 2 });
      expect(second.items.map((i) => i.id)).toEqual(['ob_3']);
    });
  });
});

describe('ackInbox', () => {
  it('acknowledges every row up to and including the cursor', () => {
    deliver('ob_1');
    deliver('ob_2');
    deliver('ob_3');
    expect(ackInbox(deps, muse, 'ob_2')).toEqual({ acked: 2 });
    expect(listInbox(deps, muse, { limit: 10 }).items.map((i) => i.id)).toEqual(['ob_3']);
  });

  it('is idempotent: a second ack of the same range reports zero', () => {
    deliver('ob_1');
    expect(ackInbox(deps, muse, 'ob_1')).toEqual({ acked: 1 });
    expect(ackInbox(deps, muse, 'ob_1')).toEqual({ acked: 0 });
  });

  it("refuses to acknowledge another agent's rows", () => {
    deliver('ob_theirs', { recipient: 'agent:claude' });
    expect(ackInbox(deps, muse, 'ob_theirs')).toEqual({ acked: 0 });
    const claude = deps.store.getAgent('ws', 'agent:claude');
    expect(claude).not.toBeNull();
    expect(listInbox(deps, claude as AgentRecord, { limit: 10 }).items.map((i) => i.id)).toEqual([
      'ob_theirs',
    ]);
  });

  it('does not resurrect a dead row', () => {
    deliver('ob_1');
    deps.store.updateOutbox('ob_1', { state: 'dead' });
    expect(ackInbox(deps, muse, 'ob_1')).toEqual({ acked: 0 });
    expect(deps.store.getOutbox('ob_1')?.state).toBe('dead');
  });

  it('records the acknowledgement time', () => {
    deliver('ob_1');
    ackInbox(deps, muse, 'ob_1');
    expect(deps.store.getOutbox('ob_1')?.ackedAt).toBe(deps.clock.now().toISOString());
  });

  it('acknowledges orphaned rows too, so they cannot accumulate', () => {
    orphan('ob_1');
    expect(ackInbox(deps, muse, 'ob_1')).toEqual({ acked: 1 });
  });
});
