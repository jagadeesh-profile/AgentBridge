# AgentBridge Phase 0 — TypeScript Design

**Date:** 2026-10-20
**Status:** Approved
**Scope:** FR-1 … FR-8, the MCP server, the TypeScript SDK, and the Claude ↔ Muse pilot example
**Supersedes:** the Python 3.12 / FastAPI stack in `CLAUDE.md` §3 and the "Suggested stack" paragraph of the PRD

---

## 1. Intent

AgentBridge Phase 0 is a prototype. Its exit gate is one thing: the Claude ↔ Muse
link runs relay-free for seven straight days. Every decision below is chosen to
reach a running, trustworthy message path quickly, without foreclosing the AWS
topology the PRD targets for Phase 1.

**Decided by the owner during design:**

| Question | Decision |
|---|---|
| Implementation language | TypeScript everywhere. Replaces Python 3.12 / FastAPI / Pydantic. |
| Runtime and storage | Local-first: Node 22, SQLite, in-process per-thread FIFO, filesystem artifacts — all behind swappable interfaces. |
| Deployment | Docker Desktop. `Dockerfile` + `docker-compose.yml`; the pilot runs as a container. |
| Build scope this pass | FR-1 … FR-8 + MCP server + TypeScript SDK + pilot example. The owner console (FR-9) is the next pass. |
| How Muse connects | All three modes supported — SDK handler, raw webhook, pull inbox — plus a local stub Muse for tests. The real Muse's mode is chosen later with no hub change. |
| Internal architecture | Ports-and-adapters monorepo, one container, delivery as an in-process worker splittable by env flag. |
| Phase 0 auth | Signature-only. OAuth 2.1 deferred to Phase 1. |
| Side-effect tasks | Created directly into `needs-approval`; never reach `submitted`. |

**Assumptions**, to correct if wrong:

- A single owner and a handful of agents in Phase 0. The non-functional scale
  targets in the PRD (10k workspaces, 5M messages/day) are Phase 2 concerns and
  are explicitly not designed for here.
- Muse's eventual connection mode is unknown, so no mode may be privileged in
  the hub's design.

**Out of scope for Phase 0**, each with its reason:

| Deferred | Why |
|---|---|
| `adapters/a2a/` (A2A v1.0 endpoint, Agent Card) | Not in `CLAUDE.md`'s Phase 0 line. Phase 1. |
| `sdk/python/` | TypeScript chosen. Python SDK moves to P1 in the PRD. |
| `console/` (FR-9) | Next pass, once the message path is proven against a real agent. |
| `infra/` CDK stacks, any real AWS | Phase 0 is local + Docker only. No `cdk deploy`. |
| OAuth 2.1, mTLS | Phase 1. See §5.2. |
| FR-10 … FR-17 | P1/P2 per the PRD. |

---

## 2. Architecture

### 2.1 Two runnable entry points, one container

| Entry point | What it is | How it runs |
|---|---|---|
| `hub` | Fastify server: REST API, inbound webhook receiver, outbound push + retry worker, pull inbox | the Docker container (`docker compose up`) |
| `agentbridge-mcp` | stdio MCP server — a thin REST client of the hub | an npm bin, spawned locally by Claude Desktop / Claude Code |

The MCP server is a REST client, not an in-process module. This is deliberate:
it physically cannot reach into hub internals, which keeps `adapters/` honest
about "map, validate, forward" (`agents/protocol-adapters.md`), and it matches
how Claude actually connects — over stdio, spawned by the client.

### 2.2 Repository layout

Ownership is unchanged from `CLAUDE.md` §2.

```
contracts/                  @agentbridge/contracts          owner: architect
  src/envelope.ts           Zod schemas — single source of truth
  src/task-states.ts        transition table as data
  src/events.ts
  src/errors.ts             error codes + HTTP status mapping
  src/api.ts                request/response schema per endpoint
  src/version.ts            semver of the contract
  generated/                JSON Schema + openapi.yaml — emitted, drift-checked

hub/                                                        owner: hub-backend
  src/ports/                Store · Queue · BlobStore · Clock · IdGen · Signer
  src/domain/               registry · workspaces · threads · tasks ·
                            artifacts · approvals · audit
  src/http/                 Fastify routes: validate → domain → map error codes
  src/adapters/sqlite/      Store implementation + migrations
  src/adapters/fs/          BlobStore implementation

delivery/                                                   owner: hub-backend
  src/queue/memory.ts       per-thread FIFO scheduler, Queue implementation
  src/push.ts               webhook POST, HMAC, ack handling
  src/retry.ts              exponential backoff + jitter, 24 h, then DLQ
  src/inbox.ts              cursor-based pull inbox

adapters/mcp/               stdio MCP server          owner: protocol-adapters
adapters/webhook/           inbound REST + outbound HMAC

sdk/typescript/             @agentbridge/sdk                owner: sdk

examples/claude-muse/       stub Muse, three connection modes    owner: lead

tests/e2e/ tests/conformance/ tests/load/              owner: test-engineer

docs/adr/  docs/TASKS.md  docs/superpowers/specs/
Makefile  Dockerfile  docker-compose.yml  .github/workflows/ci.yml
pnpm-workspace.yaml  tsconfig.base.json
```

Unit tests live next to the code they test and belong to that code's owner.

### 2.3 Contracts as Zod, generating everything else

`CLAUDE.md` §3 requires `make contracts` to fail when generated code drifts.
Zod schemas in `contracts/src/` are the source of truth; `contracts/generated/`
holds emitted JSON Schema and `openapi.yaml`, regenerated and diffed in CI.

The hub, the SDK and the MCP adapter all import the same TypeScript types
inferred from those schemas. There is no second type system to keep in sync,
which is the usual failure mode of OpenAPI-first in TypeScript.

Contracts are versioned with semver. Additive changes are minor; anything that
breaks a consumer is major and needs human approval (`CLAUDE.md` §7).

### 2.4 Why ports-and-adapters

Two approaches were rejected:

- **Two services from the start** (separate `hub` and `delivery` containers
  sharing SQLite in WAL mode). Matches the Phase 1 ECS topology, but buys
  production fidelity that cannot be used until Phase 1, at the cost of
  cross-process SQLite writer contention and a slower test loop.
- **Single flat service, no seams.** Fastest to a running message, but violates
  the `CLAUDE.md` §2 ownership table — every subagent would edit the same files
  — and turns the Phase 1 AWS move into a rewrite rather than three new adapter
  files.

Ports-and-adapters keeps the `hub/` vs `delivery/` ownership split intact, is a
single `docker compose up` for the pilot, and makes the Phase 1 migration
additive: DynamoDB, SQS FIFO and S3 each become one new file implementing an
existing interface. `DELIVERY_MODE=worker` splits delivery into its own process
without a code change when that becomes useful.

---

## 3. Data flow

The happy path, Claude creating a task for Muse:

1. Claude's MCP client calls `task.create`. `adapters/mcp` builds an Envelope,
   signs it with Claude's agent key, POSTs `/v1/tasks`.
2. `hub/http` validates the request against the Zod schema at the edge, then
   hands a typed model to the domain. Nothing untyped crosses that boundary.
3. The domain verifies the Ed25519 signature, checks the key is not revoked,
   checks the `create_task` scope, then checks the idempotency key.
4. Task row, audit row and **outbox row** are written in one SQLite transaction.
5. `delivery` picks up the outbox row — serialized per `thread_id` — and POSTs
   to Muse's webhook with an HMAC header. A 2xx response is the ack.
6. Muse completes the task, attaches an artifact, transitions to `completed`.
   The hub writes an outbox row addressed to Claude. Claude has no inbound
   endpoint, so it reads that row via `inbox.list` on its next MCP call.

### 3.1 The three Muse connection modes

All three run against the same hub and the same envelope:

| Mode | Mechanism | For |
|---|---|---|
| SDK | `agent.onTask(handler)`; long-poll with reconnect and cursor resume | a Muse that can run a process |
| Raw webhook | hub HMAC-signs POSTs to a registered HTTPS URL | a Muse behind any HTTP server |
| Pull inbox | `GET /v1/inbox?since=<cursor>` | a hosted Muse with no inbound endpoint |

`examples/claude-muse/` ships a stub Muse that exercises all three plus the
approval gate, so the e2e suite is green before the real Muse exists.

---

## 4. Components

### 4.1 Ports

Six interfaces in `hub/src/ports/`. Every one has an in-memory fake used by unit
tests and a real adapter used in production.

| Port | Phase 0 adapter | Phase 1 adapter |
|---|---|---|
| `Store` | SQLite (`better-sqlite3`) | DynamoDB single-table |
| `Queue` | in-process FIFO scheduler over the SQLite outbox | SQS FIFO |
| `BlobStore` | local filesystem | S3 |
| `Clock` | system clock | system clock |
| `IdGen` | ULID | ULID |
| `Signer` | local Ed25519 key file | KMS signer |

`Clock` and `IdGen` are injected so no test reads the wall clock or generates a
real ULID. Retry/backoff timing and per-thread ordering are therefore testable
without sleeping.

### 4.2 Domain modules

Each owns one concern and is tested against port fakes with no I/O:

- **registry** — agent registration (FR-1): name, owner, capabilities card,
  public key, scopes, key status.
- **workspaces** — grouping and membership (FR-2). An agent sees only
  workspaces it is invited to.
- **threads** — ordered signed messages (FR-3).
- **tasks** — the state machine (FR-4).
- **artifacts** — versioned outputs attached to tasks (FR-5).
- **approvals** — the side-effect gate (FR-8).
- **audit** — append-only hash-chained log.

### 4.3 Delivery

- **push** (FR-6): POST to the agent's webhook URL. `X-AgentBridge-Signature`
  carries HMAC-SHA256 over `timestamp + "." + rawBody`; the Ed25519 envelope
  signature travels inside the body. 2xx is the ack.
- **retry**: exponential backoff with jitter, capped at 24 h, then the message
  moves to a dead-letter row readable through the API.
- **inbox** (FR-7): `GET /v1/inbox?since=<cursor>`, where the cursor is the ULID
  of the last acknowledged item. Unacknowledged pushes stay readable here, so a
  failed push never loses a message. `POST /v1/inbox/ack` advances the cursor.

---

## 5. Security

Each row below implements an invariant from `CLAUDE.md` §1 or a control from the
PRD's security table.

### 5.1 Identity and signing

| Concern | Decision |
|---|---|
| Canonicalization | **JCS (RFC 8785)** over the envelope minus `sig`. Hand-rolled key ordering is the classic source of "verifies on my machine only" bugs; JCS is a spec with published test vectors. |
| Signature format | `sig: "ed25519:<base64>"` |
| Key custody | The SDK generates the key pair locally and writes the private key to a file the agent owns. The hub stores only public keys. Private keys are never logged or transmitted. |
| Signing non-envelope requests | For requests without an envelope (e.g. `GET /inbox`), sign a request descriptor: method + path + sorted query + `sha256(body)` + timestamp, in `X-AgentBridge-Signature`. |
| Replay | ±300 s timestamp window; seen timestamps retained for the window. Idempotency keys enforced independently. |
| Kill switch | Key status `active \| revoked` is checked **inside** signature verification, so revocation takes effect on the very next request. Revoking also drops that agent's pending outbox rows. |

### 5.2 Phase 0 deviation: signature-only auth

The PRD requires OAuth 2.1 for MCP and REST clients with 15-minute tokens.
Phase 0 ships **signature-only auth** instead: possession of the agent's
Ed25519 private key authenticates the request, and scopes authorize it. OAuth
2.1 and optional mTLS move to Phase 1.

This is recorded as an explicit deviation, not an omission, and is written into
the PRD so it cannot drift silently. It does not weaken a `CLAUDE.md` §1
invariant: every message is still signed per agent, and no agent posts as a
human account.

### 5.3 Scopes

Per agent, per workspace: `read`, `message`, `create_task`, `write_artifact`,
`request_side_effect`. A newly registered agent receives `read` + `message`
only; anything more is granted explicitly (`CLAUDE.md` §8). Scopes are checked
server-side on every endpoint and every MCP tool. No path trusts the client.

### 5.4 The approval gate

A task with `side_effect: true` is created **directly into `needs-approval`** and
is never delivered to its assignee for execution until released.

- `payload_hash = sha256(JCS(payload))`.
- The owner signs `{task_id, payload_hash, decision, issued_at}`.
- The hub re-hashes the *current* payload and rejects on mismatch
  (`approval_hash_mismatch`), and marks the approval consumed so it cannot be
  replayed (`approval_consumed`).
- Mutating the payload invalidates the approval by construction.

**Owner key custody in Phase 0.** The console with WebAuthn is the next pass, so
Phase 0 ships an `agentbridge` CLI holding an owner Ed25519 key:
`agentbridge approve <task-id>`. The signed payload format is identical, so the
console swaps WebAuthn in later with no API change.

### 5.5 Untrusted content

Message bodies are stored and returned wrapped:

```json
{
  "untrusted": true,
  "provenance": { "from": "agent:muse", "sigVerified": true, "receivedAt": "..." },
  "value": { "...": "..." }
}
```

The SDK types this as `Untrusted<T>` with an explicit `.unwrap()`, so a caller
cannot accidentally interpolate agent content into a prompt or a template. The
hub never fetches a URL found in a body, and never places body content in a
template, a shell command or an instruction position. MCP tool descriptions
state that returned content is untrusted data from another agent.

### 5.6 Audit, secrets, abuse

| Control | Decision |
|---|---|
| Audit | Append-only table, `prev_hash = sha256(JCS(prev_row))`. UPDATE and DELETE are blocked by a **SQLite trigger that raises**, not merely by convention. `GET /v1/audit/verify` walks the chain. |
| Secrets | The hub has no field anywhere for a model API key or tool credential. Outbound bodies are scanned for token-shaped strings and Luhn-valid card numbers and redacted before push. |
| Abuse guards | Max turns per thread (default 6, `turn_cap_exceeded`) and a per-agent rate limit (`rate_limited`). Cost caps are P1 (FR-14). |
| No LLM in the hub | Phase 0 has no model call anywhere in `hub/` or `delivery/` (`CLAUDE.md` §1.7). |

---

## 6. Error handling

`contracts/src/errors.ts` is the sole source: a Zod enum of codes, each with an
HTTP status and a stable message template. Every error response is
`{ error: { code, message, trace_id } }`. Stack traces are never returned
(`CLAUDE.md` §4).

Phase 0 codes:

`unauthenticated` · `signature_invalid` · `key_revoked` · `scope_denied` ·
`schema_invalid` · `illegal_transition` · `approval_required` ·
`approval_hash_mismatch` · `approval_consumed` · `idempotency_conflict` ·
`not_found` · `rate_limited` · `turn_cap_exceeded`

A thrown domain error carries a code; a single Fastify error hook maps code to
status and shape. Routes never build error bodies themselves, so a newly added
code cannot ship with an inconsistent response shape.

### 6.1 Correctness rules

| Rule | Mechanism |
|---|---|
| Exactly-once effect (`CLAUDE.md` §1.4) | `idempotency(workspace, agent, key)` unique index stores the original response body. A replay returns that stored response; it does not re-execute. |
| Ordering per thread (§1.5) | Outbox rows are durable in SQLite; the in-memory queue is only a *scheduler* over them, keyed by `thread_id`, one active consumer per thread. Serialized per thread, concurrent across threads — the same semantics `MessageGroupId` provides, so Phase 1 is a swap. A container restart loses nothing. |
| Legal transitions only | `contracts/src/task-states.ts` declares transitions as data: `{from, to, who: 'creator' \| 'assignee' \| 'owner'}`. The domain is a table lookup. An illegal transition returns `illegal_transition` and is never coerced. |
| Timeouts and retries | Every outbound network call has a timeout. Retries use backoff + jitter and apply only to idempotent operations. |

---

## 7. Testing

| Layer | Location | Owner | Against |
|---|---|---|---|
| Unit | next to the code | that code's owner | in-memory port fakes, no I/O |
| e2e | `tests/e2e/` | `test-engineer` | a real running hub |
| Conformance | `tests/conformance/` | `test-engineer` | the MCP server's tool list, schemas and descriptions |

Runner: `vitest`.

Per `agents/test-engineer.md`, e2e tests are written from the acceptance criteria
and `contracts/` **before** reading the implementation, so they check the spec
rather than the code.

**e2e must cover:**

1. Happy path: agent A creates a task, the hub pushes to B, B completes with an
   artifact, A is notified.
2. The Claude ↔ Muse pilot scenario in `examples/claude-muse/`.
3. Duplicate delivery — the same idempotency key produces one effect.
4. Out-of-order arrival within a thread.
5. Delivery to an offline agent, then pull-inbox recovery.
6. Approval gate: the task blocks in `needs-approval`; a wrong payload hash is
   rejected; a correct approval releases it; a replayed approval is rejected.
7. Security negatives: unsigned message, wrong signature, missing scope, revoked
   key, replayed webhook.

**Conformance (MCP only** — A2A is deferred): tool list, tool input/output
schemas, and the presence of untrusted-data language in every tool description.

Coverage gate: at least 85% on changed lines (`CLAUDE.md` §4). Every bug fix
ships with a failing-first regression test.

---

## 8. Observability

- **Traces:** OpenTelemetry, with `trace_id` carried **in the envelope** so one
  trace spans both agents.
- **Logs:** `pino`, structured, fields `trace_id · workspace · agent · msg_id ·
  task_id`. A pino redaction serializer drops `body` and `value` outright, so
  "never log message bodies" (`CLAUDE.md` §4) is enforced by configuration
  rather than by remembering.
- Every handler emits a span and one structured log line.

---

## 9. Stack and dev loop

**Stack:** Node 22, TypeScript 5 (`strict`), pnpm workspaces, Fastify, Zod,
`better-sqlite3`, `@modelcontextprotocol/sdk`, `@noble/ed25519`, `ulid`, `pino`,
OpenTelemetry, `vitest`, `tsup` (SDK build), `eslint` + `prettier`.

Every new third-party dependency needs a one-line justification in the PR and
must be pinned (`CLAUDE.md` §4).

**Make targets**, unchanged in name from `CLAUDE.md` §3, re-mapped to pnpm:

| Target | Does |
|---|---|
| `make setup` | `pnpm install` + pre-commit install |
| `make dev` | `docker compose up` — hub container, volume for the SQLite file and artifacts |
| `make contracts` | regenerate `contracts/generated/`; fail on drift |
| `make lint` | `eslint`, `prettier --check`, `tsc --noEmit` |
| `make test` | unit tests, all packages |
| `make test-e2e` | e2e against the running stack |
| `make conformance` | MCP conformance suite |
| `make check` | lint + test + contracts — must pass before any handoff |

CI runs the same targets on PRs, with actions pinned by SHA.

**Not run in Phase 0:** `cdk deploy`, anything against a real AWS account, DNS,
secrets or billing (`CLAUDE.md` §7).

---

## 10. Documentation changes this design requires

| File | Change |
|---|---|
| PRD, "Suggested stack" | Replace the AWS-first paragraph with the Phase 0 TypeScript local stack, keeping AWS as the Phase 1 target. |
| PRD, protocol surface table | SDK row becomes TypeScript; `@on_task` becomes `onTask`. |
| PRD, FR table | Note the Python SDK as P1. |
| PRD, security table | Record the Phase 0 signature-only auth deviation (§5.2). |
| `CLAUDE.md` §3 | Python/uv/FastAPI/Pydantic/boto3 → Node 22 / pnpm / Fastify / Zod / better-sqlite3. |
| `CLAUDE.md` §2 | `hub/` described as a TypeScript service; `sdk/python/` marked P1. |
| `agents/hub-backend.md` | FastAPI/DynamoDB/SQS → Fastify/SQLite/outbox; the SQS FIFO rule becomes the per-thread outbox rule. |
| `agents/infra.md` | Phase 0 scope is Docker + CI; CDK stays Phase 1 and still may never deploy. |
| `agents/sdk.md` | TypeScript only for Phase 0. |
| `agents/protocol-adapters.md` | A2A marked Phase 1. |
| `agents/architect.md` | Contracts are Zod-first with generated JSON Schema and OpenAPI. |

---

## 11. Phase 0 exit criteria

- [ ] An agent registers, receives scopes, and signs every request (FR-1, FR-2).
- [ ] Claude connects over MCP with no code change on Anthropic's side.
- [ ] Muse connects by at least one of the three modes.
- [ ] A task flows Claude → hub → Muse → hub → Claude with no human relay.
- [ ] A `side_effect: true` task blocks until the owner approves it, and the
      approval is bound to the payload hash.
- [ ] Duplicate delivery produces exactly one effect.
- [ ] The audit chain verifies.
- [ ] `make check`, `make test-e2e` and `make conformance` all pass.
- [ ] The link runs relay-free for seven consecutive days.
