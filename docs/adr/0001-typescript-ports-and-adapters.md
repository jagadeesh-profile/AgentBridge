# 0001 — TypeScript, ports-and-adapters, one container for Phase 0

- **Status:** accepted
- **Date:** 2026-10-20
- **Deciders:** owner (Jagadeesh), lead
- **Supersedes:** the Python 3.12 / FastAPI stack in `CLAUDE.md` §3 and the
  "Suggested stack" paragraph of the PRD

## Context

Phase 0 has one job: get the Claude ↔ Muse link running relay-free for seven
consecutive days. Everything else — scale, federation, the agent directory — is
later, and the PRD's non-functional targets (10k workspaces, 5M messages/day)
are Phase 2 concerns.

The repo originally specified Python 3.12 with FastAPI for `hub/` and AWS from
the start (ECS Fargate, SQS FIFO, DynamoDB, S3). That meant two languages in one
project — Python for the hub, TypeScript for the SDK and console — and an AWS
dependency before the first message had ever flowed between two agents.

Three forces mattered:

1. The exit gate is a **working pilot**, not a scalable platform. Time-to-first-
   message dominates.
2. The hub must be runnable on a laptop or a small VPS. Phase 0 has no AWS
   account and should not need one.
3. Phase 1 *is* AWS. Whatever Phase 0 does must not have to be rewritten to get
   there.

## Decision

**TypeScript everywhere**, and **ports-and-adapters in a single container**.

The hub's domain depends only on six interfaces — `Store`, `Queue`,
`BlobStore`, `Clock`, `IdGen`, `Signer`. Phase 0 implements them with SQLite, a
durable outbox plus an in-process per-thread scheduler, and the local
filesystem. Delivery runs in the same process, splittable by `DELIVERY_MODE`
without a code change.

Contracts are **Zod-first**: the schemas in `contracts/src/` are the single
source of truth, and JSON Schema plus `openapi.yaml` are generated from them and
drift-checked in CI.

One language means the envelope type is *the same type* in the hub, the SDK and
the MCP adapter. Two languages would have meant two type systems kept in sync by
discipline, which is the usual place a contract quietly rots.

## Consequences

**Good**

- The six interfaces are the Phase 1 migration surface. DynamoDB, SQS FIFO, S3
  and KMS each become one new file implementing an existing port; nothing in
  `hub/src/domain/` changes.
- The domain is tested against in-memory fakes with no I/O at all, so the state
  machine and the approval gate are covered by fast, deterministic tests.
  `Clock` and `IdGen` being ports means no test reads the wall clock or sleeps.
- `docker compose up` is the whole dev stack. No LocalStack, no AWS credentials,
  no bill.
- The `hub/` vs `delivery/` ownership split from `CLAUDE.md` §2 survives intact,
  so the subagent boundaries still mean something.

**Bad, or at least a cost**

- Three extra files of indirection that Phase 0 alone does not need. The payoff
  is entirely in Phase 1 and in testability.
- `node:sqlite`'s synchronous API shaped the `Store` port (`transaction<T>(fn):
  T` is sync). A future async-only adapter would need that signature widened.
  See [0003](0003-node-sqlite-over-better-sqlite3.md).
- Two runnable entry points to understand: the hub server and the stdio MCP
  binary.
- The composition root ended up in `delivery/`, not `hub/`, because hub
  importing delivery while delivery imports hub's ports is a cycle that
  TypeScript project references reject. That is surprising on first read and is
  commented in `delivery/src/main.ts`.

## Alternatives considered

**Two services from the start** — separate `hub` and `delivery` containers in
compose, sharing SQLite in WAL mode. Matches the Phase 1 ECS topology exactly,
so there would be no "we ran it differently in dev" surprise. Rejected: it buys
production fidelity that cannot be used until Phase 1, and charges for it now in
cross-process SQLite writer contention and a slower test loop.

**Single flat service, no seams** — one `src/`, direct SQLite calls in route
handlers, port to AWS later by rewriting. Fastest to a first running message and
the least code. Rejected: it violates the `CLAUDE.md` §2 ownership table, since
every subagent would be editing the same files, and it turns the Phase 1 move
from "three new files" into a rewrite of the only code that has ever worked.

**Keep Python for the hub** — honour the original stack, accept two languages.
Rejected: the envelope would exist as a Pydantic model and a TypeScript type,
and keeping them identical is manual work that fails silently. Generating one
from the other is possible but adds a build step whose output nobody reads.

**LocalStack from day one** — real DynamoDB and SQS FIFO semantics locally, no
porting work later. Rejected for Phase 0: Docker becomes mandatory to develop,
the test loop slows, and a lot of infrastructure code has to exist before the
first message flows. Revisit at Phase 1, where it is the natural choice.
