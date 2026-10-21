# Phase 0: the AgentBridge hub, in TypeScript, with the owner console

Implements FR-1 … FR-8 plus the MCP server, the TypeScript SDK, the
`agentbridge` CLI, the owner console and the Claude ↔ Muse pilot. 34 commits,
each TDD'd with its own green gate.

**Adopts TypeScript**, replacing the Python 3.12 / FastAPI stack the repo
previously specified. Rationale and full design in
[`docs/superpowers/specs/2026-10-20-agentbridge-phase0-typescript-design.md`](docs/superpowers/specs/2026-10-20-agentbridge-phase0-typescript-design.md);
the task-by-task plan in
[`docs/superpowers/plans/2026-10-20-agentbridge-phase0.md`](docs/superpowers/plans/2026-10-20-agentbridge-phase0.md).

## What works

```bash
make setup
agentbridge keygen --out owner.key
export AGENTBRIDGE_OWNER_PUBLIC_KEY=<the printed public key>
make dev                                      # hub in Docker on :8080
pnpm --filter @agentbridge/console run dev     # console on :3000
make check && make test-e2e && make conformance
make test-container                            # builds and drives the real image
```

| Gate | Result |
|---|---|
| `make check` — lint, `tsc --strict`, unit tests, contract-drift | **505 tests** (33 files) |
| `make test-e2e` — real hub: SQLite on disk, delivery worker, real ports | **24 tests** |
| `make conformance` — MCP tool surface | **8 tests** |
| `make test-container` — the real Docker image, HTTP only | **20 tests** |
| `pnpm --filter @agentbridge/console run build` | compiles |

Tracing exports over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and
the caller's `trace_id` becomes the real OTel trace id so one trace spans both
agents. Verified against a live collector: spans arrive carrying the caller's
trace id, with no body-bearing attribute and no span for `/healthz`.

## Architecture

Ports-and-adapters, one container. The domain depends only on six interfaces
(`Store`, `Queue`, `BlobStore`, `Clock`, `IdGen`, `Signer`); Phase 0 implements
them with SQLite, a durable outbox plus a per-thread scheduler, and the local
filesystem. Those interfaces are the Phase 1 migration surface — DynamoDB, SQS
FIFO, S3 and KMS each become one new file.

Contracts are Zod-first. JSON Schema and `openapi.yaml` are generated into
`contracts/generated/` and drift-checked in CI, so the hub, SDK, MCP adapter and
console cannot diverge.

| Package | Contents |
|---|---|
| `contracts/` | Envelope, transition table as data, error catalog, JCS canonicalization, Ed25519 signing, the audit chain rule |
| `hub/` | Ports, SQLite + filesystem adapters, domain (registry, threads, tasks, artifacts, approvals, audit, inbox), Fastify API |
| `delivery/` | Per-thread outbox scheduler, HMAC webhook push, jittered backoff, DLQ, composition root |
| `sdk/typescript/` | `Client`, `OwnerClient`, `Agent.onTask`, `Untrusted<T>`, `verifyWebhook`, local key management |
| `adapters/mcp/` | stdio MCP server — seven tools, a thin REST client of the hub |
| `cli/` | `keygen`, `register`, `pending`, `approve`, `tasks`, `agents`, `revoke`, `inbox`, `audit verify` |
| `console/` | Owner console (Next.js): approvals, task board, kill switch, audit viewer |
| `examples/claude-muse/` | The pilot: one handler, three transports |

## Two decisions a reviewer should start with

### The owner is a principal, not a borrowed agent

`POST /v1/approvals` originally authenticated as an *agent*, and the owner is
not one — the CLI passed `--agent-key` alongside `--owner-key` and borrowed that
identity to carry the request. Survivable in a terminal; not in a browser, where
the console would have had to hold an agent key as well as the owner key, and
the audit log named whichever agent was borrowed.

Owner-facing routes now verify an Ed25519 signature from the owner
([ADR 0006](docs/adr/0006-owner-authenticated-routes.md)). `ownerRequestDescriptor`
binds the **workspace**, which the agent descriptor does not: an agent exists in
one workspace so the lookup fails elsewhere, but the owner has no such lookup,
and the header alone would otherwise decide whose workspace is acted on. A
leading version tag gives domain separation, so an agent's own signature cannot
be replayed as an owner signature — there is a test for exactly that.

### Clients recompute; they do not take the hub's word

Two places where trusting the hub would make a check meaningless:

- **Approvals.** The signed `payload_hash` is recomputed from the payload the
  client displayed, never read from the response. Signing the hub's figure would
  approve whatever the hub asserted. `contracts` became isomorphic
  (`@noble/hashes` instead of `node:crypto`) specifically so the console can do
  this in the page.
- **Audit.** `GET /v1/audit/verify` is the hub attesting to its own log; one
  that had rewritten a row would answer "intact". `GET /v1/audit` returns rows
  with their hashes and the console recomputes the chain with the same rule the
  hub appends with, shared from `contracts` so the two cannot drift.

## Invariants, and how each is held

| `CLAUDE.md` §1 | Mechanism |
|---|---|
| Messages are data, never authority | Bodies are wrapped `{untrusted, provenance, value}` on both push and pull. `Untrusted<T>` yields a placeholder from template literals, `String()`, `JSON.stringify` and `console.log` — a test per leak path, using an injection string as the payload. |
| Every message signed per agent | Ed25519 over JCS (RFC 8785). Key status is checked **inside** verification, so revocation applies on the next request. |
| Side effects stop at the approval gate | A `side_effect` task is created into `needs-approval` and gets **no outbox row** — the assignee never sees it. Approval checks owner signature → single-use → hash against the *current* payload. Owner routes are unreachable by any agent identity. |
| At-least-once delivery, exactly-once effect | Idempotency keys with in-process coalescing, so two concurrent callers perform the effect once and both receive the same response. |
| Ordering per thread | Durable outbox; the claim rule is "oldest live row of a thread with nothing inflight, and only if due" — a later row cannot overtake one mid-backoff. |
| The hub stores no secrets | No field for a model key anywhere. Outbound content is redacted (Luhn-checked cards, token shapes) before it leaves. The console stores none either: the owner key is loaded per session and held in memory only, enforced by tests that grep its sources for storage APIs. |
| No LLM calls in the hub | None. |
| Least privilege | New agents get `read` + `message`; `request_side_effect` is additionally required to create a gated task; the owner's signature over the enrolment binds the scopes, so an agent cannot widen its own. |
| Audit append-only, hash-chained | SQLite `BEFORE UPDATE`/`DELETE` triggers that `RAISE(ABORT)` — they refuse an `UPDATE` even on a raw connection, since they live in the schema rather than the hub. The chain is the defence against the edit that goes around them, and the console checks it. |

## Deliberate deviations from the PRD

- **Phase 0 auth is signature-only.** OAuth 2.1 and mTLS move to Phase 1.
  Recorded in the PRD's security table rather than left implied.
- **`node:sqlite` instead of `better-sqlite3`.** Same synchronous semantics, no
  native dependency to build for two platforms. Verified triggers, WAL,
  transactions and `.changes` before switching.
- **The console shipped inside Phase 0** rather than after it; A2A, the Python
  SDK (now FR-18) and the CDK stacks remain out of scope.

## Review notes

Writing tests first caught **seventeen defects in the plan**, each fixed with a
failing-first test. The full table is in [`docs/TASKS.md`](docs/TASKS.md); the
ones worth a reviewer's attention:

- Idempotency was not exactly-once — both concurrent callers ran the body and
  only the second *response* was discarded, after its rows were written.
- `listInbox` derived its cursor from the last item it built rather than the
  last row the store returned. One orphaned row would have wedged an agent's
  inbox permanently. Found by writing the module's first unit tests.
- The replay nonce was keyed on the timestamp, so two different requests in one
  millisecond collided; replay rejection then had to be scoped to unsafe unkeyed
  writes so it would not break the safe retry §1.4 promises.
- `actorFor` trusted a synthetic `agent:<ws>-owner` ref — registrable, therefore
  impersonatable.
- `.dockerignore` excluded `dist` but not `*.tsbuildinfo`, making the image
  build a silent no-op; `pnpm prune --prod` then stripped the workspace links.
  Both surfaced only because the container was actually run.
- `fetch` was stored unbound on both SDK clients. Node tolerates it; a browser
  rejects it outright. Only running the console in a real page caught it, and
  the regression test asserts the receiver so it now fails in Node too.

### Four security fixes, and the guard that should have prevented three of them

| Route | Was | Why it mattered |
|---|---|---|
| `POST /v1/agents` | unauthenticated | Anyone reachable could enrol an agent into the owner's workspace and message their agents ([ADR 0004](docs/adr/0004-gate-agent-registration.md) → [0005](docs/adr/0005-owner-signed-registration.md)) |
| `DELETE /v1/agents/{ref}/key` | any agent, no scope check | An agent with the default `read`+`message` could revoke every other agent — there is no `revoke` scope to have checked |
| `DELETE /v1/tasks/{id}` | any agent | `cancelTaskAsOwner` writes `actor: 'owner'`, so an agent could forge that attribution **inside the append-only hash chain**, where it cannot be edited out |
| `GET /v1/audit/verify`, `GET /v1/dlq` | any agent | Workspace-wide views: full history and every other agent's delivery failures |

Three of these were the same mistake — owner semantics behind `requireAgent` —
found one at a time by hand. `hub/src/http/route-guards.test.ts` now pins every
route to a declared bucket (open / owner / agent) and fails on one that is
added, moved or left unclassified. It asserts the route count first so it cannot
pass vacuously, and cross-checks `OWNER_ROUTES` against the handlers calling
`requireOwner` — a route in one but not the other is broken either way.

### Verified by breaking it, not only by testing it

- The approval gate, kill switch and task board were driven in a real browser
  against a real hub. The task board's `include_payload=false` guarantee was
  checked by asserting the payload text is absent from the page, not just from a
  unit-test response.
- The audit viewer was checked by dropping the database's append-only triggers
  and editing a row directly: the console reported `hash-mismatch at seq 1`,
  flagged every row from the break, and marked the tab.
- Moving the chain rule into `contracts` exposed a gap the old walk had: it
  compared hashes but not `seq`, so a **deleted** row could be hidden by serving
  the page around it. The shared verifier checks sequence continuity.

`make test-container` builds the image, boots it with a generated owner key on a
fresh volume, and drives it over HTTP only — no `Store` handle exists on that
side of the boundary. It covers what the in-process suite structurally cannot:
the env contract, the entrypoint and workspace links inside the image, body
redaction in the real log stream read back via `docker logs`, that state
survives `docker restart`, and the kill switch end to end. Kept out of
`make check` and CI — a build-plus-boot is minutes, not seconds.

> ⚠️ **Nothing here has been reviewed by a second party.** Every task, every
> security fix and every verification was written by the same session. That
> includes four owner-auth migrations and the three audit/authorisation fixes
> above. A fresh pair of eyes on the **approval gate**, the **owner signing
> path**, the **delivery scheduler** and the **console's key handling** is the
> one thing this branch has not had, and the review that found three of the four
> holes above is evidence that reviewing it pays.

## Breaking changes

Contract **0.1.0 → 0.7.0**, pre-1.0 so breaking changes take the minor slot.
Phase 0 has one owner and no external consumers; after a public release each of
these would need a deprecation window.

| Version | Change |
|---|---|
| 0.2.0 | adds `already_exists` (409) — additive |
| 0.3.0 | registration requires an owner signature; the shared token is gone |
| 0.4.0 | `POST /v1/approvals` is owner-signed; adds owner-only `GET /v1/tasks` |
| 0.5.0 | the kill switch is owner-signed; adds owner-only `GET /v1/agents` |
| 0.6.0 | adds `?include_payload` to `GET /v1/tasks` — additive |
| 0.7.0 | `GET /v1/audit/verify` and `GET /v1/dlq` are owner-signed; adds `GET /v1/audit`. `Client.verifyAudit` / `Client.listDeadLetters` removed in favour of `OwnerClient` |

`agentbridge approve`, `revoke` and `audit verify` no longer take
`--agent`/`--agent-key`; they take `--owner-key`.

## Known follow-ups

- `withIdempotency` coalescing is per-process; Phase 1 needs a durable
  reservation protocol once delivery splits out.
- `wipeKey` zeroing the console's key buffer on lock is best-effort — the engine
  may have copied it, and GC timing is not ours.
- The console re-asks for the key file every session. Deliberate, and WebAuthn
  ([ADR 0004](docs/adr/0004-gate-agent-registration.md)) is the way out.
- The audit viewer renders `subject` verbatim. Subjects are hub-generated and a
  test asserts no payload reaches the response, but anything added to a subject
  becomes owner-visible by default.

## Phase 0 exit gate

Not yet met — it requires the Claude ↔ Muse link running relay-free for seven
consecutive days, and the MCP path has not been exercised against a live Claude
client. Everything needed to start the clock is here:
`examples/claude-muse/scripts/pilot.sh` runs the full exchange unattended and
exits non-zero on any failure, including a specific check that the approval gate
did not leak.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
