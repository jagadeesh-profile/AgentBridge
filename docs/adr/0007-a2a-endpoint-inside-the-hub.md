# 0007 — The A2A endpoint lives inside the hub, not behind a proxy

- **Status:** accepted
- **Date:** 2026-10-21
- **Deciders:** owner (Jagadeesh), lead
- **Relates to:** [0002](0002-signature-only-auth-phase-0.md) (signature-only auth),
  [0006](0006-owner-authenticated-routes.md); `CLAUDE.md` §1.1, §1.2, §2
- **Contract:** additive; A2A is a new surface, no existing route changed

## Context

`CLAUDE.md` §2 places `adapters/a2a/` alongside `adapters/mcp/`, and the MCP
adapter is a thin REST client of the hub with a test asserting it imports no
hub internals. Building A2A the same way looked obvious and is wrong.

MCP is an **outbound stdio client**: it holds the agent's key, signs its own
requests, and the hub sees an ordinary REST call. A2A is an **inbound HTTP
server**: a remote agent signs a request and sends it to us.

An Ed25519 request signature covers the method, path, sorted query, body hash
and timestamp of the request it was made for (`requestDescriptor`). A proxy
that received `POST /a2a/v1` carrying a JSON-RPC envelope and then issued
`POST /v1/tasks` with a different body would be holding a signature for a
request that no longer exists. There are only two ways to make that work, and
both are unacceptable:

1. **Have the hub trust a header** saying which path was really signed. That
   discards the guarantee: the body differs too, so the hub would be verifying
   a signature over something other than what it is about to act on.
2. **Re-sign with the adapter's own key.** The adapter becomes a confused
   deputy — every remote caller inherits its scopes, and the audit log names
   the adapter rather than whoever actually asked.

I started down path 1 before noticing, which is the honest reason this ADR
exists.

## Decision

**The A2A routes are hub routes.** `hub/src/http/a2a.ts` registers
`/.well-known/agent-card.json` and `POST /a2a/v1`, and the hub's existing
`preHandler` authenticates the caller. `req.agent` is the remote agent; the
handler calls the same domain functions as every other route.

**`adapters/a2a/` keeps the protocol and nothing else** — the Agent Card
builder, the JSON-RPC envelope, and the AgentBridge↔A2A mapping. It imports
`contracts` only, has no I/O and no identity, and the hub imports it. The
package boundary in `CLAUDE.md` §2 survives; what moved is the *routing*, not
the protocol.

### Mapping decisions

- **`needs-approval` → `auth-required`.** A2A has no approval gate. This is
  the closest honest answer: the task is blocked pending an authorisation the
  caller cannot supply. `working` would be a lie — nothing is happening — and
  `input-required` invites input that would not release it. The AgentBridge
  state is also surfaced in `metadata["agentbridge/state"]`, because
  `auth-required` with no explanation is a dead end.
- **`accepted` → `working`.** A2A has no `accepted`. The lost distinction is
  one an A2A caller could not act on anyway.
- **`tasks/cancel` uses the creator transition, not the owner cancel.** A
  remote agent may cancel work it created and nothing else. The transition
  table enforces that, not the adapter.
- **`metadata["agentbridge/assignee"]` is required on `message/send`.** A2A
  addresses an endpoint; AgentBridge addresses a named agent. The hub refuses
  rather than guessing, because a guess routes someone's work to an arbitrary
  agent.

### Push notifications, and the SSRF they would otherwise be

`tasks/pushNotificationConfig/set` lets a caller name a URL the hub will then
POST to. Taken literally that is an SSRF primitive: cloud metadata endpoints,
internal services, anything the hub can reach from inside the network.

**The push URL must share an origin with the calling agent's registered
webhook** — the origin the owner signed at enrolment (ADR 0005). The caller
chooses the path; it cannot choose the host. Push can therefore only ever
reach a destination the owner already authorised, so there is no new
destination to vet and no allowlist to maintain. An agent with no registered
webhook cannot use push at all, which is correct rather than restrictive: it
has no authorised origin, and the pull inbox already serves it.

Delivery reuses `pushOnce` rather than adding a second sender, so retries,
jittered backoff, the dead-letter queue, outbound redaction and HMAC signing
all apply unchanged — a parallel path would have had to re-earn each of them.
The notification carries the A2A `Task` shape and **no payload**: a state
change is the notification, and detail comes from `tasks/get` over an
authenticated channel. The caller's `token` rides in
`x-a2a-notification-token`, and is never echoed back by
`pushNotificationConfig/get` — otherwise a read becomes a way to recover a
secret from a task id.

`streaming` stays **false** on the card, and `message/stream` returns `-32004`
with a reason. Advertising a capability and stubbing it is worse than
declining: a caller that reads `streaming: true` and gets a non-stream has no
recourse, while one that reads `false` polls `tasks/get`, which works.

## Consequences

**Good**

- The signature covers exactly what the hub verifies. No new trust assumption,
  no second auth model, and §1.2 holds across a third protocol.
- The audit log names the remote agent, because it *is* the authenticated
  principal.
- Scopes already work: an agent without `request_side_effect` cannot create a
  gated task over A2A any more than over REST. Nothing needed re-implementing.
- `adapters/a2a/` is pure and trivially testable; the hub side is routing.

**Bad, or at least a cost**

- `hub/` now depends on `@agentbridge/a2a`, so a protocol change touches a
  package the `protocol-adapters` owner does not own. The split keeps that
  surface small, but it is a real crossing of §2's ownership line and should
  be revisited if A2A grows.
- The hub serves a protocol it did not before, widening its attack surface by
  one unauthenticated endpoint (the card) and one authenticated one. The card
  is covered by a test asserting it discloses no workspace content.
- Two discovery paths are served (`agent-card.json` and the pre-1.0
  `agent.json`) because clients in the wild fetch both. One more thing to keep
  in step.
- Push config is keyed by task, so `pushOnce` must check the config's agent
  matches the row's recipient — otherwise one party's URL would receive the
  other party's notifications. There is a test for it, but it is the kind of
  coupling that invites a future bug.
- No A2A conformance suite yet. Coverage lives in `hub/src/http/a2a.test.ts`;
  `make conformance` still means MCP. A real suite should run against the
  published spec rather than against my reading of it.

## Alternatives considered

**A proxy in `adapters/a2a/`, like MCP.** Rejected for the signature reasons
above. Worth recording that it is the shape `CLAUDE.md` §2 implies, and that
the implication does not survive contact with inbound auth.

**Give the A2A endpoint its own registered agent identity.** The standard
gateway pattern, and it would have kept the proxy. Rejected: every remote
caller would act with one identity and one scope set, so an agent that should
only `read` could create side-effect tasks if the gateway could. The approval
gate would still hold, but attribution — the thing the audit chain exists for —
would be destroyed.

**Bearer tokens for A2A, as most A2A deployments use.** Rejected: it is a
second, weaker authentication scheme sitting beside the Ed25519 one, and the
weakest accepted path defines the endpoint's security (the same reasoning as
ADR 0005 on the registration token). OAuth 2.1 remains the Phase 1 direction
and would slot in as an additional declared scheme, not a replacement.

**Translate A2A `Task` lifecycle onto threads rather than tasks.** A2A's
`contextId` maps naturally to a thread and its `Task` to a task, which is what
was done. Mapping A2A tasks onto AgentBridge *messages* would have avoided the
state-mapping problem entirely but lost the approval gate, which is the one
thing this hub exists to provide.
