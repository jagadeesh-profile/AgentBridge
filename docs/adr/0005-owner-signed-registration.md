# 0005 — Owner-signed agent registration

- **Status:** accepted
- **Date:** 2026-10-21
- **Deciders:** owner (Jagadeesh), lead
- **Supersedes:** [0004](0004-gate-agent-registration.md) (shared registration token)
- **Relates to:** [0002](0002-signature-only-auth-phase-0.md); `CLAUDE.md` §1.2, §1.8, §7
- **Contract:** breaking; `CONTRACT_VERSION` 0.2.0 → 0.3.0

## Context

[ADR 0004](0004-gate-agent-registration.md) closed a real hole — `POST /v1/agents`
was wholly unauthenticated — by requiring a shared secret. It also named its own
replacement, and this is it.

The token worked but was the weakest primitive in the system. Everything else
authenticates a *principal* via Ed25519; registration authenticated only
*possession of a secret*. Concretely:

- The audit row for `agent.register` could not name who enrolled, because the
  hub never learned. It recorded the new agent's ref and nothing about the
  actor.
- `scopes` is caller-chosen, so anyone holding the token could grant themselves
  `request_side_effect`. The token was therefore as sensitive as the owner key
  for enrolment purposes, while being handled like a config value — sitting in
  compose files, shell history and CI variables.
- It had no rotation story: changing it meant restarting the hub and
  redistributing it.

Meanwhile the owner already has an Ed25519 key, used to sign approvals. The
credential needed to do this properly already existed.

## Decision

**Registration is authorised by the owner's Ed25519 signature.** The shared
token is removed, not deprecated — leaving both paths would mean the weaker one
still defines the security of the endpoint.

The owner signs a dedicated descriptor, `registrationDescriptor`:

```
agentbridge-register-v1
<workspace>
<name>
<public_key>
<scopes, sorted, comma-joined>
<"-" | "url:<webhook_url>">
<issued_at>
```

Sent as `x-agentbridge-owner-signature` with `x-agentbridge-timestamp`, and
verified against the `ownerPublicKey` the hub already holds for approvals.

Four properties were chosen deliberately:

1. **Every field an attacker would want to vary is bound.** A captured
   signature cannot be retargeted to another `workspace`, re-pointed at a
   different `public_key`, widened with extra `scopes`, or redirected to
   another `webhook_url`. Each has its own test.
2. **A dedicated descriptor, not `requestDescriptor`.** The generic request
   descriptor covers method, path, query, body and timestamp — but *not* the
   workspace, which arrives as a header. For an agent request that is safe,
   because the agent only exists in one workspace and the lookup fails
   elsewhere. Registration has no such lookup, so the workspace had to be bound
   explicitly.
3. **Replay is checked before anything else can succeed**, reusing the nonce
   store keyed on the signature hash. Re-submitting a past enrolment fails as a
   replay rather than as a name conflict — the more accurate answer, and it does
   not leak whether that name exists.
4. **The hub re-reads the body and rebuilds the descriptor from it**, rather
   than trusting a client-supplied summary. What is verified is what will be
   stored.

`scopes` are sorted before signing: the owner authorised a *set*, not an order.

## Consequences

**Good**

- Enrolment now authenticates the owner, not a secret-holder. `CLAUDE.md` §1.2's
  "every message is signed by its agent" has an analogue at the one boundary
  that previously had none.
- No new credential. One fewer secret to distribute, store, rotate or leak —
  `AGENTBRIDGE_REGISTRATION_TOKEN` is gone from compose, the CLI and the docs.
- Scope escalation is structurally impossible rather than policy-prevented: the
  scopes are inside the signed material.
- The signature is a durable artefact. It can be archived as evidence of what
  the owner authorised, which a token cannot be.

**Bad, or at least a cost**

- **Breaking change.** Any caller using the token is now rejected. Phase 0 has
  one owner and no external consumers, so the blast radius is the local setup;
  it would not be acceptable after a public release. `CONTRACT_VERSION` is
  0.3.0 and `CLAUDE.md` §7 would normally require stopping to ask — the owner
  requested this change directly, which is that approval.
- The owner key is now needed at enrolment time, not just at approval time. In
  Phase 0 both live with the CLI, so this is free; when the console takes over
  approvals it must also take over enrolment, or the key ends up in two places.
- Clock skew now affects registration too: a signature more than 300 s out is
  rejected, and the symptom (`unauthenticated`) does not say "check your clock".
- The audit row still records `agent.register` against the new agent's ref. The
  hub now *knows* the owner authorised it, so recording that is a small
  follow-up rather than an open question.

## Alternatives considered

**Keep the token, add signing as an option.** Rejected: an endpoint's security
is defined by its weakest accepted path, so leaving the token meant nothing
actually improved. A clean break is cheap now and expensive later.

**Sign with `requestDescriptor` and the owner key.** Appealing because it reuses
the existing scheme with no new helper. Rejected because it does not bind the
workspace, which for registration is attacker-controlled and decides which
owner's space the agent lands in. Extending `requestDescriptor` to include the
workspace would have invalidated every agent signature in the system — a far
larger break for a narrower need.

**Invite codes — one single-use token per agent.** Better than a shared secret:
bounded blast radius, individually revocable. Still rejected: it is a second
credential system to build and operate, and it authenticates a code rather than
the owner. Worth revisiting only if enrolment becomes self-service, where the
owner cannot be present to sign.

**Put the signature in the body rather than a header.** Matches the approval
decision, which carries `sig` in its payload. Rejected for consistency with the
rest of the API, where request-level signatures are headers and only the
*owner's decision content* is a body field. Registration is authorising a
request, not recording a decision.
