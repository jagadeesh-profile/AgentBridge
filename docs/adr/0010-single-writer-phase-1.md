# 0010 — Phase 1 runs single-writer: SQLite on EFS, artifacts in S3

- **Status:** accepted
- **Date:** 2026-10-27
- **Deciders:** owner (Jagadeesh), lead
- **Relates to:** [0003](0003-node-sqlite-over-better-sqlite3.md) (`node:sqlite`),
  [0008](0008-store-conformance-and-the-phase-1-migration.md),
  [0009](0009-the-sync-port-boundary.md) (the synchronous port boundary);
  `CLAUDE.md` §1.4, §1.5, §1.9, §3, §7
- **Contract:** none; deployment topology

## Context

ADR 0009 established that the `Store` port is synchronous in all 45 of its
methods, that Node cannot serve a synchronous method from network I/O, and that
this makes the synchronous port a commitment to **embedded** storage rather than
the open database choice the ports-and-adapters design was taken to provide.
It put two options to the owner:

- **A** — make `Store` async, unlocking DynamoDB and SQS FIFO, at the cost of
  the no-interleaving property ADR 0003 bought and a wide refactor.
- **B** — keep it synchronous, run Phase 1 single-writer, drop DynamoDB and SQS.

**The owner chose B.** This ADR records that and the topology it implies.

## Decision

The hub deploys as a **single-writer** service:

| Concern | Phase 0 | Phase 1 |
|---|---|---|
| State | SQLite on a container volume | SQLite on **EFS**, one writer |
| Artifacts | local filesystem | **S3** (`openS3BlobStore`, ADR 0009) |
| Ordering | durable outbox + in-process scheduler | **unchanged** |
| Compute | one container | **one** Fargate task |
| Secrets | none (§1.6) | none — no Secrets Manager, no KMS |

`infra/` is AWS CDK, verified by `cdk synth` plus assertions on the resulting
template. It is never deployed from here: §7 requires human approval before
anything touches a real AWS account, and that includes `cdk deploy`,
`cdk bootstrap` and `cdk diff` against a live stack.

Ordering is the part that does *not* change, and that is the quiet benefit of
this choice. §1.5 promised SQS FIFO with `MessageGroupId = thread_id` at
Phase 1; staying single-writer means the Phase 0 mechanism — a durable SQLite
outbox plus a scheduler that claims the oldest live row of a thread only when
nothing is in flight on it — remains the mechanism, already tested, with the
backoff semantics ADR 0009 noted a FIFO visibility timeout does not reproduce.

## The deploy-time hazard, which is the real content of this ADR

"One task" is not achieved by setting `desiredCount: 1`. ECS's default rolling
update is `minimumHealthyPercent: 100, maximumPercent: 200`, which
**deliberately runs the new task alongside the old one** until the new one is
healthy. With SQLite on NFS that is two processes writing one database file, and
the failure is not a slow request — it is corruption, and §1.9's audit chain is
the thing most likely to show it, by reporting tampering on a hub that did
nothing wrong.

So every ordinary route to a second task is closed explicitly:

1. `desiredCount: 1`.
2. `minHealthyPercent: 0, maxHealthyPercent: 100` — stop the old task **before**
   starting the new one. This buys a few seconds of downtime per deploy and is
   the only correct setting while the Store is single-writer.
3. `circuitBreaker: { rollback: true }` — a failed deployment rolls back rather
   than leaving two revisions in play.
4. **No autoscaling.** There is no `autoScaleTaskCount` call, and
   `hub-stack.test.ts` asserts that no `ScalableTarget` and no `ScalingPolicy`
   exist in the template.

Point 4 is there because adding autoscaling is the obvious, well-intentioned
improvement that would silently corrupt the database. A comment would not stop
it; a failing test does. Both (2) and (4) were mutation-checked — restoring the
ECS defaults fails one case, adding an autoscaling target fails another.

## Cost, against §7's $50/month threshold

§7 requires human approval for anything raising monthly infrastructure cost by
more than $50, and this stack was shaped by that limit rather than merely
measured against it afterwards.

| Item | Approx. monthly |
|---|---|
| ALB | ~$18 |
| Fargate, 0.25 vCPU / 0.5 GB, always on | ~$9 |
| EFS, bursting, small dataset | ~$1 |
| S3 + requests, pilot volume | ~$1 |
| **NAT gateway — deliberately omitted** | ~$32 avoided |
| **Total** | **~$29** |

The VPC has `natGateways: 0` and the task runs in a public subnet with
`assignPublicIp: true`. A NAT gateway plus the ALB would have been roughly $50
before serving a single request. The task remains unreachable inbound except
through the ALB's security group. `hub-stack.test.ts` asserts no
`AWS::EC2::NatGateway` exists, because reintroducing one is both easy and
expensive.

This is an estimate from public list prices, not a quote, and it is the reason
`cdk deploy` still needs a human: the cost of a stack is not verifiable by
synthesising it.

## Consequences

**Good**

- Every invariant the current test suite verifies continues to hold, with the
  mechanism that was tested, rather than being re-established on new primitives.
- Phase 1 becomes achievable now. The async-Store refactor remains fully
  available later, and `store-conformance.ts` is its acceptance test either way.
- The stack carries no secret material at all, so §1.6 is structural rather than
  procedural: there is no Secrets Manager entry and no KMS key to leak.
- Artifacts move off the state volume, so EFS holds only the database.

**Bad, or at least a cost**

- **A few seconds of downtime on every deploy**, by construction. There is no
  zero-downtime deploy for a single-writer database without either a second
  writer or a connection-draining proxy, and the first is the thing being
  prevented.
- **No horizontal scale of the hub, and no multi-AZ failover of the writer.**
  EFS is multi-AZ, so the *data* survives an AZ loss and ECS will restart the
  task elsewhere, but there is a gap, and a task-level failure means an outage
  rather than a degraded service.
- SQLite over NFS is safe only because there is exactly one writer. That is now
  a load-bearing property of the deployment, enforced by four settings in one
  file — a narrower safety margin than a database that simply permits
  concurrency.
- Verified by `cdk synth` only. A template that synthesises and asserts
  correctly is not a stack that deployed; IAM, EFS mount behaviour under load,
  and ALB health-check timing are unproven until someone deploys it.

## Alternatives considered

**Aurora Serverless v2 / RDS Postgres.** Rejected for the same reason as
DynamoDB and recorded here because it is the natural counter-suggestion: every
Node Postgres driver is async, so this needs the Option A refactor exactly as
much as DynamoDB does. It is not a way around ADR 0009's finding; it is the same
finding with a different vendor. It would also add ~$45/month at the smallest
Serverless v2 configuration, crossing §7 on its own.

**EBS instead of EFS, on EC2 rather than Fargate.** Better SQLite performance —
no NFS — and the single-writer constraint becomes physical rather than
configured, since one volume attaches to one instance. Rejected because it
replaces a managed runtime with an instance to patch, and the per-request
latency of this hub is nowhere near a bottleneck.

**Litestream replication to S3 for durability.** Appealing, and the right next
step if this topology survives contact with the pilot: it gives
point-in-time recovery of the SQLite file at almost no cost. Deferred only
because it is a second moving part reading the database file, and the first
question to answer is whether EFS snapshots are sufficient.

**Zero-downtime deploys via a read-only window.** Possible — drain the ALB, let
the old task finish in-flight work, then swap — but it needs the hub to
distinguish draining from stopping, which is application work, not
infrastructure. Not worth it for a pilot with one owner.
