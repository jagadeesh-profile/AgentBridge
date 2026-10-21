/**
 * Semver of the wire contract. Additive → minor. Breaking → major + human
 * approval (CLAUDE.md §7).
 *
 * 0.2.0 — added the `already_exists` error code (409). Additive: no existing
 *         code, status or field changed, so no consumer breaks.
 * 0.1.0 — initial Phase 0 contract.
 */
export const CONTRACT_VERSION = '0.2.0';
