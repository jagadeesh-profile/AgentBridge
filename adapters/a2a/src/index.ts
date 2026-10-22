/**
 * A2A v1.0 protocol translation — the Agent Card, the JSON-RPC envelope and
 * the AgentBridge↔A2A mapping. Pure: no hub import, no I/O, no identity.
 *
 * The routes that use this live in the hub (`hub/src/http/a2a.ts`), not here,
 * and that is a deliberate difference from the MCP adapter.
 *
 * MCP is an outbound stdio client, so it can be a thin REST client of the hub
 * and hold the agent's key itself. A2A is an *inbound* HTTP server: the remote
 * agent signs its request, and an Ed25519 signature covers the method, path
 * and body hash of the request it was made for. A proxy that received
 * `POST /a2a/v1` and forwarded `POST /v1/tasks` would be presenting a
 * signature for a request that no longer exists — it could only work by the
 * hub trusting a header about what was signed, or by the adapter re-signing
 * with its own key. The first discards the guarantee; the second makes the
 * adapter a confused deputy whose scopes every remote caller inherits.
 *
 * Serving A2A from inside the hub means the caller's signature covers exactly
 * what the hub verifies, and `req.agent` is the remote agent rather than the
 * adapter.
 */
export * from './agent-card.js';
export * from './jsonrpc.js';
export * from './mapping.js';
