# 0008 — A Store conformance suite, and what it says about the Phase 1 migration

- **Status:** accepted
- **Date:** 2026-10-21
- **Deciders:** owner (Jagadeesh), lead
- **Relates to:** [0001](0001-typescript-ports-and-adapters.md) (ports and adapters),
  [0003](0003-node-sqlite-over-better-sqlite3.md); `CLAUDE.md` §1.9, §3
- **Contract:** none; internal

## Context

Two things were true and untested.

**The fake and SQLite are assumed interchangeable.** Almost every hub test
runs against the in-memory `FakeStore`; production runs SQLite. Nothing
checked that they agree. The risk is not hypothetical — when
`listTasksByState` was added, its ordering had to be hand-matched between the
two implementations, with a comment noting that a divergence would let a test
pass against the fake and fail against the real store. That comment was the
only thing holding the line.

**"DynamoDB drops in as one new file" was a claim, not a finding.**
`CLAUDE.md` §3 and the design spec both say the six ports mean DynamoDB, SQS
FIFO, S3 and KMS each become one new file at Phase 1. Nothing could be run
against a candidate adapter to find out.

## Decision

**`hub/src/ports/store-conformance.ts` is one behavioural spec that every
`Store` implementation must pass**, run today against both the fake and
SQLite (48 assertions, 24 each). Any Phase 1 adapter joins that list before
it is believed.

It covers what the domain actually relies on rather than what the interface
happens to expose: workspace isolation on every read, transaction commit and
rollback, nested transactions joining the outer one, read-your-own-writes,
ordering and limits, null-versus-absent, upsert semantics, and audit
monotonicity.

The suite was checked by mutation rather than by passing. Reversing the
fake's `listTasksByState` ordering and un-scoping its nonce lookup each
produced exactly one failure. A conformance suite that has never been seen to
fail is decoration.

## What it revealed: the Phase 1 Store migration is not one file

The `READS ITS OWN WRITES inside the transaction` case is the one that
matters. The domain does read-modify-write inside `transaction()` throughout —
`registerAgent` reads `getAgent` before writing, `updateTask` reads `getTask`
before `setTaskState` — but the decisive case is the audit chain.

`appendAudit` reads `lastAuditHash(workspace)` and then writes a row whose
hash commits to it. It is called from 14 sites, nearly all already inside a
`transaction()`. So **every audited operation is a read-modify-write that must
be atomic**, and if two of them interleave, both read the same `prevHash` and
the chain forks — which `verifyAuditChain` would then correctly report as
tampering, on a hub that had done nothing wrong.

DynamoDB's `TransactWriteItems` performs **no reads**. `TransactGetItems` is a
separate operation and cannot be combined. A direct translation of this port
onto DynamoDB therefore cannot preserve `CLAUDE.md` §1.9.

The port shape survives, though, and that is the useful part. Because
`transaction(fn)` takes a **closure** rather than a batch of writes, an
adapter can implement it with optimistic concurrency: keep a per-workspace
chain-head item, read it, run `fn`, and commit with a condition that the head
is unchanged — re-invoking `fn` on contention. The six-port design is not
wrong; the estimate attached to it was.

Two consequences follow, and both are now recorded rather than discovered
mid-migration:

- A DynamoDB `Store` is a **retry-capable optimistic-concurrency adapter**,
  not a translation layer. Call it days, not an afternoon.
- `transaction(fn)` callbacks must be **safe to re-run**. They are today —
  they read, compute and write with no outside effects — but nothing enforces
  it, and a callback that sent an email or consumed a nonce generator would
  break silently under contention.

`CLAUDE.md` §3's "one new file each" is corrected to name the Store as the
exception. SQS FIFO, S3 and KMS are genuinely small: `Queue`, `BlobStore` and
`Signer` have no read-modify-write.

> **Corrected by [ADR 0009](0009-the-sync-port-boundary.md) (2026-10-26).** The
> sentence above is wrong about two of the three. Absence of read-modify-write
> was the only criterion applied, and it was not sufficient: `Queue` is
> synchronous in `claimNext`/`recoverInflight` and `Store` in all 45 of its
> methods, which no networked database can implement in Node — so the barrier
> to DynamoDB is not only the audit chain's atomicity but the port's
> synchronicity. `Signer`, meanwhile, has no caller in the hub at all and could
> not use KMS regardless, which has no Ed25519. Only `BlobStore`/S3 was
> genuinely small, and it has since shipped.

## Consequences

**Good**

- The assumption the whole test suite rests on is now checked, on every run,
  rather than resting on a comment.
- Phase 1 has an acceptance test that exists before the code it will judge.
- The hardest part of the migration is known now, when it is a paragraph,
  rather than later when it is a half-written adapter.

**Bad, or at least a cost**

- 48 more assertions on every `make check`. Cheap, but it is the second suite
  that must be updated when the port changes — the first being the fake.
- The suite tests the port as the domain uses it, not exhaustively. Artifacts,
  approvals, outbox claiming and idempotency are covered by their own tests
  against the real store but are thin here; an adapter could pass this and
  still be wrong about outbox claim ordering, which is subtle and load-bearing.
- It cannot catch what both implementations get wrong in the same way, which
  is precisely what a single author writing both is most likely to produce.

## Alternatives considered

**Write the DynamoDB adapter and find out.** Rejected: it would have been
written against an untested notion of what `Store` means, and the transaction
problem would have surfaced as a subtly forked audit chain under concurrency —
the worst possible place to discover it, since the symptom is the integrity
check reporting tampering.

**Run the existing hub test suite against SQLite as well as the fake.**
Cheaper, and it would have caught some divergence. Rejected because those
tests assert domain behaviour through the store; a failure would not say
whether the domain or the adapter was wrong, and a new adapter could not be
judged without standing up the whole hub around it.

**Property-based testing instead of examples.** Appealing for a data store
and a better fit for finding the cases a single author would not think of.
Rejected for now only on cost; it is the right next step if a third
implementation appears, and would attack the "both wrong the same way"
weakness above.
