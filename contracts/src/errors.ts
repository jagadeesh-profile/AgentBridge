export const ERROR_CATALOG = {
  unauthenticated: {
    status: 401,
    message: 'Request signature missing, malformed or outside the replay window.',
  },
  signature_invalid: {
    status: 401,
    message: 'Signature did not verify against the registered key.',
  },
  key_revoked: { status: 401, message: 'The signing key has been revoked.' },
  scope_denied: {
    status: 403,
    message: 'The agent lacks the scope required for this operation.',
  },
  schema_invalid: { status: 400, message: 'Payload failed contract validation.' },
  illegal_transition: { status: 409, message: 'That task state transition is not permitted.' },
  approval_required: {
    status: 409,
    message: 'This task has a side effect and awaits owner approval.',
  },
  approval_hash_mismatch: {
    status: 409,
    message: 'The approval does not match the current payload hash.',
  },
  approval_consumed: { status: 409, message: 'That approval has already been used.' },
  idempotency_conflict: {
    status: 409,
    message: 'The idempotency key was reused with a different payload.',
  },
  not_found: { status: 404, message: 'No such resource in this workspace.' },
  already_exists: {
    status: 409,
    message: 'A resource with that identity already exists in this workspace.',
  },
  rate_limited: { status: 429, message: 'Rate limit exceeded for this agent.' },
  turn_cap_exceeded: { status: 429, message: 'Thread turn cap reached; the thread is paused.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

/**
 * Every error the hub returns to a client. The code carries the HTTP status, so
 * routes never choose a status themselves and a new code cannot ship with an
 * inconsistent response shape (spec §6).
 */
export class AgentBridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    /**
     * Replaces the catalog message in the response body. Opt-in per throw, and
     * only for detail safe to disclose to an UNAUTHENTICATED caller — it must
     * reveal nothing they did not already supply or could not already observe.
     * `detail` is log-only precisely because most of it fails that test:
     * "already used" versus "signature rejected" tells an attacker whether
     * they are replaying or forging.
     */
    readonly publicDetail?: string,
  ) {
    super(ERROR_CATALOG[code].message);
    this.name = 'AgentBridgeError';
  }

  get status(): number {
    return ERROR_CATALOG[this.code].status;
  }
}
