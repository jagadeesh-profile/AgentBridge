# 0004 — Gate agent registration behind a shared token

- **Status:** superseded by [0005](0005-owner-signed-registration.md)
- **Date:** 2026-10-20
- **Deciders:** lead (finding), owner (accepted)
- **Relates to:** [0002](0002-signature-only-auth-phase-0.md); `CLAUDE.md` §1.2,
  §1.8; PRD security table

> **Superseded.** The shared token was always a stopgap; this ADR named
> owner-key-signed registration as its replacement, and
> [0005](0005-owner-signed-registration.md) implements it. The hole and the
> reasoning below are kept because they explain why the gate exists at all.

## Context

Found during the final review of the Phase 0 branch, after all 21 planned tasks
were complete and green.

`POST /v1/agents` was on the hub's open-path list alongside `/healthz`, so it
required no authentication at all. The workspace it registers into arrives as a
caller-supplied header (`x-agentbridge-workspace`), and a newly registered agent
receives the default `read` + `message` scopes.

Taken together: **anyone who could reach the hub could enrol an agent into
someone else's workspace and immediately send messages to that owner's real
agents.** Not remote code execution — inbound content is untrusted-wrapped and
turn-capped, and side effects still stop at the approval gate — but it is
unauthorized write access to an owner's threads, and it lets an attacker put
content in front of the owner's agents.

The reachability is not hypothetical. The design explicitly contemplates Phase 0
running "on a laptop or a small VPS", and a VPS means a public interface.

The reason the hole existed is structural rather than careless: registration is
the one operation that **cannot** be signature-authenticated under ADR 0002,
because the agent has no registered key yet. Every other route verifies a
signature against a stored public key; this one has nothing to verify against,
so it was left open.

## Decision

Registration requires a **shared secret**, supplied as
`x-agentbridge-registration-token` and compared in constant time.

Three properties were chosen deliberately:

1. **`registrationToken` is a required field on `AppDeps`, not optional.** An
   optional gate defaults to open, and a security gate must fail closed. The
   type system now refuses to construct a hub without one.
2. The composition root demands `AGENTBRIDGE_REGISTRATION_TOKEN` at boot, like
   the owner public key, and `docker-compose.yml` declares it with no default —
   so a misconfigured deployment refuses to start rather than starting
   permissively.
3. The comparison is length-checked **before** `timingSafeEqual`, because that
   function throws on a length mismatch and a short token must not be able to
   turn into a 500.

Verified RED→GREEN: four tests (no token, wrong token, right-length-wrong-
content, and a correctly-tokened registration still receiving exactly
`read` + `message`) failed before the change. That failure is what established
the hole was real rather than theoretical.

## Consequences

**Good**

- Enrolment is now an owner-authorised action, which is what `CLAUDE.md` §1.8's
  "new agents get `read` + `message` only; other scopes are granted explicitly"
  was always assuming.
- The gate is checked in the same `preHandler` that authenticates everything
  else, so there is one place where "is this request allowed in" is decided.
- A deployment cannot accidentally be open: both secrets are required at boot.

**Bad, or at least a cost**

- A shared secret is a weaker primitive than the per-agent keys used everywhere
  else. It does not identify *who* registered, only that they held the token, so
  the audit row for `agent.register` records the new agent's ref and not an
  authenticated actor.
- The token has no rotation story in Phase 0. Rotating it means restarting the
  hub with a new value and re-distributing it.
- `scopes` is still caller-chosen at registration, so whoever holds the token
  can grant themselves any scope including `request_side_effect`. That is
  coherent — the token is the owner's secret, so holding it *is* owner authority
  — but it means the token is as sensitive as the owner key for enrolment
  purposes, and should be treated that way.
- One more required environment variable, and one more thing to get wrong when
  standing the hub up. The compose file's `:?` guard makes the failure loud.

## Alternatives considered

**Sign registration with the owner key** — the owner already has an Ed25519 key
for approvals; require a signature from it to enrol. Strictly better on
identity: it authenticates *the owner*, not merely a secret-holder, and needs no
new credential. Rejected for Phase 0 only because the owner key currently lives
with the CLI and the registration flow is also used by the SDK quickstart and
the pilot seed script, which would all need the owner key to hand. **This is the
preferred Phase 1 design** and should replace the token when the console (which
holds the owner key via WebAuthn) becomes the enrolment surface.

**Invite codes — one single-use token per agent** — the owner mints a code per
enrolment. Better than a shared secret: it bounds blast radius and gives each
registration a distinct, revocable grant. Rejected for Phase 0 as more machinery
(issuance, storage, expiry, single-use enforcement) than a single-owner
prototype needs, but it is the natural step if enrolment ever becomes
self-service.

**Bind registration to a pre-created workspace membership** — the owner
pre-declares which agent names may exist. Rejected: it is effectively invite
codes with extra steps, and Phase 0 has no workspace-management surface to
declare them in.

**Leave it open and document it** — note in the README that the hub must not be
exposed. Rejected. The documented deployment target includes a VPS, the failure
is silent, and "secure only if you read the README" is not a control.
