# 0003 — Use Node's built-in `node:sqlite` instead of `better-sqlite3`

- **Status:** accepted
- **Date:** 2026-10-20
- **Deciders:** lead
- **Relates to:** `CLAUDE.md` §3 (stack), §4 (dependency justification); spec §9

## Context

The Phase 0 design names `better-sqlite3` as the SQLite driver, chosen because
its API is **synchronous** — which is what lets the `Store` port expose
`transaction<T>(fn: () => T): T` and therefore write the task row, the audit row
and the outbox row atomically with no async interleaving (spec §3 step 4).

Installing it surfaced two problems:

1. **pnpm 12 blocks package build scripts by default.** `pnpm add
   better-sqlite3` failed with `ERR_PNPM_IGNORED_BUILDS` and required an
   explicit `allowBuilds` entry authorising the package to run a build script.
2. Even authorised, the native module needs a prebuilt binary matching the Node
   24 ABI, for **both** a Windows development machine and the Linux container —
   or a working `node-gyp` toolchain in the build image.

Meanwhile Node 24 ships `node:sqlite` in core, with a synchronous
`DatabaseSync` API.

`CLAUDE.md` §4 requires a justification for every third-party dependency. A
built-in that does the job needs none.

## Decision

Use **`node:sqlite`**. `better-sqlite3` is not a dependency of this project.

The substitution was verified by experiment *before* committing to it, because
the port's guarantees depend on specific SQLite behaviour. All four hold:

| Needed for | Verified |
|---|---|
| WAL mode | `PRAGMA journal_mode = WAL` |
| Append-only audit (`CLAUDE.md` §1.9) | `CREATE TRIGGER … RAISE(ABORT)` fires and throws |
| Atomic multi-row writes (spec §3) | explicit `BEGIN` / `COMMIT` / `ROLLBACK` |
| Idempotency conflict detection | `INSERT … ON CONFLICT DO NOTHING` reports `.changes` |

This is a deliberate deviation from the library named in spec §9 and
`CLAUDE.md` §3. Both have been updated.

## Consequences

**Good**

- Zero native dependencies in the whole hub. No build-script approval, no
  `node-gyp`, no per-platform prebuild to source, and no compiler toolchain in
  the Docker build stage.
- The Docker image got simpler and smaller: `node:24-bookworm-slim` with nothing
  added.
- One fewer third-party package in the dependency surface of the component that
  holds all the state.

**Bad**

- `node:sqlite` is still flagged **experimental** in Node 24. It emits an
  `ExperimentalWarning` and its API could change in a future major. Mitigated
  by pinning Node 24 in the image, and by the adapter being a single file behind
  the `Store` port — the blast radius of a breaking change is
  `hub/src/adapters/sqlite/store.ts`.
- Rows come back with a `null` prototype, which is fine for spreading but
  surprising if anything ever relies on `instanceof Object` or inherited
  methods.
- The ecosystem around `better-sqlite3` (extensions, helpers, Stack Overflow
  answers) does not apply.

**Neutral**

- Should this need reversing, it is one file plus a dependency: the `Store` port
  already demands synchronous transactions, which is the only property either
  library is being chosen for.

## Alternatives considered

**`better-sqlite3`, as the spec named** — approve the build script and source
prebuilds. Rejected on cost: it requires an `allowBuilds` grant letting a
third-party package execute code at install time, plus a working native build
path on two platforms, to obtain a property Node now provides in core.

**`node:sqlite` via a thin wrapper that could swap to `better-sqlite3`** — keep
both options open behind an internal abstraction. Rejected as redundant: the
`Store` port *is* that abstraction. Adding a second layer inside the adapter
would be indirection with no second consumer.

**An async driver (e.g. `sqlite3`, or libSQL)** — widely used, no sync
constraint. Rejected: it would force `Store.transaction` to be async, and an
async transaction boundary reintroduces exactly the interleaving the synchronous
port exists to prevent. The atomic write in spec §3 step 4 is the invariant; the
driver choice follows from it.

**Postgres instead of SQLite** — a real server, no native module, trivially
concurrent. Rejected for Phase 0: it adds a second running service to a phase
whose goal is "one `docker compose up` on a laptop". Reconsider at Phase 1
alongside DynamoDB, where the `Store` port makes it a one-file decision.
