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
  webhook_url?: string;
  scopes?: readonly Scope[];
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
      throw new AgentBridgeError('schema_invalid', `agent ${ref} already exists in ${workspace}`);
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
    appendAudit(deps, workspace, 'agent.register', ref, ref);
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
