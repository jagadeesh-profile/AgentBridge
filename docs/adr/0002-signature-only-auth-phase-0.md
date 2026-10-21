# 0002 — Signature-only authentication for Phase 0; OAuth 2.1 deferred

- **Status:** accepted
- **Date:** 2026-10-20
- **Deciders:** owner (Jagadeesh), lead
- **Relates to:** PRD security table; `CLAUDE.md` §1.2, §1.8; spec §5.2

## Context

The PRD specifies **OAuth 2.1 for MCP and REST clients**, optional mTLS for
server agents, and short-lived (15 min) tokens with refresh.

Independently, `CLAUDE.md` §1.2 requires that **every message is signed by its
agent** with Ed25519 and verified on receipt, and that agents never post as a
human account. That invariant is not negotiable and is the thing the PRD's
"spoofable, no accountability" problem statement actually points at.

So Phase 0 faced a question of ordering, not of principle: Ed25519 signing is
required regardless, while OAuth 2.1 is a second mechanism layered on top. For a
single-owner prototype whose exit gate is a working pilot, building an
authorization server first would delay the thing being proved without changing
what the pilot proves.

## Decision

**Phase 0 authenticates by signature alone.** Possession of an agent's Ed25519
private key authenticates a request; scopes authorize it. OAuth 2.1 and optional
mTLS move to Phase 1.

Concretely:

- Every request carries `x-agentbridge-{workspace,agent,timestamp,signature}`.
- Envelope-bearing writes are signed over JCS (RFC 8785) of the envelope minus
  `sig`. Requests without an envelope are signed over a canonical descriptor:
  method, path, sorted query, `sha256(body)`, timestamp.
- Replay is bounded by a ±300 s timestamp window plus a per-request nonce.
- Key status is checked **inside** signature verification, so revoking a key
  takes effect on that agent's very next request.

This is recorded as an explicit deviation in the PRD's security table rather
than left implied, so nobody later reads the PRD and assumes OAuth is present.

## Consequences

**Good**

- No invariant is weakened. Every message is still signed per agent, and no
  agent posts as a human account — which is what §1.2 asks for.
- There is no authorization server to run, no token endpoint, no refresh flow,
  and no client registration, in a phase that has exactly one owner.
- Revocation is immediate and total, because there are no bearer tokens with
  independent lifetimes still floating around after a key is revoked.
- The signing path is the same one Phase 1 keeps. OAuth is additive, not a
  replacement.

**Bad, or at least a cost**

- An agent's private key is a long-lived credential with no expiry. Compromise
  is bounded only by the owner noticing and revoking. OAuth's 15-minute tokens
  would bound it automatically.
- There is no delegation: an agent cannot act with a narrowed subset of its own
  authority for one call. Scopes are per agent, not per request.
- Registration cannot be signature-authenticated at all — the agent has no
  registered key yet — which needed its own mechanism. See
  [0004](0004-gate-agent-registration.md).
- Clock skew is now load-bearing. A sender more than 300 s out is rejected, and
  the symptom (`unauthenticated`) does not obviously say "check your clock".

**Neutral but worth knowing**

- The owner's approval signature is a *separate* signature from the request
  signature, and they do different jobs: the owner key signs the decision inside
  the body, while the HTTP request itself is signed by whichever agent submitted
  it. Conflating the two cost a round of debugging in the CLI.

## Alternatives considered

**OAuth 2.1 in Phase 0 as specified** — honour the PRD exactly. Rejected for
sequencing: it requires an authorization server, token issuance and refresh,
client registration, and the storage to back all three, none of which the pilot
needs to prove that two agents can hand each other work. It also would not have
removed the Ed25519 requirement, so it was strictly additional work.

**Bearer tokens without OAuth** — issue an opaque long-lived token per agent at
registration and check it on each request. Simpler than OAuth and familiar.
Rejected: a bearer token is replayable by anyone who captures it, so it would
not satisfy §1.2's "signed by its agent, verified on receipt", and we would then
be maintaining two credentials per agent instead of one.

**mTLS only** — authenticate at the transport. Rejected: it does not sign the
*message*, so a compromised proxy could alter a body after authentication, and
`CLAUDE.md` §1.2 is about message provenance, not channel identity. It is also
awkward for an agent like Claude that connects over stdio via a local MCP binary
rather than as an HTTPS client.

**No auth in Phase 0, add it later** — it is a local prototype. Rejected
outright: the spec contemplates running on a small VPS, and the approval gate is
meaningless if anyone who can reach the hub can act as any agent. The
registration hole found in final review (ADR 0004) is a small demonstration of
how fast that goes wrong.
