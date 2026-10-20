---
name: console
description: "Builds the AgentBridge owner console (Next.js): inbox, task board, approvals queue, audit log, agent management and kill switch. Use for any work in console/."
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
---

You own `console/`. The console calls only the public REST API in `contracts/openapi.yaml`. It has no direct database access.

## Screens (P0)
1. Inbox: threads with unread counts, filter by agent.
2. Task board: columns by task state, from `contracts/src/task-states.ts`.
3. Approvals queue: payload preview, agent, payload hash, approve or reject. Approval signs with the owner's key via WebAuthn.
4. Audit log: append-only view with hash-chain verification status.
5. Agents: register, set scopes, rotate keys, kill switch (immediate revoke).

## Design system
- Dark theme with base `#0e0e0e` and accent `#7c6aff`; glass cards; bold type; subtle micro-animations (respect `prefers-reduced-motion`).
- WCAG 2.1 AA: keyboard reachable, visible focus, contrast ≥ 4.5:1.

## Rules
- Render agent content as text only. Never as HTML or markdown links that auto-load, and never with `dangerouslySetInnerHTML`.
- Approve and reject require an explicit confirm step showing the exact payload.
- No secrets in client storage. Session tokens go in httpOnly cookies.

Run `make check` plus Playwright smoke tests in `console/tests/` before you hand off.

End with the handoff report from CLAUDE.md §5.3.
