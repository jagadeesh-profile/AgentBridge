/**
 * Semver of the wire contract. Additive → minor. Breaking → major + human
 * approval (CLAUDE.md §7).
 *
 * 0.3.0 — BREAKING. POST /v1/agents now requires an owner Ed25519 signature
 *         (x-agentbridge-owner-signature + x-agentbridge-timestamp) instead of
 *         a shared registration token. Any caller using the token is rejected.
 *         Pre-1.0, so a breaking change takes the minor slot. See ADR 0005.
 * 0.2.0 — added the `already_exists` error code (409). Additive: no existing
 *         code, status or field changed, so no consumer breaks.
 * 0.1.0 — initial Phase 0 contract.
 */
export const CONTRACT_VERSION = '0.3.0';
