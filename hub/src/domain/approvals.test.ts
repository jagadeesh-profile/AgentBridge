import * as ed from '@noble/ed25519';
import { canonicalize, payloadHash } from '@agentbridge/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, type Fakes } from '../ports/fakes/index.js';
import { registerAgent } from './registry.js';
import { createTask } from './tasks.js';
import { decideApproval } from './approvals.js';
import type { AgentRecord } from '../ports/index.js';

let deps: Fakes;
let claude: AgentRecord;
let ownerPriv: Uint8Array;
let ownerPub: Uint8Array;
let taskId: string;

const payload = { to: 'recruiter@example.com', subject: 'Re: your role' };

async function signDecision(
  over: Partial<{ task: string; decision: string; payload_hash: string; issued_at: string }> = {},
) {
  const body = {
    task: over.task ?? taskId,
    decision: over.decision ?? 'approve',
    payload_hash: over.payload_hash ?? payloadHash(payload),
    issued_at: over.issued_at ?? deps.clock.now().toISOString(),
  };
  const sig = await ed.signAsync(new TextEncoder().encode(canonicalize(body)), ownerPriv);
  return {
    ...body,
    decision: body.decision as 'approve' | 'reject',
    sig: `ed25519:${Buffer.from(sig).toString('base64')}`,
  };
}

beforeEach(async () => {
  deps = makeFakes();
  ownerPriv = ed.utils.randomPrivateKey();
  ownerPub = await ed.getPublicKeyAsync(ownerPriv);
  claude = registerAgent(deps, 'ws', {
    name: 'claude',
    capabilities: {},
    public_key: 'A',
    scopes: ['read', 'message', 'create_task', 'request_side_effect'],
  });
  registerAgent(deps, 'ws', {
    name: 'muse',
    capabilities: {},
    public_key: 'B',
    scopes: ['read', 'message'],
  });
  taskId = createTask(deps, claude, {
    thread: 'thr_1',
    assignee: 'agent:muse',
    title: 'send email',
    payload,
    side_effect: true,
  }).id;
});

describe('decideApproval', () => {
  it('releases needs-approval -> submitted on a correct approval', async () => {
    const t = await decideApproval(deps, ownerPub, 'ws', await signDecision());
    expect(t.state).toBe('submitted');
  });

  it('only then makes the task deliverable to the assignee', async () => {
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10)).toHaveLength(0);
    await decideApproval(deps, ownerPub, 'ws', await signDecision());
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10).length).toBeGreaterThan(0);
  });

  it('REJECTS an approval whose payload hash does not match', async () => {
    await expect(
      decideApproval(deps, ownerPub, 'ws', await signDecision({ payload_hash: 'f'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'approval_hash_mismatch' });
    expect(deps.store.getTask('ws', taskId)?.state).toBe('needs-approval');
  });

  it("REJECTS an approval signed by a key that is not the owner's", async () => {
    const other = await ed.getPublicKeyAsync(ed.utils.randomPrivateKey());
    await expect(decideApproval(deps, other, 'ws', await signDecision())).rejects.toMatchObject({
      code: 'signature_invalid',
    });
    expect(deps.store.getTask('ws', taskId)?.state).toBe('needs-approval');
  });

  it('REJECTS a replayed approval', async () => {
    const decision = await signDecision();
    await decideApproval(deps, ownerPub, 'ws', decision);
    await expect(decideApproval(deps, ownerPub, 'ws', decision)).rejects.toMatchObject({
      code: 'approval_consumed',
    });
  });

  it('invalidates the approval when the payload is mutated after signing', async () => {
    const decision = await signDecision();
    const current = deps.store.getTask('ws', taskId);
    expect(current).not.toBeNull();
    deps.store.putTask({
      ...(current as NonNullable<typeof current>),
      payload: { to: 'attacker@evil.com' },
      payloadHash: payloadHash({ to: 'attacker@evil.com' }),
    });
    await expect(decideApproval(deps, ownerPub, 'ws', decision)).rejects.toMatchObject({
      code: 'approval_hash_mismatch',
    });
    expect(deps.store.getTask('ws', taskId)?.state).toBe('needs-approval');
  });

  it('checks the signature BEFORE the hash, so a bad signer cannot probe hashes', async () => {
    const other = await ed.getPublicKeyAsync(ed.utils.randomPrivateKey());
    await expect(
      decideApproval(deps, other, 'ws', await signDecision({ payload_hash: 'f'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('moves the task to failed on a reject', async () => {
    const t = await decideApproval(
      deps,
      ownerPub,
      'ws',
      await signDecision({ decision: 'reject' }),
    );
    expect(t.state).toBe('failed');
  });

  it('does not deliver the task to the assignee on a reject', async () => {
    await decideApproval(deps, ownerPub, 'ws', await signDecision({ decision: 'reject' }));
    expect(deps.store.listInbox('ws', 'agent:muse', null, 10)).toHaveLength(0);
  });

  it('refuses to decide a task that is not awaiting approval', async () => {
    await decideApproval(deps, ownerPub, 'ws', await signDecision());
    await expect(
      decideApproval(
        deps,
        ownerPub,
        'ws',
        await signDecision({ issued_at: '2026-10-21T00:00:00.000Z' }),
      ),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
  });

  it('throws not_found for an unknown task', async () => {
    await expect(
      decideApproval(deps, ownerPub, 'ws', await signDecision({ task: 'tsk_ghost' })),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('audits the decision', async () => {
    await decideApproval(deps, ownerPub, 'ws', await signDecision());
    expect(deps.store.listAudit('ws', 0, 20).map((r) => r.action)).toContain('approval.decision');
  });

  it('records the approval with the hash it was bound to', async () => {
    await decideApproval(deps, ownerPub, 'ws', await signDecision());
    const rec = deps.store.findAnyApproval('ws', taskId);
    expect(rec?.payloadHash).toBe(payloadHash(payload));
    expect(rec?.consumedAt).not.toBeNull();
  });

  it('rejects a signature that is not ed25519-prefixed', async () => {
    const decision = { ...(await signDecision()), sig: 'rsa:AAAA' };
    await expect(decideApproval(deps, ownerPub, 'ws', decision)).rejects.toMatchObject({
      code: 'signature_invalid',
    });
  });
});
