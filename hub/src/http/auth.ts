import { AgentBridgeError, requestDescriptor, verifyDescriptor } from '@agentbridge/contracts';
import type { AgentRecord, Deps } from '../ports/index.js';

/** ±300 s, per the Global Constraints and spec §5.1. */
export const REPLAY_WINDOW_MS = 300_000;

export interface RawRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  body: string;
  headers: Record<string, string | undefined>;
}

/**
 * Phase 0 auth: possession of the agent's Ed25519 private key authenticates the
 * request; scopes authorize it (spec §5.2 — OAuth 2.1 is Phase 1).
 */
export async function authenticate(
  deps: Pick<Deps, 'store' | 'clock'>,
  raw: RawRequest,
): Promise<AgentRecord> {
  const workspace = raw.headers['x-agentbridge-workspace'];
  const ref = raw.headers['x-agentbridge-agent'];
  const timestamp = raw.headers['x-agentbridge-timestamp'];
  const signature = raw.headers['x-agentbridge-signature'];

  if (!workspace || !ref || !timestamp || !signature) {
    throw new AgentBridgeError('unauthenticated', 'missing auth headers');
  }

  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    throw new AgentBridgeError('unauthenticated', 'unparseable timestamp');
  }
  // `>` not `>=`: 299 s is accepted, 301 s is not. Math.abs covers a
  // future-dated timestamp from a skewed sender.
  const skew = Math.abs(deps.clock.now().getTime() - parsed);
  if (skew > REPLAY_WINDOW_MS) {
    throw new AgentBridgeError('unauthenticated', 'timestamp outside the replay window');
  }

  if (deps.store.seenNonce(ref, timestamp)) {
    throw new AgentBridgeError('unauthenticated', 'timestamp already used');
  }

  const agent = deps.store.getAgent(workspace, ref);
  // An unknown agent and a bad signature return the same code, so probing
  // cannot distinguish "no such agent" from "wrong key".
  if (!agent) throw new AgentBridgeError('unauthenticated', 'unknown agent');
  if (agent.keyStatus === 'revoked') throw new AgentBridgeError('key_revoked');

  const descriptor = requestDescriptor({
    method: raw.method,
    path: raw.path,
    query: raw.query,
    body: raw.body,
    timestamp,
  });
  const ok = await verifyDescriptor(descriptor, signature, Buffer.from(agent.publicKey, 'base64'));
  if (!ok) throw new AgentBridgeError('signature_invalid');

  deps.store.recordNonce(
    ref,
    timestamp,
    new Date(deps.clock.now().getTime() + REPLAY_WINDOW_MS).toISOString(),
  );
  return agent;
}
