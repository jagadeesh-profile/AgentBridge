# 0006 — Owner-authenticated routes, and where the owner key lives

- **Status:** accepted
- **Date:** 2026-10-21
- **Deciders:** owner (Jagadeesh), lead
- **Extends:** [0005](0005-owner-signed-registration.md) (owner-signed registration)
- **Relates to:** [0002](0002-signature-only-auth-phase-0.md); `CLAUDE.md` §1.3, §1.6, §7
- **Contract:** breaking; `CONTRACT_VERSION` 0.3.0 → 0.4.0

## Context

Building the owner console surfaced two problems that the CLI had been hiding.

**The owner had no identity.** `POST /v1/approvals` ran through agent
authentication, but the owner is not an agent and has no agent key. The CLI
coped by taking `--agent` and `--agent-key` alongside `--owner-key` and
borrowing that agent's identity to carry the request. The owner's signature
rode in the body; the request itself was signed by whichever agent was handy.

That is survivable in a terminal and not in a browser. A console doing the same
would have to hold **two** secrets, and the one it least needs — an agent key —
would be the one authenticating every call. The audit trail recorded the
borrowed agent, not the owner.

**There was no way to ask what was waiting.** `GET /v1/tasks/:id` reads one task
by id. `agentbridge approve --task <id>` required an id you already knew, which
in practice meant reading it out of a log. An approvals queue has to be able to
ask the question "what needs me?", and nothing could.

A third constraint came from the console's own shape. The gate's guarantee is
that the owner approves *the payload they were shown*: the CLI recomputes the
hash from the payload it just printed rather than trusting any supplied value.
A console must do the same, in the page — which means hashing in a browser.
`contracts` hashed with `node:crypto`.

## Decision

**Owner-facing routes verify an Ed25519 signature from the owner**, extending
ADR 0005's scheme from enrolment to the rest of the owner's surface. Three
parts.

### 1. `ownerRequestDescriptor`

```
agentbridge-owner-v1
<workspace>
<the agent requestDescriptor: METHOD, path, sorted query, sha256(body), timestamp>
```

Two properties beyond reusing `requestDescriptor`:

- **The workspace is bound.** `requestDescriptor` omits it, which is safe for an
  agent — the agent exists in exactly one workspace, so the lookup fails
  anywhere else. The owner has no such lookup, so an unbound workspace would let
  a signature valid for one workspace act on another. `authenticateOwner`
  returns the workspace it verified, and handlers take it from there rather than
  from the header.
- **The version tag gives domain separation.** Without it an agent signature
  over `POST /v1/approvals` would verify as an owner signature — an agent
  clearing its own gate. There is a test for exactly that.

Replay is checked before anything else succeeds, on the same signature-hash
nonce as registration.

### 2. `GET /v1/tasks?state=needs-approval`

Owner-only, matched on method *and* path — `POST /v1/tasks` remains an agent
creating work. Returns the payload and the hub's `payload_hash` so a client can
compare the two. Oldest first, so the queue is FIFO and the longest-blocked task
is at the top; migration 002 adds `tasks(workspace, state, created_at, id)`,
since the existing index leads with `assignee` and cannot serve a query that
does not know one.

### 3. The owner key stays in the browser

The console reads the key file the owner picks, parses it in the page, and holds
it in component state. Never uploaded, never in `localStorage`,
`sessionStorage`, `IndexedDB` or a cookie; closing the tab ends the session.
The Next.js app has **no API route** — its only server behaviour is a
path-preserving rewrite of `/v1/*` to the hub, which keeps requests same-origin
(no CORS on the hub) and keeps the signed path equal to the verified path.

This required `contracts` to become isomorphic: `sha256Hex` now uses
`@noble/hashes` instead of `node:crypto`, and `@agentbridge/sdk/owner` is a
subpath export that avoids `keys.ts` and its `node:fs`.

`OwnerClient.decide` recomputes the payload hash rather than sending the task's
advertised one. A client that signed the hub's figure would approve whatever the
hub asserted — the gate would be verifying a signature over the hub's own claim.

## Consequences

**Good**

- One secret for the owner, and it is the one that already meant something.
  `agentbridge approve` lost two required flags.
- The owner is a real principal. `CLAUDE.md` §1.3's "the owner signs an
  approval" is now true of the request as well as the payload.
- An agent cannot reach the approval endpoint at all, rather than being stopped
  one layer in by the body signature. Defence moved outward.
- §1.6 ("the hub stores no secrets") gains a sibling: the console stores none
  either. Enforced by tests that grep its sources for storage APIs and `node:`
  imports, plus a third asserting the file list is non-empty — a guard over an
  empty directory passes forever.

**Bad, or at least a cost**

- **Breaking**, again, and this one hits anything that automated approvals
  through the SDK. Phase 0 has one owner and no external consumers; after a
  public release this would need a deprecation window.
- The owner re-picks the key file every session. That is the deliberate cost of
  not persisting it, and it will annoy. WebAuthn (ADR 0004) removes it.
- `wipeKey` zeroing the buffer on lock is best-effort. The engine may have
  copied it and GC timing is not ours; it narrows the window, it does not close
  it.
- Two descriptor formats now exist. A third would be a smell — the next
  owner-facing route should reuse this one, not invent another.
- `GET /v1/tasks` returns full payloads to the owner. Correct — they must read
  what they are approving — but it means the owner route is the one place a
  whole payload crosses the wire, and it must never be logged.

## Alternatives considered

**Give the owner an agent identity.** A reserved `agent:owner` would need no new
auth path. Rejected: it was registrable and therefore impersonatable, which is
the defect already fixed once when `actorFor` trusted a synthetic
`agent:<ws>-owner`. Making the owner a kind of agent also inverts the model —
the owner authorises agents, not the reverse.

**Keep agent auth and add owner signing alongside.** Nothing breaks. Rejected
for the reason ADR 0005 rejected it for registration: an endpoint's security is
its weakest accepted path, so leaving the agent path in place would mean nothing
improved.

**Hold the owner key in the Next.js server.** Much simpler — no file picker, no
re-unlock, signing in a route handler. Rejected: it puts the key that authorises
every side effect in the workspace on a long-lived process, where anyone who can
reach the process can approve. The console would become a more attractive target
than the hub.

**Persist the key in IndexedDB.** Survives reload, which matters over a
seven-day pilot. Rejected for Phase 0: a key at rest in a browser profile is
readable by any script on the origin and by anyone with the disk. Worth
revisiting only behind WebAuthn or a passphrase-wrapped key, where the stored
material is not the key itself.

**A `/v1/approvals/pending` route instead of `GET /v1/tasks`.** More obviously
named for the job. Rejected: the console's next views (task board, history) need
to list tasks in other states, and a state filter covers all of them without a
second listing endpoint drifting from the first.
