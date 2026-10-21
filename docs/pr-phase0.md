# Phase 0: the AgentBridge hub in TypeScript

Implements FR-1 … FR-8 plus the MCP server, the TypeScript SDK, the
`agentbridge` CLI and the Claude ↔ Muse pilot. 21 planned tasks, 19 commits,
each one TDD'd with its own green gate.

**Adopts TypeScript**, replacing the Python 3.12 / FastAPI stack the repo
previously specified. The rationale and full design are in
[`docs/superpowers/specs/2026-10-20-agentbridge-phase0-typescript-design.md`](docs/superpowers/specs/2026-10-20-agentbridge-phase0-typescript-design.md);
the task-by-task plan is in
[`docs/superpowers/plans/2026-10-20-agentbridge-phase0.md`](docs/superpowers/plans/2026-10-20-agentbridge-phase0.md).

## What works

```bash
make setup
export AGENTBRIDGE_OWNER_PUBLIC_KEY=$(... agentbridge keygen --out owner.key)
export AGENTBRIDGE_REGISTRATION_TOKEN=$(openssl rand -hex 32)
make dev            # hub in Docker on :8080
make check && make test-e2e && make conformance
make test-container   # builds and drives the real image
```

| Gate | Result |
|---|---|
| `make check` — lint, `tsc --strict`, unit tests, contract-drift | **359 tests** |
| `make test-e2e` — real hub: SQLite on disk, delivery worker, real ports | **24 tests** |
| `make conformance` — MCP tool surface | **8 tests** |
| `make test-container` — the real Docker image, HTTP only | **20 tests** |

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
`contracts/generated/` and drift-checked in CI, so the hub, SDK and MCP adapter
cannot diverge.

| Package | Contents |
|---|---|
| `contracts/` | Envelope, transition table as data, error catalog, JCS canonicalization, Ed25519 signing |
| `hub/` | Ports, SQLite + filesystem adapters, domain (registry, threads, tasks, artifacts, approvals, audit, inbox), Fastify API |
| `delivery/` | Per-thread outbox scheduler, HMAC webhook push, jittered backoff, DLQ, composition root |
| `sdk/typescript/` | `Client`, `Agent.onTask`, `Untrusted<T>`, `verifyWebhook`, local key management |
| `adapters/mcp/` | stdio MCP server — seven tools, a thin REST client of the hub |
| `cli/` | `keygen`, `register`, `approve`, `revoke`, `inbox`, `audit verify` |
| `examples/claude-muse/` | The pilot: one handler, three transports |

## Invariants, and how each is held

| `CLAUDE.md` §1 | Mechanism |
|---|---|
| Messages are data, never authority | Bodies are wrapped `{untrusted, provenance, value}` on both push and pull. `Untrusted<T>` in the SDK yields a placeholder from template literals, `String()`, `JSON.stringify` and `console.log` — a test per leak path, using an injection string as the payload. |
| Every message signed per agent | Ed25519 over JCS (RFC 8785). Key status is checked **inside** verification, so revocation applies on the next request. |
| Side effects stop at the approval gate | A `side_effect` task is created into `needs-approval` and gets **no outbox row** — the assignee never sees it. Approval checks owner signature → single-use → hash against the *current* payload. |
| At-least-once delivery, exactly-once effect | Idempotency keys with in-process coalescing, so two concurrent callers perform the effect once and both receive the same response. |
| Ordering per thread | Durable outbox; the claim rule is "oldest live row of a thread with nothing inflight, and only if due" — a later row cannot overtake one mid-backoff. |
| The hub stores no secrets | No field for a model key anywhere. Outbound content is redacted (Luhn-checked cards, token shapes) before it leaves. |
| No LLM calls in the hub | None. |
| Least privilege | New agents get `read` + `message`; `request_side_effect` is additionally required to create a gated task. |
| Audit append-only, hash-chained | SQLite `BEFORE UPDATE`/`DELETE` triggers that `RAISE(ABORT)`. Tests issue raw SQL to prove the *database* refuses mutation. |

## Deliberate deviations from the PRD

- **Phase 0 auth is signature-only.** OAuth 2.1 and mTLS move to Phase 1.
  Recorded in the PRD's security table rather than left implied.
- **`node:sqlite` instead of `better-sqlite3`.** Same synchronous semantics, no
  native dependency to build for two platforms. Verified triggers, WAL,
  transactions and `.changes` before switching.
- **A2A, the Python SDK (now FR-18), the owner console and the CDK stacks** are
  out of Phase 0 scope.

## Review notes

Writing tests first caught **thirteen defects in the plan**, each fixed with a
test that failed first. The ones worth a reviewer's attention:

- Idempotency was not exactly-once — both concurrent callers ran the body and
  only the second *response* was discarded, after its rows were written.
- `listInbox` derived its cursor from the last item it built rather than the
  last row the store returned. A skipped row at the end of a page left the
  cursor behind it, and a page of only skipped rows returned `cursor: null` —
  which the SDK reads as "nothing new". One orphaned row would have wedged an
  agent's inbox permanently. Found by writing the module's first unit tests.
- The replay nonce was keyed on the timestamp, so two different requests in one
  millisecond collided; replay rejection then had to be scoped to unsafe unkeyed
  writes so it would not break the safe retry §1.4 promises.
- The turn-cap pause was rolled back by its own throw.
- `actorFor` trusted a synthetic `agent:<ws>-owner` ref — registrable, therefore
  impersonatable.
- The contract-drift guard was blind to untracked files.
- `.dockerignore` excluded `dist` but not `*.tsbuildinfo`, making the image build
  a silent no-op; `pnpm prune --prod` then stripped the workspace links. Both
  surfaced only because the container was actually run.

**A final review found and fixed one Important security hole:** `POST /v1/agents`
was wholly unauthenticated and the workspace arrived as a caller-supplied header,
so anyone who could reach the hub could enrol an agent into someone else's
workspace and message their agents. Registration is now gated by a required
token, constant-time compared. Four tests failed before the fix.

`make test-container` builds the image, boots it with a generated owner key and
registration token on a fresh volume, and drives it over HTTP only — no `Store`
handle exists on that side of the boundary. It covers what the in-process suite
structurally cannot: the env contract, the entrypoint and workspace links inside
the image, body redaction in the real log stream read back via `docker logs`,
that state survives `docker restart`, and the kill switch end to end. It is kept
out of `make check` and out of CI — a build-plus-boot is minutes, not seconds.

> ⚠️ **That review was a self-review** — same author, same blind spots. A fresh
> pair of eyes on the approval gate, the signing path and the delivery scheduler
> is the one thing this branch has not had.

Decisions are recorded as ADRs in [`docs/adr/`](docs/adr/) — including the two
the build itself produced (`node:sqlite` over `better-sqlite3`, and the
registration gate). [`docs/TASKS.md`](docs/TASKS.md) carries per-task status,
the fourteen defects TDD caught in the plan, and the verification debt this
branch is carrying.

## Known follow-ups

- `withIdempotency` coalescing is per-process; Phase 1 needs a durable
  reservation protocol once delivery splits out.
- OpenTelemetry **exporter** is not wired. `trace_id` propagation is — it is
  adopted from the caller and carried in the envelope so one trace spans both
  agents — but spans are not exported.

## Phase 0 exit gate

Not yet met — it requires the Claude ↔ Muse link running relay-free for seven
consecutive days. Everything needed to start that clock is here:
`examples/claude-muse/scripts/pilot.sh` runs the full exchange unattended and
exits non-zero on any failure, including a specific check that the approval gate
did not leak.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
