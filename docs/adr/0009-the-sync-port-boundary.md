# 0009 — The synchronous port boundary, and which Phase 1 adapters are actually possible

- **Status:** accepted
- **Date:** 2026-10-26
- **Deciders:** owner (Jagadeesh), lead
- **Relates to:** [0001](0001-typescript-ports-and-adapters.md) (ports and adapters),
  [0003](0003-node-sqlite-over-better-sqlite3.md) (`node:sqlite`),
  [0008](0008-store-conformance-and-the-phase-1-migration.md) (Store conformance);
  `CLAUDE.md` §1.5, §1.9, §3
- **Contract:** none; internal ports only

## Context

ADR 0008 corrected "DynamoDB drops in as one new file" to "days, not an
afternoon", on the grounds that the audit chain's read-modify-write cannot be
expressed as `TransactWriteItems`. It then asserted, in passing, that **"SQS
FIFO, S3 and KMS are genuinely small"**.

That second claim was never tested either. Writing the S3 adapter was the
occasion to test all three, and two of them do not survive.

## Finding 1 — `Store` is synchronous in all 45 of its methods

Not one method on `Store` returns a promise. `transaction<T>(fn: () => T): T`
takes a **synchronous** callback, and every read inside it —
`getAgent`, `getTask`, `lastAuditHash` — returns a value, not a promise.

This was a deliberate and well-reasoned choice. ADR 0003 adopted `node:sqlite`
whose `DatabaseSync` is synchronous, and §3 of `CLAUDE.md` records why that is
desirable: it is what lets the task row, the audit row and the outbox row be
written "atomically with no async interleaving". A synchronous transaction
cannot be interleaved, because there is no await point at which the event loop
could run anything else. A great deal of the hub's correctness is free because
of it.

The consequence that was not recorded: **a synchronous port can only be
implemented by an embedded database.** Node cannot serve a synchronous method
from network I/O. This is not a DynamoDB limitation — it is equally true of
Aurora, RDS Postgres, MySQL and every other networked store, all of whose Node
drivers are async. The two escape hatches are both unacceptable here:
blocking the event loop on a synchronous HTTP call, or `Atomics.wait` on a
worker thread, which serialises every database access in the process.

So the six-port design does not, as claimed, leave the choice of Phase 1
database open. The synchronous `Store` **is** a commitment to embedded storage.

## Finding 2 — `Queue` is two-fifths synchronous, and SQS is not one file

`Queue.claimNext(now): OutboxRow | null` and `recoverInflight(now): void` are
synchronous; `enqueue`, `complete` and `fail` are not. SQS's `ReceiveMessage`
is async, so the same wall applies.

There is a second problem independent of the first. The only implementation of
`Queue` is an inline object in `delivery/src/queue/outbox-scheduler.ts` that
delegates to `Store.claimNextOutbox`, where the per-thread ordering rule of
§1.5 is actually enforced — "the oldest non-terminal row of a thread that has
nothing in flight, and only if that row is due". SQS FIFO does provide
per-group ordering via `MessageGroupId`, which is why §3 names it, but it does
**not** provide "hold this group until the in-flight row's backoff expires":
a FIFO group blocks on the in-flight message's visibility timeout, which is a
different rule with different behaviour on retry. Moving to SQS replaces the
scheduler and relocates an invariant; it does not add a file beside it.

## Finding 3 — the `Signer` port has no implementation and no callers

`Signer` is referenced in exactly two places: its own declaration, and
`FakeSigner` in the test fakes. **Nothing in the hub calls it.** That is
correct behaviour, not an omission — agents sign their own envelopes with keys
the hub never holds (§1.2, §1.6), and outbound webhooks are HMAC-signed with
the per-agent secret. The hub signs nothing.

Separately, AWS KMS could not back this port as specified even if something
did call it: KMS asymmetric signing offers RSA and ECDSA, and **has no Ed25519
algorithm**. §1.2 requires Ed25519, and agents verify those signatures, so the
algorithm is part of a published contract and cannot be swapped.

"KMS is one new file" was therefore a plan to migrate a port that nothing uses,
to a service that cannot implement it.

## Finding 4 — `BlobStore` is genuinely one file, and is now done

`BlobStore.put`/`get` both return promises and have no read-modify-write. The
S3 adapter is `hub/src/adapters/s3/blob.ts`, 1 file, and it passes the same
`blob-conformance.ts` spec as the filesystem adapter — 12 cases each, run
against LocalStack.

Exactly one of the three "small" adapters was small.

## Decision

1. **Record the corrected position.** `CLAUDE.md` §3 and ADR 0008's closing
   paragraph are amended: of the Phase 1 adapters, only S3 is a drop-in. The
   `Signer`/KMS line is withdrawn entirely.
2. **Ship the S3 adapter** behind the existing port, conformance-tested, with
   `pnpm run test-aws` as the target that proves it ran rather than skipped.
3. **Do not write a DynamoDB or SQS adapter against the current ports.** Either
   would require the port change below, and writing one first would mean
   discovering it a second time.
4. **The synchronous-port question goes to the owner as a Phase 1 blocking
   decision**, stated below, because the two answers imply materially different
   amounts of work and different AWS topologies. It is not a decision the lead
   should make silently inside an adapter.

## The decision the owner has to make

**Option A — make `Store` async.** `transaction` takes an async callback;
all 45 methods return promises; every domain module and route awaits. Mechanical
but wide, and it gives up the property ADR 0003 bought: once a transaction can
await, operations inside it can interleave, so the atomicity §1.9 depends on
must come back from the adapter's own concurrency control — which is exactly the
optimistic-concurrency retry ADR 0008 sketched, and is coherent. SQLite keeps
working throughout (wrap the sync calls), so the migration is testable at every
step against the existing conformance suite. Cost: a wide refactor plus a real
risk of reintroducing an interleaving bug in a path where the symptom is the
audit chain reporting tampering.

**Option B — keep `Store` synchronous and keep embedded storage in Phase 1.**
The hub stays single-writer: one task on ECS with the SQLite file on EFS, or
litestream-style replication for durability. Costs horizontal scale of the hub
process, which for a single owner's workspace is very likely irrelevant, and is
reversible later. Keeps every atomicity guarantee the current tests verify.
SQS/S3/KMS line items collapse to just S3, already done.

**Recommendation: B for now, A only when a second hub instance is actually
needed.** Nothing in the PRD requires horizontal scale of the hub, the current
invariants are enforced by a design that depends on synchronicity, and Option A
spends days of refactor plus the review debt this branch already carries to buy
scale that has no user waiting for it. B also leaves A fully available: the
conformance suite is the acceptance test either way.

## Consequences

**Good**

- Two false "one new file" estimates are corrected before anything was built on
  them, and the one true case is shipped.
- `Signer` is identified as dead port surface. It can be deleted, which is one
  fewer thing for a Phase 1 adapter author to mistakenly implement.
- `pnpm run test-aws` makes an adapter claim falsifiable without an AWS account,
  satisfying §7's prohibition on touching a real one.

**Bad, or at least a cost**

- Phase 1's headline promise — DynamoDB, SQS FIFO, KMS — is now explicitly
  blocked on an owner decision rather than quietly in progress. The honest
  percentage of Phase 1 complete drops.
- The S3 adapter is verified only against LocalStack. LocalStack is not S3;
  consistency, IAM and multipart behaviour are approximations. It is enough to
  judge the adapter's logic and not enough to call it production-proven.
- `blob-conformance.ts` is the third suite that must be updated when a port
  changes, after the fake and `store-conformance.ts`.

## Alternatives considered

**Write the DynamoDB adapter with a blocking worker-thread shim.** Rejected.
`Atomics.wait` would let a synchronous `Store` sit on async I/O, preserving the
port exactly — and would serialise every database access in the process behind
one channel, turning the hub's concurrency into a queue. It trades a visible
refactor for an invisible throughput ceiling.

**Make only the read methods async.** Rejected: the read-modify-write inside
`transaction()` is precisely where reads happen, so this changes nothing about
the hard case while leaving the port half-converted.

**Delete `Signer` in this ADR.** Deferred, not rejected. It is unused, so
removing it is safe, but it is a port listed in the design spec and §3, and
deleting published design surface belongs in its own change rather than as a
footnote to an S3 adapter.
