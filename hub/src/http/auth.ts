import {
  AgentBridgeError,
  requestDescriptor,
  sha256Hex,
  verifyDescriptor,
} from '@agentbridge/contracts';
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
  opts: { allowReplay?: boolean } = {},
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

  // The nonce is a hash of the SIGNATURE, not the timestamp. Keying on the
  // timestamp would reject two distinct requests made in the same clock tick —
  // which a create-then-read pair does routinely. The signature is unique per
  // distinct request (the descriptor covers method, path, query and body), so
  // replaying one identical request is still caught.
  //
  // Replay rejection applies only to unsafe requests that carry no idempotency
  // key. A GET is read-only, so repeating one tells the holder of the signature
  // nothing new; and an unsafe request WITH an idempotency key is deduped by
  // that layer, which returns the original response without re-executing —
  // rejecting it here would break the safe retry CLAUDE.md §1.4 promises.
  const nonce = sha256Hex(signature);
  if (!opts.allowReplay && deps.store.seenNonce(ref, nonce)) {
    throw new AgentBridgeError('unauthenticated', 'request already seen');
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
    nonce,
    new Date(deps.clock.now().getTime() + REPLAY_WINDOW_MS).toISOString(),
  );
  return agent;
}
