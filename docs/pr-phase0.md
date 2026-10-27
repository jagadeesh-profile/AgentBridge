# The AgentBridge hub, in TypeScript: Phase 0 complete, Phase 1 single-writer

Implements FR-1 … FR-8 plus the MCP server, the A2A v1.0 endpoint, the
TypeScript and Python SDKs, the `agentbridge` CLI, the owner console, the S3
artifact store, the AWS CDK stack and the Claude ↔ Muse pilot. **44 commits**,
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
make dev                                       # hub in Docker on :8080
pnpm --filter @agentbridge/console run dev     # console on :3000
make check && make test-e2e && make conformance
make test-container                            # builds and drives the real image
make test-aws                                  # S3 adapter vs LocalStack
make infra-synth                               # cdk synth only — never deploy (§7)
```

| Gate | Result |
|---|---|
| `make check` — lint, `tsc --strict`, unit tests, contract-drift | **640 tests** (37 files), + 1 deliberate skip |
| `make test-e2e` — real hub: SQLite on disk, delivery worker, real ports | **24 tests** |
| `make conformance` — MCP + **A2A v1.0** | **48 tests** |
| `make test-container` — the real Docker image, HTTP only | **20 tests** |
| `make test-aws` — S3 `BlobStore` vs LocalStack | **24 tests** |
| `make test-python` — Python SDK, cross-language vectors + a real hub | **20 tests** |
| `make infra-synth` — `cdk synth` | 740-line template, **23 assertions** on it |
| `pnpm --filter @agentbridge/console run build` | compiles |

The single skip is the S3 half of the `BlobStore` conformance suite when no
LocalStack is reachable, so `make check` stays green without Docker. Because a
silent skip is how a suite passes vacuously, `make test-aws` probes the endpoint
first and **exits 1** rather than skipping — verified by pointing it at a dead
port.

Tracing exports over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and
the caller's `trace_id` becomes the real OTel trace id so one trace spans both
agents. Verified against a live collector: spans arrive carrying the caller's
trace id, with no body-bearing attribute and no span for `/healthz`.

## Architecture

Ports-and-adapters. The domain depends only on six interfaces (`Store`, `Queue`,
`BlobStore`, `Clock`, `IdGen`, `Signer`); Phase 0 implements them with SQLite, a
durable outbox plus a per-thread scheduler, and the local filesystem.

Those interfaces were described as the Phase 1 migration surface, with
"DynamoDB, SQS FIFO, S3 and KMS each become one new file". **That turned out to
be wrong, and correcting it is one of the two things a reviewer should look at
first** — see below.

Contracts are Zod-first. JSON Schema and `openapi.yaml` are generated into
`contracts/generated/` and drift-checked in CI, so the hub, SDK, MCP adapter and
console cannot diverge.

| Package | Contents |
|---|---|
| `contracts/` | Envelope, transition table as data, error catalog, JCS canonicalization, Ed25519 signing, the audit chain rule |
| `hub/` | Ports, SQLite + filesystem + **S3** adapters, domain (registry, threads, tasks, artifacts, approvals, audit, inbox), Fastify API, the A2A routes |
| `delivery/` | Per-thread outbox scheduler, HMAC webhook push, jittered backoff, DLQ, composition root |
| `sdk/typescript/` | `Client`, `OwnerClient`, `Agent.onTask`, `Untrusted<T>`, `verifyWebhook`, local key management |
| `sdk/python/` | Python SDK (FR-18): canonicalization, signing, client, pull-inbox handler — byte-identical to TypeScript by generated vectors |
| `adapters/mcp/` | stdio MCP server — seven tools, a thin REST client of the hub |
| `adapters/a2a/` | A2A v1.0 protocol translation: Agent Card, JSON-RPC envelope, state mapping. Pure; the routes live in the hub ([ADR 0007](docs/adr/0007-a2a-endpoint-inside-the-hub.md)) |
| `cli/` | `keygen`, `register`, `pending`, `approve`, `tasks`, `agents`, `revoke`, `inbox`, `audit verify` |
| `console/` | Owner console (Next.js): approvals, task board, kill switch, audit viewer |
| `infra/` | AWS CDK — single-writer Fargate, SQLite on EFS, artifacts in S3, ALB, no NAT gateway ([ADR 0010](docs/adr/0010-single-writer-phase-1.md)) |
| `examples/claude-muse/` | The pilot: one handler, three transports |

## Four decisions a reviewer should start with

### 1. The synchronous port boundary, and what it actually permits

[ADR 0009](docs/adr/0009-the-sync-port-boundary.md). `Store` is synchronous in
**all 45 of its methods** and `Queue` in 2 of 5. Node cannot serve a synchronous
method from network I/O, so the synchronous `Store` is not the open database
choice the ports design was taken to provide — **it is a commitment to embedded
storage**, as true of Aurora and RDS as of DynamoDB.

[ADR 0008](docs/adr/0008-store-conformance-and-the-phase-1-migration.md) had
already corrected the DynamoDB estimate on atomicity grounds (the audit chain
does a read-modify-write inside `transaction()`, which `TransactWriteItems`
cannot express) but then asserted in passing that "SQS FIFO, S3 and KMS are
genuinely small". Writing the S3 adapter was the occasion to test that, and two
of the three do not survive:

- **SQS** — `claimNext`/`recoverInflight` are synchronous, and a FIFO group's
  visibility timeout is not the same rule as §1.5's "hold this thread until the
  in-flight row's backoff expires".
- **KMS** — `Signer` has **no caller anywhere in the hub**. Correctly so: agents
  hold their own keys (§1.2, §1.6) and webhooks use HMAC, so the hub signs
  nothing. KMS also has no Ed25519 algorithm to offer §1.2 regardless. The line
  item was a plan to migrate an unused port to a service that cannot implement
  it. Withdrawn.
- **S3** — genuinely one file, and shipped.

The ports design is not wrong; the estimate attached to it was, twice, and both
corrections came from running something rather than reasoning about it.

### 2. Phase 1 runs single-writer, and `desiredCount: 1` is not enough

[ADR 0010](docs/adr/0010-single-writer-phase-1.md), the owner's decision in
response to ADR 0009: keep `Store` synchronous and defer horizontal scale. That
withdraws DynamoDB, SQS FIFO and KMS from Phase 1 scope and leaves §1.5's
ordering mechanism **unchanged** — the already-tested outbox and scheduler stay.

The substance is the deploy-time hazard. ECS's default rolling update is
`minimumHealthyPercent: 100, maximumPercent: 200`, which **deliberately runs the
new task alongside the old**. With SQLite on EFS that is two processes writing
one file over NFS, and the failure is not a slow request — it is corruption, and
§1.9's audit chain is what would surface it, by reporting tampering on a hub
that had done nothing wrong. So all four routes to a second task are closed
explicitly, and asserted:

1. `desiredCount: 1`
2. `minHealthyPercent: 0, maxHealthyPercent: 100` — stop the old task **before**
   starting the new one, costing a few seconds of deploy downtime
3. `circuitBreaker: { rollback: true }`
4. **No autoscaling**, asserted as the absence of any `ScalableTarget` or
   `ScalingPolicy` — because adding autoscaling is the obvious well-meant
   improvement that would silently corrupt the database, and a comment would not
   stop it

Cost was a design input rather than a measurement: the VPC has `natGateways: 0`,
because a NAT gateway (~$32/mo) plus the ALB (~$18) would cross §7's $50
threshold before serving a request. ~$29/month estimated, with a test asserting
no NAT gateway can reappear.

**Never deployed from here.** §7 requires a human for any real AWS account, so
there is deliberately no make target for `deploy`, `bootstrap` or `diff`.

### 3. The owner is a principal, not a borrowed agent

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

### 4. Clients recompute; they do not take the hub's word

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
| Messages are data, never authority | Bodies are wrapped `{untrusted, provenance, value}` on both push and pull. `Untrusted<T>` yields a placeholder from template literals, `String()`, `JSON.stringify` and `console.log` — a test per leak path, using an injection string as the payload. The A2A Agent Card states the same provenance, since it is the one document every A2A client reads. |
| Every message signed per agent | Ed25519 over JCS (RFC 8785). Key status is checked **inside** verification, so revocation applies on the next request. |
| Side effects stop at the approval gate | A `side_effect` task is created into `needs-approval` and gets **no outbox row** — the assignee never sees it. Approval checks owner signature → single-use → hash against the *current* payload. Owner routes are unreachable by any agent identity. Over A2A the gate surfaces as `auth-required`, which is the honest mapping: `working` would make a caller poll forever and `input-required` would invite input that cannot release it. |
| At-least-once delivery, exactly-once effect | The key is **reserved in the database before the body runs**, as one conditional write, so two processes cannot both execute it. A reservation whose holder died goes stale after 60s and is reclaimable; a body that throws releases it; release refuses to touch a *completed* record, since dropping one would turn a replay back into a second execution. Proven with two `Store` handles on one file. |
| Ordering per thread | Durable outbox; the claim rule is "oldest live row of a thread with nothing inflight, and only if due" — a later row cannot overtake one mid-backoff. **Unchanged in Phase 1** (ADR 0010). |
| The hub stores no secrets | No field for a model key anywhere. Outbound content is redacted (Luhn-checked cards, token shapes) before it leaves. The console stores none either: the owner key is loaded per session and held in memory only, enforced by tests that grep its sources for storage APIs. The CDK stack creates no Secrets Manager entry and no KMS key, asserted in the template — S3 and EFS access come from the task role. |
| No LLM calls in the hub | None. |
| Least privilege | New agents get `read` + `message`; `request_side_effect` is additionally required to create a gated task; the owner's signature over the enrolment binds the scopes, so an agent cannot widen its own. A2A push notifications may only target an origin the owner authorised at enrolment. |
| Audit append-only, hash-chained | SQLite `BEFORE UPDATE`/`DELETE` triggers that `RAISE(ABORT)` — they refuse an `UPDATE` even on a raw connection, since they live in the schema rather than the hub. The chain is the defence against the edit that goes around them, and the console checks it. |

## Conformance suites, and why they are written the way they are

Three suites exist to judge code the same author wrote, so each is deliberately
derived from something other than the implementation.

- **`hub/src/ports/store-conformance.ts`** — one behavioural spec run against
  both the in-memory fake and SQLite (ADR 0008). The whole test suite rests on
  those two being interchangeable, and nothing was checking it.
- **`hub/src/ports/blob-conformance.ts`** — the same, for `BlobStore`: 12 cases
  each against the filesystem adapter and S3-via-LocalStack. The S3 adapter
  keeps the filesystem adapter's rejected-key rules and its `no such blob`
  message precisely so the domain cannot tell which one it has.
- **`tests/conformance/a2a.test.ts`** — A2A v1.0, **written from the published
  specification** rather than from `adapters/a2a/`. That is the only reason it
  found anything: the same session wrote the implementation from its own reading
  of the spec, so a suite written from memory would have reproduced the same
  misreadings and passed. The error table, the AgentCard required-field list and
  the TaskState set were taken from the spec text, and each group cites its
  clause.

### What the A2A suite found

| Defect | Why it mattered |
|---|---|
| **The Agent Card advertised `http://localhost:8080`** | `publicUrl` defaulted to loopback and the composition root never set it, so a deployed hub published a card no remote agent could reach. Discovery is the first thing that must work and the last thing a local test exercises — every existing test passed while this was broken. Now read from `AGENTBRIDGE_PUBLIC_URL`, with the CDK stack passing the ALB address and a template assertion that it is set |
| **The card declared `protocolVersion: '1.0'` but served the v0.3 shape** | v1.0 replaced `url`/`preferredTransport` with an ordered `supportedInterfaces[]`; a v1.0 client reads `supportedInterfaces[0].url` and would have found no endpoint. Fixed additively — v0.3's fields stay for existing callers, with a case asserting the two cannot drift apart |
| **A malformed JSON body answered with AgentBridge's envelope** | Failures raised before the route ran (the content-type parser) escaped as `{error:{code:"schema_invalid"}}` — a *string* code where JSON-RPC requires a number, unparseable to an A2A client. Now `-32700` |
| **Push refusal used `-32004` where the spec has `-32003`** | `-32004` ("operation not supported by this agent") contradicts the card, which declares `pushNotifications: true`. The accurate statement is that push is unsupported for a caller with no owner-authorised origin |
| **The §1.1 untrusted-data notice was never emitted** | A source comment said the provenance was "stated on the card"; nothing put it there. Found while verifying that claim before repeating it in *this description* — the comment asserted a property the bytes did not have. Now in `description`, a REQUIRED field every client reads, with a case asserting it |

**And one case where the suite was wrong and the code was right.** An early
assertion demanded a numeric JSON-RPC code for an unsigned call. Spec §5.4 maps
authentication to HTTP **401** and authorization to **403**, so the pre-existing
401 was correct, and satisfying the new assertion would have buried the status
inside a 200 body where no standard HTTP auth client looks. The conversion was
already written when the pre-existing auth unit tests failed; the conformance
case was corrected instead, and the error handler now draws that line
explicitly and says why — because converting everything is the obvious
refactor. Worth a reviewer's attention as the counter-example to "a new test
failing means the code is broken".

## Deliberate deviations from the PRD

- **Auth is signature-only.** OAuth 2.1 and mTLS remain deferred. Adding a fifth
  auth path to a branch with no second reviewer is the opposite of what this
  branch needs.
- **`node:sqlite` instead of `better-sqlite3`.** Same synchronous semantics, no
  native dependency to build for two platforms. Verified triggers, WAL,
  transactions and `.changes` before switching.
- **DynamoDB, SQS FIFO and KMS are out of Phase 1 scope**, per ADR 0009 and the
  owner's decision in ADR 0010 — not pending.
- **A2A streaming is declared `false`** on the card rather than advertised and
  stubbed. A caller that sees `streaming: true` and gets a non-stream has no
  recourse; one that sees false polls `tasks/get`, which works. `message/stream`
  returns `-32004` with a reason.
- **The Python SDK omits async, the webhook receiver and `OwnerClient`.** No
  Python agent needs owner operations.
- **`exactOptionalPropertyTypes` is off for `infra/` only** — `strict` stays on.
  aws-cdk-lib declares `T | undefined` on classes where its own interfaces
  declare `?: T`, so passing a `Vpc` as an `IVpc` cannot compile; the
  alternative was casting at every construct boundary, which hides real errors.

## Review notes

Writing tests first caught **seventeen defects in the plan**, each fixed with a
failing-first test, plus the five A2A defects above. The full table is in
[`docs/TASKS.md`](docs/TASKS.md); the ones worth a reviewer's attention:

- Idempotency was not exactly-once — both concurrent callers ran the body and
  only the second *response* was discarded, after its rows were written. The fix
  landed late (see the invariant table) because the in-process `WeakMap` masked
  it in a single container and only fails in the Phase 1 topology.
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
pass vacuously, cross-checks `OWNER_ROUTES` against the handlers calling
`requireOwner`, and scans the A2A routes too.

### Verified by breaking it, not only by testing it

Any suite that passed on the first run was mutation-checked, because a
conformance suite that has never been seen to fail is decoration:

| Suite | Mutation | Result |
|---|---|---|
| `Store` conformance | reverse the fake's `listTasksByState` ordering; un-scope its nonce lookup | 1 failure each |
| Cross-process idempotency | force `reserveIdempotent` to always return `reserved` | 3 failures |
| Migration 004 upgrade path | delete the `INSERT … SELECT` that preserves rows | 2 failures |
| `BlobStore` conformance | disable the traversal guard; disable the not-found mapping | 2 and 1 failures |
| Single-writer stack | restore the ECS rolling-update defaults; add an autoscaling target | 1 failure each |
| A2A conformance | emit a non-A2A task state; renumber `methodNotFound`; blank the provenance notice | 1, 2 and 1 failures |

Beyond mutation:

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
- **Migration 004 rebuilds the `idempotency` table** (SQLite cannot drop a
  `NOT NULL`), which is the riskiest change here: a rebuild that dropped rows
  would turn every stored idempotency record back into a re-executable request
  *at the moment of deploy*. The upgrade path has its own tests built on a real
  schema-version-3 database.

`make test-container` builds the image, boots it with a generated owner key on a
fresh volume, and drives it over HTTP only — no `Store` handle exists on that
side of the boundary. It covers what the in-process suite structurally cannot:
the env contract, the entrypoint and workspace links inside the image, body
redaction in the real log stream read back via `docker logs`, that state
survives `docker restart`, and the kill switch end to end. Kept out of
`make check` and CI — a build-plus-boot is minutes, not seconds.

> ⚠️ **Nothing here has been reviewed by a second party.** Every task, every
> security fix and every verification was written by the same session. That
> includes four owner-auth migrations, the three audit/authorisation fixes
> above, two protocol surfaces, and three architectural ADRs.
>
> Two of this branch's own claims were corrected by later work on the same
> branch — ADR 0008's "genuinely small" adapters, and a conformance assertion
> that would have broken correct auth behaviour. Both corrections came from
> running something rather than reasoning about it. That rate of self-correction
> is the argument *for* review.
>
> A fresh pair of eyes on the **approval gate**, the **owner signing path**, the
> **delivery scheduler**, the **cross-process idempotency reservation** and the
> **console's key handling** is the one thing this branch has not had, and the
> review that found three of the four authorisation holes above is evidence that
> reviewing it pays.

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

**The Phase 1 work does not change the contract version.** The A2A Agent Card
gained `supportedInterfaces` additively, keeping v0.3's `url` and
`preferredTransport`, so no existing caller breaks. Two A2A JSON-RPC error codes
*did* change — a malformed body now returns `-32700` instead of an AgentBridge
envelope, and a push refusal returns `-32003` instead of `-32004` — but both are
corrections toward the spec version the card already declared, on an endpoint
with no known external consumer.

`agentbridge approve`, `revoke` and `audit verify` no longer take
`--agent`/`--agent-key`; they take `--owner-key`.

New runtime configuration: `AGENTBRIDGE_PUBLIC_URL` (the address published in
the A2A Agent Card — unset, it falls back to `http://localhost:8080`, which is
right for the local pilot and useless to a remote agent) and
`AGENTBRIDGE_ARTIFACT_BUCKET` (selects the S3 artifact store; unset, artifacts
stay on the filesystem).

## Known follow-ups

- The S3 adapter is verified only against **LocalStack**, which is not S3.
  Consistency, IAM and multipart behaviour are approximations — enough to judge
  the adapter's logic, not enough to call it production-proven.
- The CDK stack has **never been deployed**. A template that synthesises and
  asserts correctly is not a stack that runs; IAM, EFS mount behaviour under
  load and ALB health-check timing are unproven.
- **A few seconds of downtime on every deploy**, by construction (ADR 0010).
  There is no zero-downtime deploy for a single-writer database without a second
  writer or a draining proxy, and the first is the thing being prevented.
- `Signer` is dead port surface — no caller, and no service that could implement
  it for Ed25519. It should be deleted, but removing a port named in the design
  spec and §3 belongs in its own change.
- `wipeKey` zeroing the console's key buffer on lock is best-effort — the engine
  may have copied it, and GC timing is not ours.
- The console re-asks for the key file every session. Deliberate, and WebAuthn
  ([ADR 0004](docs/adr/0004-gate-agent-registration.md)) is the way out.
- The audit viewer renders `subject` verbatim. Subjects are hub-generated and a
  test asserts no payload reaches the response, but anything added to a subject
  becomes owner-visible by default.
- One **unreproduced e2e flake**: 1 of 24 failed once in a combined run, with 13
  consecutive clean runs since. Cause unknown, possibly ephemeral-port reuse.
  Recorded rather than closed.

## Phase 0 exit gate

Not yet met, and the remaining items are not code:

- [x] An agent registers, receives scopes, and signs every request (FR-1, FR-2)
- [x] A task flows Claude → hub → Muse → hub → Claude with no human relay
- [x] A `side_effect: true` task blocks until the owner approves, bound to the payload hash
- [x] Duplicate delivery produces exactly one effect
- [x] The audit chain verifies
- [x] `make check`, `make test-e2e` and `make conformance` all pass
- [ ] Claude connects over MCP with no code change on Anthropic's side — *built and conformance-tested; not yet exercised against a live Claude client*
- [ ] Muse connects by at least one of the three modes — *all three implemented and tested against a stub; the real Muse is not yet wired*
- [ ] **The link runs relay-free for seven consecutive days**

`examples/claude-muse/scripts/pilot.sh` runs the full exchange unattended and
exits non-zero on any failure, including a specific check that the approval gate
did not leak. Point cron at it to start the clock.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
