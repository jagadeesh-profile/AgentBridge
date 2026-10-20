import * as ed from '@noble/ed25519';
import { AgentBridgeError, canTransition, canonicalize } from '@agentbridge/contracts';
import type { Deps, TaskRecord } from '../ports/index.js';
import { appendAudit } from './audit.js';
import { enqueueTo } from './threads.js';

const PREFIX = 'ed25519:';

export interface ApprovalDecisionInput {
  task: string;
  decision: 'approve' | 'reject';
  payload_hash: string;
  issued_at: string;
  sig: string;
  trace_id?: string;
}

/**
 * The side-effect gate (spec §5.4, CLAUDE.md §1.3).
 *
 * Checks run in this order and the order matters:
 *   1. the owner's signature over exactly {task, decision, payload_hash, issued_at}
 *   2. the hash against the task's CURRENT payload
 *   3. single-use consumption
 *
 * Verifying the signature first means an unauthenticated caller cannot use the
 * hash check as an oracle to probe payload hashes.
 */
export async function decideApproval(
  deps: Deps,
  ownerPublicKey: Uint8Array,
  workspace: string,
  req: ApprovalDecisionInput,
): Promise<TaskRecord> {
  const task = deps.store.getTask(workspace, req.task);
  if (!task) throw new AgentBridgeError('not_found', req.task);

  // 1. Signature.
  const signed = canonicalize({
    task: req.task,
    decision: req.decision,
    payload_hash: req.payload_hash,
    issued_at: req.issued_at,
  });
  if (!(await verifyOwner(req.sig, signed, ownerPublicKey))) {
    throw new AgentBridgeError('signature_invalid', 'approval signature');
  }

  // 2. Single use. Matching on the signature distinguishes "this very approval
  //    was already used" (replay) from "this task is no longer awaiting a
  //    decision" (a different, later approval) — two different mistakes that
  //    deserve two different errors.
  const recorded = deps.store.findAnyApproval(workspace, req.task);
  if (recorded?.sig === req.sig) {
    throw new AgentBridgeError('approval_consumed', 'that approval has already been used');
  }

  if (task.state !== 'needs-approval') {
    throw new AgentBridgeError('illegal_transition', `task is ${task.state}, not needs-approval`);
  }
  if (recorded) {
    throw new AgentBridgeError('approval_consumed', 'a decision is already recorded');
  }

  // 3. Hash against the payload as it stands NOW, so mutating the payload after
  //    signing invalidates the approval by construction.
  if (req.payload_hash !== task.payloadHash) {
    throw new AgentBridgeError('approval_hash_mismatch');
  }

  const next = req.decision === 'approve' ? 'submitted' : 'failed';
  if (!canTransition(task.state, next, 'owner')) {
    // The transition table stays the single authority on legality (spec §6.1),
    // even though the state check above already constrains us.
    throw new AgentBridgeError('illegal_transition', `${task.state} -> ${next} as owner`);
  }

  const now = deps.clock.now().toISOString();

  return deps.store.transaction(() => {
    deps.store.putApproval({
      id: deps.ids.ulid('apr'),
      workspace,
      task: req.task,
      payloadHash: req.payload_hash,
      decision: req.decision,
      issuedAt: req.issued_at,
      sig: req.sig,
      consumedAt: now,
    });
    deps.store.setTaskState(workspace, req.task, next, now);

    // Only an approved task becomes deliverable. A rejected one must never
    // reach the assignee.
    if (next === 'submitted') {
      enqueueTo(deps, {
        workspace,
        thread: task.thread,
        from: task.creator,
        recipient: task.assignee,
        type: 'task.create',
        task: task.id,
        body: { title: task.title, payload: task.payload, state: next },
        sideEffect: true,
        ...(req.trace_id === undefined ? {} : { traceId: req.trace_id }),
        now,
      });
    }

    appendAudit(deps, workspace, 'approval.decision', 'owner', `${req.task}:${req.decision}`);
    return { ...task, state: next, updatedAt: now };
  });
}

async function verifyOwner(sig: string, signed: string, publicKey: Uint8Array): Promise<boolean> {
  if (!sig.startsWith(PREFIX)) return false;
  try {
    return await ed.verifyAsync(
      Buffer.from(sig.slice(PREFIX.length), 'base64'),
      new TextEncoder().encode(signed),
      publicKey,
    );
  } catch {
    return false;
  }
}
