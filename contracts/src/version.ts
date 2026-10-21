/**
 * Semver of the wire contract. Additive → minor. Breaking → major + human
 * approval (CLAUDE.md §7).
 *
 * 0.6.0 — adds ?include_payload to GET /v1/tasks (default true, so no
 *         consumer breaks) so a task board need not pull every payload.
 *         Additive.
 * 0.5.0 — BREAKING. DELETE /v1/agents/{ref}/key (the kill switch) is
 *         owner-signed; it previously accepted ANY authenticated agent, with
 *         no scope check. Adds owner-only GET /v1/agents. See ADR 0006.
 * 0.4.0 — BREAKING. POST /v1/approvals is authenticated by the OWNER's
 *         signature, not by a borrowed agent identity; adds owner-only
 *         GET /v1/tasks?state=. Callers that signed approvals as an agent are
 *         rejected. See ADR 0006.
 * 0.3.0 — BREAKING. POST /v1/agents now requires an owner Ed25519 signature
 *         (x-agentbridge-owner-signature + x-agentbridge-timestamp) instead of
 *         a shared registration token. Any caller using the token is rejected.
 *         Pre-1.0, so a breaking change takes the minor slot. See ADR 0005.
 * 0.2.0 — added the `already_exists` error code (409). Additive: no existing
 *         code, status or field changed, so no consumer breaks.
 * 0.1.0 — initial Phase 0 contract.
 */
export const CONTRACT_VERSION = '0.6.0';
