# console — the owner's approval queue

The surface where a human decides what their agents are allowed to do. Phase 0
ships the approvals view; the task board, audit log and kill switch follow.

```bash
pnpm --filter @agentbridge/console run dev   # http://localhost:3000
```

Point it at a hub with `AGENTBRIDGE_URL` (default `http://localhost:8080`).

## Where the owner key lives

In the tab, in memory, and nowhere else.

You pick the key file `agentbridge keygen` wrote; it is parsed in the page and
held in React state. It is never uploaded, never written to `localStorage`,
`sessionStorage`, `IndexedDB` or a cookie, and never reaches the Next.js
server. Closing the tab ends the session and you pick the file again — the
inconvenience is the point, because this key authorises every side effect in
the workspace.

Three things hold that up rather than good intentions:

- `owner-key.test.ts` greps every console source for storage APIs and for
  `node:` imports, with a third test asserting the file list is non-empty so
  the guard cannot pass vacuously.
- `@agentbridge/sdk/owner` is a subpath export that avoids `keys.ts`, which
  uses `node:fs`. The root export would not bundle.
- `contracts` hashes with `@noble/hashes` rather than `node:crypto`, so the
  page can compute a payload hash itself.

There is no API route in this app. The only server-side behaviour is a
path-preserving rewrite of `/v1/*` to the hub (`next.config.mjs`), which keeps
requests same-origin so the hub needs no CORS, and keeps the signed path equal
to the verified path. A proxy that rewrote the path would invalidate every
signature, and the obvious fix — re-signing server-side — is exactly what must
not happen.

## What it signs

The hash shown under each payload is **recomputed in the page** from the
payload displayed, never taken from the hub's `payload_hash`. Signing the
hub's figure would approve whatever the hub asserted, which is the one thing
the approval gate exists to prevent. When the two disagree the row says so and
the hub refuses the decision (`approval_hash_mismatch`).

See [ADR 0006](../docs/adr/0006-owner-authenticated-routes.md).

## The kill switch

The **Agents** tab lists the workspace roster and revokes a key. Revoking stops
that agent on its very next request — key status is checked inside signature
verification — and drops whatever was already queued for it.

It asks you to type the agent's name rather than accepting one click. There is
no un-revoke in Phase 0; the agent must be re-enrolled with a new key.

Until ADR 0006 this endpoint accepted **any** authenticated agent with no scope
check, so an agent holding the default `read` + `message` could revoke every
other agent in the workspace. It is owner-only now.

## Not yet here

Task board, audit viewer, and anything resembling multi-user access. Phase 0 is one owner with one key; ADR 0004 names WebAuthn as the
eventual home for that key, which would remove the file picker.
