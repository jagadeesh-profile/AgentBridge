# @agentbridge/a2a

A2A v1.0 protocol translation: the Agent Card, the JSON-RPC 2.0 envelope, and
the AgentBridge↔A2A mapping. Pure — `contracts` is its only dependency, and it
performs no I/O and holds no identity.

**The routes are not here.** They live in `hub/src/http/a2a.ts`, and that is
deliberate ([ADR 0007](../../docs/adr/0007-a2a-endpoint-inside-the-hub.md)).

MCP is an outbound stdio client, so it can be a thin REST client of the hub and
sign with the agent's own key. A2A is an inbound HTTP server: the remote agent
signs *its* request, and an Ed25519 signature covers that request's method,
path and body hash. A proxy receiving `POST /a2a/v1` and forwarding
`POST /v1/tasks` would hold a signature for a request that no longer exists —
it could only work by the hub trusting a header about what was signed, or by
the adapter re-signing with its own key and becoming a confused deputy whose
scopes every caller inherits. Serving A2A from inside the hub means the
signature covers exactly what the hub verifies.

## Talking to it

```bash
curl https://your-hub/.well-known/agent-card.json
```

Then JSON-RPC 2.0 to `POST /a2a/v1`, signed exactly as any AgentBridge REST
call is — `x-agentbridge-workspace`, `-agent`, `-timestamp`, `-signature`. The
card declares this as the `agentbridgeSignature` security scheme.

| Method | Maps to |
|---|---|
| `message/send` | create a task for `metadata["agentbridge/assignee"]` |
| `tasks/get` | read a task you created or were assigned |
| `tasks/cancel` | cancel a task **you created**, via the creator transition |
| `message/stream`, `tasks/resubscribe` | `-32004`, not supported |
| `tasks/pushNotificationConfig/set` / `/get` | push to an **owner-authorised origin** (see below) |

`metadata["agentbridge/assignee"]` is required: A2A addresses an endpoint,
AgentBridge addresses a named agent, and the hub will not guess which one.

## The state mapping worth knowing

A side-effect task reports **`auth-required`**. A2A has no approval gate, and
that is the closest honest answer — the task is blocked pending an
authorisation the caller cannot supply. `working` would be a lie and
`input-required` would invite input that does not release it. The underlying
state is also surfaced as `metadata["agentbridge/state"]`.

| AgentBridge | A2A |
|---|---|
| `needs-approval` | `auth-required` |
| `accepted` | `working` (A2A has no `accepted`) |
| everything else | same name |

## Push notifications, and why the URL is constrained

`pushNotificationConfig/set` would normally be an SSRF primitive — an endpoint
where you name a URL the hub then POSTs to. So **the URL must share an origin
with your agent's registered webhook**, the origin the workspace owner signed
at enrolment. You pick the path; you cannot pick the host. An agent with no
registered webhook cannot use push and should poll.

Notifications carry the A2A `Task` shape and no payload — a state change is
the notification, and detail comes from `tasks/get`. Your `token` arrives in
`x-a2a-notification-token`, and `pushNotificationConfig/get` never echoes it
back. Delivery goes through the same path as ordinary webhooks, so retries,
backoff and the dead-letter queue apply.

## Not yet

Streaming is declared `false` on the card rather than advertised and
stubbed. There is no separate A2A conformance suite — coverage
lives in `hub/src/http/a2a.test.ts`, and a real suite should run against the
published spec rather than against one reading of it.
