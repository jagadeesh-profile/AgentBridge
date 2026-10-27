# TASKS — Phase 0, and the start of Phase 1

The planning and completion record required by `CLAUDE.md` §5.2. One row per
task, with its owner, its acceptance criteria and what actually happened.

- **Plan:** [`docs/superpowers/plans/2026-10-20-agentbridge-phase0.md`](superpowers/plans/2026-10-20-agentbridge-phase0.md)
- **Spec:** [`docs/superpowers/specs/2026-10-20-agentbridge-phase0-typescript-design.md`](superpowers/specs/2026-10-20-agentbridge-phase0-typescript-design.md)
- **Branch:** `feat/phase0-typescript`
- **Status:** all 21 tasks complete. Phase 0 exit gate **not yet met** — it
  requires 7 consecutive relay-free days (see the bottom of this file).

Executed inline by the lead in a single session rather than fanned out to the
subagents in `CLAUDE.md` §5.1. That is a deviation from §5.2 step 3 and is
recorded as such: the ownership column below says who *owns* each path, not who
wrote it. The cost is that no task was reviewed by a second party as it landed —
see "Verification debt".

## Current gate status

| Command | Result |
|---|---|
| `pnpm --filter @agentbridge/console run build` | **compiles** |
| `make check` — lint, `tsc --strict`, unit, contract-drift | **666 tests** + 1 skip (the S3 half, when LocalStack is down — by design) |
| `make conformance` — MCP + A2A v1.0 | **48 tests** |
| `make test-otel` — OTLP export to an in-process receiver (in CI) | **9 tests** + 2 skips (the real-collector half) |
| `make test-otel-collector` — the real OpenTelemetry Collector | span accepted, and its random trace id found in the collector's own log |
| `make test-aws` — S3 adapter vs LocalStack | **24 tests**; fails rather than skips if LocalStack is absent |
| `make infra-synth` — `cdk synth` only, never deploy (§7) | **740-line template**, 23 assertions on it |
| `make test-python` — Python SDK | **20 tests** |
| `make test-e2e` — real hub, SQLite on disk, delivery worker | **24 tests** |
| `make test-container` — the real Docker image, HTTP only | **20 tests**, re-run against a freshly built image after the console work |

## Stage A — contracts and crypto

| # | Task | Owner | Acceptance | Status |
|---|---|---|---|---|
| 1 | pnpm workspace, Make targets, CI | `infra` | `make lint` passes on the skeleton | ✅ |
| 2 | Envelope, error catalog, transition table as data | `architect` | Terminal states have no outgoing transitions; `side_effect` cannot be defaulted | ✅ |
| 3 | JCS canonicalization, Ed25519 signing | `architect` | RFC 8785 vectors; emoji/CJK/combining marks round-trip (Review Focus 4) | ✅ |
| 4 | Generated JSON Schema + OpenAPI, drift guard | `architect` | `make contracts` fails on drift, proven FAIL→PASS | ✅ |

## Stage B — hub core

| # | Task | Owner | Acceptance | Status |
|---|---|---|---|---|
| 5 | Six ports + in-memory fakes | `hub-backend` | Fake rollback matches SQLite; nested transactions join the outer | ✅ |
| 6 | SQLite store, migrations, audit triggers | `hub-backend` | Raw SQL `UPDATE`/`DELETE` on `audit` raises; pull-only agents never claimed | ✅ |
| 7 | Registry, audit chaining, signature auth | `hub-backend` | Replay window asserted at 299 s / 301 s both directions (Review Focus 1) | ✅ |
| 8 | Threads, messages, turn cap, atomic outbox | `hub-backend` | Unknown recipient leaves **zero** partial state; pause survives the throw | ✅ |
| 9 | Task lifecycle, transition enforcement | `hub-backend` | Side-effect task enters `needs-approval` with no outbox row | ✅ |
| 10 | Versioned artifacts | `hub-backend` | Versions increment per (task, name); failed blob write leaves no row | ✅ |
| 11 | The side-effect approval gate | `hub-backend` | Wrong hash, wrong signer, replay and post-signing mutation all refused | ✅ |
| 12 | Fastify layer, idempotency, errors, redaction | `hub-backend` | Concurrent key → one effect (Review Focus 2); 413 and depth guard (Review Focus 5) | ✅ |

## Stage C — delivery

| # | Task | Owner | Acceptance | Status |
|---|---|---|---|---|
| 13 | Outbox scheduler, per-thread serialization | `hub-backend` | A later row cannot overtake one mid-backoff (Review Focus 3) | ✅ |
| 14 | Webhook push, HMAC, jittered backoff, DLQ | `hub-backend` | Retry schedule terminates inside 24 h; 410 dead, 404 retried | ✅ |
| 15 | Pull inbox with cursor and acks | `hub-backend` | A failed push stays readable (FR-7); dead rows excluded | ✅ |

## Stage D — surfaces

| # | Task | Owner | Acceptance | Status |
|---|---|---|---|---|
| 16 | TypeScript SDK, three connection modes | `sdk` | `Untrusted<T>` leaks through no stringification path | ✅ |
| 17 | MCP stdio server | `protocol-adapters` | Seven tools; untrusted notice in every description; no hub import | ✅ |
| 18 | `agentbridge` CLI | `hub-backend` | `approve` hashes the **current** payload; `revoke` is the kill switch | ✅ |

## Stage E — integration and verification

| # | Task | Owner | Acceptance | Status |
|---|---|---|---|---|
| 19 | Trace propagation, Dockerfile, compose | `infra` | `trace_id` adopted from caller, never the placeholder; image serves and persists | ✅ |
| 20 | Claude ↔ Muse pilot, three transports | lead | Muse's handler is never invoked for a gated task | ✅ |
| 21 | e2e + MCP conformance suites | `test-engineer` | All seven spec §7 scenarios | ✅ |

## Post-plan

| Item | Status |
|---|---|
| Container e2e suite against the real image | ✅ added (20 tests) |
| `hub/src/domain/inbox.ts` unit tests | ✅ added (22 tests) — found a cursor liveness bug |
| `already_exists` (409) for duplicate registration | ✅ contract bumped to 0.2.0 |
| ADRs 0001–0005 | ✅ written |
| `docs/TASKS.md` | ✅ this file |
| OpenTelemetry exporter | ✅ OTLP/HTTP; verified against a live collector receiving spans in the caller's trace |
| `withIdempotency` durable reservation | ✅ done in Phase 1 — see below |
| Owner-key-signed registration | ✅ ADR 0005; replaces the shared token, contract 0.3.0 (breaking) |
| `agent.register` audited against the owner, not the new agent | ✅ ADR 0005 follow-up |
| Clock drift named in the refusal instead of a bare `unauthenticated` | ✅ ADR 0005 follow-up; the only disclosed `unauthenticated` detail |
| Owner-authenticated routes (`authenticateOwner`, `ownerRequestDescriptor`) | ✅ ADR 0006; contract 0.4.0 (breaking) |
| `GET /v1/tasks?state=` — the approval queue | ✅ owner-only; migration 002 adds the index |
| `contracts` isomorphic (`@noble/hashes`, not `node:crypto`) | ✅ so the console can hash in the browser |
| `OwnerClient` + `agentbridge pending`; `approve` drops `--agent`/`--agent-key` | ✅ one key for the owner |
| **Console — approvals view** | ✅ Next.js; key in-browser only; driven in a real browser against a real hub |
| **Console — kill switch** | ✅ owner-signed revoke + roster; typed-name confirmation |
| `DELETE /v1/agents/{ref}/key` was callable by ANY agent | ✅ security fix; owner-only (ADR 0006), contract 0.5.0 |
| **Console — task board** | ✅ grouped by state, owner cancel, payloads not fetched |
| `DELETE /v1/tasks/{id}` was callable by ANY agent | ✅ security fix; it forged `actor: owner` in the audit chain |
| Route-classification guard | ✅ `route-guards.test.ts`; every route pinned to a bucket |
| `GET /v1/audit/verify`, `GET /v1/dlq` were on agent auth | ✅ owner-only; contract 0.7.0 (breaking) |
| **Console — audit viewer** | ✅ chain verified in-page, dead letters, break highlighted |
| Chain rule shared via `contracts/verifyAuditChain` | ✅ hub appends and console checks with one implementation |
| Chain detects deletion, not just edits | ✅ `seq`-gap check; hash-linking alone missed it |

## Phase 1

| Item | Status |
|---|---|
| **A2A v1.0 endpoint** | ✅ card, JSON-RPC, `message/send` / `tasks/get` / `tasks/cancel`; ADR 0007 |
| **A2A push notifications** | ✅ URL restricted to the agent's owner-authorised origin; reuses the retry/DLQ/redaction path |
| A2A streaming | ⬜ declared `false` on the card; `message/stream` returns a reason |
| **A2A conformance suite** | ✅ `tests/conformance/a2a.test.ts` — 47 cases incl. MCP, written from the published spec and driven over signed HTTP against a real hub. **Found four real defects** (below); mutation-checked twice |
| **`infra/` AWS CDK** | ✅ single-writer Fargate + EFS + S3 + ALB, no NAT gateway (ADR 0010). 22 template assertions; `cdk synth` produces a 740-line template. **Not deployed** — §7. The four single-writer settings are each asserted, and two were mutation-checked |
| **Store conformance suite** | ✅ one spec, both implementations, 48 assertions; mutation-checked |
| **Phase 1 port adapter — S3 `BlobStore`** | ✅ one file; passes `blob-conformance.ts` against LocalStack, 12 cases each side; `pnpm run test-aws` refuses to pass vacuously |
| Phase 1 port adapter — SQS FIFO `Queue` | 🚧 **blocked, not small.** `claimNext`/`recoverInflight` are sync; and §1.5's "hold the thread until backoff expires" is not what a FIFO visibility timeout does (ADR 0009) |
| Phase 1 port adapter — KMS `Signer` | ❌ **withdrawn.** `Signer` has no caller in the hub; KMS has no Ed25519 to offer §1.2 (ADR 0009) |
| Phase 1 port adapter — DynamoDB `Store` | 🚧 **blocked on an owner decision.** Needs optimistic concurrency (ADR 0008) *and* an async `Store`, since all 45 methods are sync and no networked database can implement that in Node (ADR 0009) |
| **Python SDK (FR-18)** | ✅ canonicalization, signing, client, pull-inbox handler; byte-identical to TS by generated vectors |
| Python SDK — async, webhook receiver, OwnerClient | ⬜ not ported; no Python agent needs owner operations |
| OAuth 2.1 / mTLS | ⬜ ADR 0002 defers these here |
| **`withIdempotency` durable reservation** | ✅ reserves before the body runs; proven across two processes on one database; migration 004 |
| **`BlobStore` conformance suite** | ✅ one spec, both implementations, 24 assertions; mutation-checked twice |
| **S3 wired into the composition root** | ✅ `AGENTBRIDGE_ARTIFACT_BUCKET` selects S3, else the filesystem. Credentials come from the task role, so §1.6 still holds |
| **ADR 0010 — single-writer Phase 1** | ✅ the owner's decision, the deploy-time two-writer hazard, and the ~$29/month cost shape against §7's $50 threshold |
| **Console component tests** | ✅ 26 cases under jsdom over board, audit and agents — the surfaces previously verified only by clicking. Mutation-checked: rendering a payload, flagging one audit row instead of all after the break, and dropping the typed-name guard each fail. No new dependency for JSX (the bundler's own transform, not `@vitejs/plugin-react`, whose esbuild install script the supply-chain policy blocks) |
| **Local deploy, run for real** | ✅ `docker compose` hub + CLI enrolment + the full Claude ↔ Muse pilot (5 steps, gate held, 13 audit rows verified) + the console in a browser with its `/v1/*` proxy confirmed against the container. Found two quickstart-blocking bugs, both fixed with a regression test that runs the real bin rather than importing its functions |
| **OTLP export tested, at two levels** | ✅ `make test-otel` (9 cases, in-process receiver, in CI's main job) exercises the real OTLP exporter **and** `BatchSpanProcessor` — neither of which the 22 existing telemetry tests touch, since injecting an exporter takes the `SimpleSpanProcessor` branch. `make test-otel-collector` sends to the real collector image and greps its log for the random trace id. Mutation-checked |
| **Fixed: a down collector left SQLite unclosed on every deploy** | ✅ `shutdownTelemetry` rejected after ~8s of retries; the composition root awaited it before `store.close()` under a signal handler that discards the promise, so the unhandled rejection killed the process with the database open. Now bounded at 2s, never rejects, returns `{ flushed, reason }`; the root uses `try/finally` |
| **Fixed: `pnpm install` failed outright** | ✅ pnpm 12 wrote an `allowBuilds: { esbuild: "set this to true or false" }` placeholder into `pnpm-workspace.yaml` and then failed every install until it was decided — breaking `make setup`, the container image build and all of CI. Set to `false`: nothing here executes esbuild. **`make check` did not catch this; the container suite did** |
| **`console/` now type-checked by the gate** | ✅ it cannot be a root `tsc -b` reference — TS forbids `composite` + `noEmit`, and Next needs both — so root `lint` runs the console's own `tsc --noEmit` as its last step. Verified by reintroducing the type error that previously survived a green `check`. Also closed the hole that let it through: the test stubs' `as unknown as OwnerClient` erased errors inside the literal, so the literal is now checked against `Partial<OwnerClient>` first |

### What the A2A conformance suite found

Written from the spec rather than from `adapters/a2a/`, which is the only
reason it found anything: the same session wrote the implementation from its
own reading, so a suite written from memory would have reproduced the same
misreadings. Four real defects, each fixed with the failing case kept:

| Defect | Why it mattered |
|---|---|
| **The Agent Card advertised `http://localhost:8080`** | `publicUrl` defaulted to loopback and the composition root never set it, so a deployed hub published a card no remote agent could reach. Discovery is the first thing that must work and the last thing a local test exercises. The CDK stack now passes the ALB address, asserted in the template |
| **The card declared `protocolVersion: '1.0'` but served the v0.3 shape** | v1.0 requires `supportedInterfaces[]`; the card had v0.3's `url` + `preferredTransport`. A v1.0 client reads `supportedInterfaces[0].url` and would have found nothing. Fixed additively — both are present and a case asserts they agree |
| **A malformed JSON body answered with AgentBridge's envelope, not JSON-RPC** | Errors raised before the route ran (content-type parser) escaped as `{error:{code:"schema_invalid"}}` — a *string* code where JSON-RPC requires a number. An A2A client cannot parse it. Now `-32700` |
| **Push refusal used `-32004` instead of `-32003`** | `-32004` ("operation not supported by this agent") contradicts the card, which declares `pushNotifications: true`. The spec has a dedicated `PushNotificationNotSupportedError` for exactly this |

And one case where **the suite was wrong and the code was right**: an early
assertion demanded a numeric JSON-RPC code for an unsigned call. Spec §5.4
maps authentication to HTTP **401** and authorization to **403**, so the
pre-existing 401 was correct, and satisfying the new assertion would have
buried the status inside a 200 body where no standard HTTP auth client would
look. The pre-existing unit tests caught the regression; the conformance case
was corrected instead. Recorded because it is the counter-example to "a new
test failing means the code is broken".
| `make test-python` / `test-aws` targets missing from the Makefile | ✅ `test-python` was a pnpm script with no `make` target despite §3 documenting one |

### The Phase 1 storage decision — resolved

ADR 0009 put two options to the owner, because the synchronous `Store` is a
commitment to **embedded** storage: Node cannot serve a synchronous method from
network I/O, which rules out DynamoDB *and* Aurora and RDS equally.

**The owner chose B on 2026-10-27: keep `Store` synchronous and run Phase 1
single-writer.** Recorded as ADR 0010. Consequences:

- DynamoDB, SQS FIFO and KMS are **out of Phase 1 scope**, not pending.
- §1.5's ordering mechanism is **unchanged** from Phase 0 — the durable outbox
  and per-thread scheduler stay, already tested.
- The async-`Store` refactor remains available whenever a second hub instance is
  genuinely needed, with `store-conformance.ts` as its acceptance test.
- One task, and `minHealthyPercent: 0` so a deploy stops the old task before
  starting the new one. The ECS default would run two writers on one SQLite
  file; a few seconds of deploy downtime is the deliberate price.

## What TDD caught that the plan got wrong

Seventeen defects, each fixed with a test that failed first. Recorded because the
plan was written by the same party that executed it, and this is the evidence
that writing tests first did independent work:

| Defect | Why it mattered |
|---|---|
| Idempotency was not exactly-once | Both concurrent callers ran the body; only the second *response* was discarded, after its rows were written |
| Replay nonce keyed on timestamp | Two different requests in one millisecond collided; a create-then-read pair hit it immediately |
| Replay rejection too broad | Would have rejected the safe retry `CLAUDE.md` §1.4 promises; now scoped to unsafe unkeyed writes |
| Turn-cap pause rolled back by its own throw | Thread stayed open at the cap and accepted the next message |
| `actorFor` trusted a synthetic owner ref | `agent:<ws>-owner` was registrable, therefore impersonatable |
| Contract drift guard blind to untracked files | A brand-new generated schema passed the guard uncommitted |
| OpenAPI generator ignored its success-schema argument | Published `InboxResponse` as the success body of every operation |
| Approval replay returned the wrong code | Single-use now matches on the signature, distinguishing replay from a later decision |
| `.dockerignore` excluded `dist` but not `*.tsbuildinfo` | `tsc -b` believed everything was built; the image shipped empty and the build reported success |
| `pnpm prune --prod` stripped workspace links | Image built, then died with `MODULE_NOT_FOUND` |
| PEM redaction pattern had an unmatchable `\b` | Private-key headers were not redacted |
| Container log level set to `warn` | Made the body-redaction test pass **vacuously** against an empty log |
| `listInbox` cursor from last item, not last row | One orphaned row would have wedged an agent's inbox permanently |
| Unauthenticated `POST /v1/agents` | Anyone reachable could enrol an agent into the owner's workspace (ADR 0004) |
| OTel processors took a bare exporter | sdk-trace 3.0 wants `{ exporter }`; a positional exporter is accepted, never stored, and dies later on `undefined.forceFlush` |
| Request span tied to a socket `close` event | Never fired under `inject`, so no span was ever emitted; `onResponse` is the correct hook |
| `fetch` stored unbound on the SDK clients | `this.fetchImpl(...)` passes the client as `this`, which Node tolerates and a browser rejects with "Illegal invocation". Only running the console in a real browser surfaced it |

## Verification debt

Carried deliberately, and the thing to resolve before merge:

- **No task was reviewed by a second party as it landed.** The plan called for
  `test-engineer` to write the e2e suite independently and
  `security-reviewer` to review every change touching auth, signing, approvals
  or delivery (`CLAUDE.md` §5.6). Both roles were filled by the same session
  that wrote the code.
- The final whole-branch review was a **self-review**. It found and fixed one
  Important issue (ADR 0004), which is some evidence it was worth doing and no
  evidence that it was sufficient.
- A fresh reviewer on the **approval gate**, the **signing path** and the
  **delivery scheduler** is the highest-value remaining check.

## Phase 0 exit gate

From the spec's §11 and `CLAUDE.md`:

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
