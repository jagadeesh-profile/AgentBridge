import { randomBytes } from 'node:crypto';
import { AgentBridgeError, type Scope } from '@agentbridge/contracts';
import type { AgentRecord, Deps } from '../ports/index.js';
import { appendAudit } from './audit.js';

/** CLAUDE.md §8: a new agent gets read + message and nothing else. */
export const DEFAULT_SCOPES: readonly Scope[] = ['read', 'message'];

export interface RegisterInput {
  name: string;
  capabilities: unknown;
  public_key: string;
  webhook_url?: string | undefined;
  scopes?: readonly Scope[] | undefined;
}

export function registerAgent(
  deps: Pick<Deps, 'store' | 'clock'>,
  workspace: string,
  req: RegisterInput,
): AgentRecord {
  const ref = `agent:${req.name}`;
  const now = deps.clock.now().toISOString();

  return deps.store.transaction(() => {
    if (deps.store.getAgent(workspace, ref)) {
      // A conflict, not a malformed request: the payload is fine, the name is
      // taken. Returning 400 would tell the caller to fix a payload that has
      // nothing wrong with it.
      throw new AgentBridgeError('already_exists', `agent ${ref} already exists in ${workspace}`);
    }

    const agent: AgentRecord = {
      ref,
      workspace,
      name: req.name,
      publicKey: req.public_key,
      webhookUrl: req.webhook_url ?? null,
      // Only agents that register a URL get a webhook secret; there is nothing
      // to sign for a pull-only agent.
      webhookSecret: req.webhook_url === undefined ? null : randomBytes(32).toString('hex'),
      scopes: req.scopes === undefined ? [...DEFAULT_SCOPES] : [...req.scopes],
      keyStatus: 'active',
      capabilities: req.capabilities,
      createdAt: now,
    };

    deps.store.putAgent(agent);
    // The owner's signature over the enrolment is what authorised this (ADR
    // 0005), so the owner is the actor and the new agent is the subject. The
    // literal `owner` is deliberately outside the `agent:` namespace: every
    // registrable ref is `agent:<name>`, so an owner actor inside it would be
    // registrable and therefore forgeable in the audit log.
    appendAudit(deps, workspace, 'agent.register', 'owner', ref);
    return agent;
  });
}

export function requireScope(agent: AgentRecord, scope: Scope): void {
  if (!agent.scopes.includes(scope)) {
    throw new AgentBridgeError('scope_denied', `${agent.ref} lacks ${scope}`);
  }
}

/**
 * The kill switch. Key status is checked inside signature verification, so this
 * takes effect on the agent's very next request; dropping its pending outbox
 * rows stops in-flight deliveries too (spec §5.1).
 */
export function revokeKey(
  deps: Pick<Deps, 'store' | 'clock'>,
  workspace: string,
  ref: string,
): void {
  deps.store.transaction(() => {
    if (!deps.store.getAgent(workspace, ref)) {
      throw new AgentBridgeError('not_found', ref);
    }
    deps.store.setKeyStatus(workspace, ref, 'revoked');
    const dropped = deps.store.dropPendingFor(workspace, ref);
    appendAudit(deps, workspace, 'agent.revoke', ref, `${ref}:dropped=${dropped}`);
  });
}
