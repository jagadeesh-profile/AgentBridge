# AgentBridge — Universal Agent Connector PRD

Oct 20, 2026 · @Jagadeesh&#32;

## TL;DR

AgentBridge is a neutral, event-driven hub that lets any AI agent (Claude, ChatGPT, Gemini, a custom LangGraph or CrewAI agent) find another agent, hand it work, and get results back, without a human relaying messages. Agents connect once through an MCP server, the A2A protocol, a webhook or an SDK. They then share threads, tasks and artifacts like two teammates in one workspace.

The MVP bet: a shared task board plus push delivery (webhook and MCP wake-up) removes the polling, identity confusion and copy-paste glue that blocked Claude and Muse on 2026-10-20. Every side-effect action stays behind a human approval gate.

## Problem

Two capable agents owned by the same person could not work together without that person in the loop. On 2026-10-20, connecting Claude to Muse (a personal agent running job sweeps, resume tailoring and Gmail watching) through Notion exposed five gaps:

| Gap | What happened | Impact |
| --- | --- | --- |
| No push channel | Claude cannot be woken when Muse replies; the user had to say "check again" | A human relays every turn |
| Polling floor | Claude's scheduler allows at most one run per hour; a 1-minute schedule was refused | Up to 60 min per reply |
| No agent identity | Both agents post as the user's Notion account; senders are told apart only by a `FROM:` prefix | Spoofable, no accountability |
| No shared task state | A Notion database, a hand-written protocol and status columns had to be improvised | Fragile, rebuilt per pair of agents |
| Paywalled native agents | Notion's own agent tools need a Business plan | Lock-in to one vendor's agent layer |

The same gaps exist between any two agent platforms. Every pairing (Claude and ChatGPT, a CrewAI crew and a Bedrock agent) is wired by hand today, usually through a document store, email or a chat app that was never built for agents.

## Goals and non-goals

v1 succeeds when two agents from different vendors finish a multi-step task together, with a human approving only the side effects.

**Goals (v1)**

1. **Connect any agent in under 15 minutes** through MCP, A2A, webhook or the TypeScript SDK, with no code change on the agent vendor's side. (A Python SDK follows in P1; see FR-18.)
2. **Event-driven delivery:** an agent is notified within 5 s of a message or task addressed to it, with polling only as a fallback.
3. **Shared work state:** threads, tasks with owners and status, and artifacts that both agents read and update.
4. **Verifiable agent identity:** every message is signed by the sending agent, not by the human's account.
5. **Human-in-the-loop governance:** side-effect actions pause for owner approval, with a full audit trail.
6. **Free tier** that covers one owner, three agents and personal workloads like Claude and Muse.

**Non-goals (v1)**

- Hosting or running agents. AgentBridge connects agents; each runs on its own platform.
- Building an LLM, a planner or an agent framework.
- Replacing MCP or A2A. AgentBridge implements them and adds the hub, state and governance they leave out.
- Cross-organization marketplaces and billing between agents.
- Real-time voice or streaming media between agents.

## Users and use cases

The first users are individuals and small teams who already run two or more agents and act as the glue between them.

| Persona | Who | Pain today | What they need |
| --- | --- | --- | --- |
| Agent owner | Power user running personal agents (e.g. Claude + Muse) | Relays messages by hand; agents can't see each other's work | A shared inbox and board, approvals on their phone |
| Agent builder | Engineer shipping LangGraph, CrewAI or AutoGen agents | Writes custom glue for every external agent | One SDK, one protocol, signed identities |
| Team lead | Runs a team of humans and agents | No view of what agents did, for whom, and why | Audit log, permissions, cost per agent |
| Platform vendor | Company exposing its own agent | Must build N integrations | Publish once as an AgentBridge-compatible agent |

**Core use cases**

1. **Delegate and report back.** Claude asks Muse for the three newest job matches; Muse returns a result with links; Claude drafts recruiter replies. No human relays any step.
2. **Pipeline hand-off.** A research agent produces a brief, a writer agent drafts, a reviewer agent critiques, then a human approves publishing.
3. **Parallel split.** A lead agent splits a task into subtasks, assigns them to specialist agents, and merges the results.
4. **Second opinion.** One agent asks another, possibly from a different vendor, to review code, a plan or a claim before acting.
5. **Approval-gated action.** Muse wants to send an email or submit an application; the action waits until the owner approves it from the inbox or a push notification.

## Product overview

Agents connect to one hub over the protocol they already speak. The hub verifies who they are, stores the shared work, pushes each item to its recipient, and holds every side effect until the owner approves it.

&#91;embedded content: AgentBridge architecture · 4 agent types, 5 hub layers, 1 owner\]

Messages pass through the hub from top to bottom: adapters normalize them, identity checks sign and scope them, state stores them, and delivery pushes them out. Only side-effect actions reach the approval gate.

**Core concepts**

| Concept | Definition |
| --- | --- |
| Workspace | An owner's space: their agents, humans, threads and policies |
| Agent | A registered participant with a key pair, a capabilities card and permission scopes |
| Thread | An ordered conversation between agents and humans |
| Task | A unit of work with an owner, assignee, lifecycle state and artifacts |
| Artifact | A versioned output (text, JSON, file, link) attached to a task |
| Approval | A signed owner decision on one side-effect payload |

**Claude ↔ Muse on AgentBridge**

1. Claude creates a task for Muse: "list the 3 newest job matches".
2. The hub pushes it to Muse's webhook within seconds; there is no hourly wait.
3. Muse completes the task, attaches the links as an artifact and marks it `completed`.
4. The hub sends Claude an MCP notification, or a wake-up signal if Claude has no live session, and Claude drafts recruiter replies.
5. Sending those emails is a side effect, so it waits in the owner's approvals queue. The owner taps approve and Muse sends.

## Functional requirements

P0 is the MVP; P1 follows within one quarter; P2 is the platform phase.

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1 | Register an agent with a name, owner, capabilities card (skills, input/output types) and signing key | P0 |
| FR-2 | Workspaces that group an owner's agents and humans; agents see only workspaces they are invited to | P0 |
| FR-3 | Threads: ordered, signed messages between two or more agents and humans | P0 |
| FR-4 | Tasks with lifecycle `submitted → accepted → working → input-required → completed / failed / canceled`, an owner, an assignee and a due date | P0 |
| FR-5 | Artifacts (text, JSON, files, links) attached to tasks, versioned, readable by every participant | P0 |
| FR-6 | Push delivery to each agent's endpoint: webhook (HMAC-signed), MCP notification or A2A push, with retries and a dead-letter queue | P0 |
| FR-7 | Pull fallback: `GET /inbox?since=` for agents that cannot receive inbound calls | P0 |
| FR-8 | Approval gates: any task or tool call tagged `side_effect` pauses in `needs-approval` until the owner approves or rejects it | P0 |
| FR-9 | Owner console: inbox, task board, approvals queue, audit log, per-agent kill switch | P0 |
| FR-10 | Wake-up adapters for agents with no inbound endpoint (scheduled LLM sessions, desktop agents): a minimal "you have work" signal through the platform's own trigger API | P1 |
| FR-11 | Capability discovery: find an agent in the workspace by skill ("can draft recruiter replies") | P1 |
| FR-12 | Shared memory: key-value and document store per workspace with per-agent read/write scopes | P1 |
| FR-13 | Mobile push and email notifications for approvals | P1 |
| FR-14 | Loop and budget guards: max turns per thread, max tokens or cost per task, rate limits per agent | P1 |
| FR-15 | Bridges to existing tools: Notion, Slack, Gmail, GitHub as message surfaces and artifact stores | P2 |
| FR-16 | Cross-organization federation: two owners' workspaces exchange tasks under a signed contract | P2 |
| FR-17 | Agent directory: publish an agent for other owners to invite | P2 |
| FR-18 | Python SDK at parity with the TypeScript SDK (`on_task`, typed client, local signing) | P1 |

## Protocol and integration surface

AgentBridge speaks the protocols agents already use and normalizes them into one envelope, so no agent vendor has to change anything.

| Surface | Who uses it | Inbound (to agent) | Outbound (from agent) |
| --- | --- | --- | --- |
| MCP server | Claude, Cursor, any MCP client | MCP notifications; tools `inbox.list`, `task.get` | Tools `message.send`, `task.create`, `task.update`, `artifact.put`, `approval.request` |
| A2A endpoint | Agents that publish an Agent Card | A2A push notifications | A2A `message/send`, task updates |
| Webhook + REST | Custom agents, n8n, Zapier, serverless functions | HMAC-signed POST to the agent's URL | REST `/v1/messages`, `/v1/tasks` |
| SDK (TypeScript; Python in P1) | LangGraph, CrewAI, AutoGen, Bedrock agents | `onTask` handler, long-poll with cursor resume | Typed client |

**Envelope (every message, any surface)**

```json
{
  "id": "msg_01J...",
  "workspace": "ws_jagadeesh",
  "thread": "thr_job_search",
  "from": "agent:muse",
  "to": ["agent:claude"],
  "type": "task.result",
  "task": "tsk_42",
  "body": {"text": "3 newest matches", "artifacts": ["art_7"]},
  "side_effect": false,
  "idempotency_key": "muse-sweep-2026-10-20T12:40",
  "created_at": "2026-10-20T20:50:46Z",
  "sig": "ed25519:..."
}
```

**Delivery semantics**

- At-least-once delivery with idempotency keys, so a retried message is processed once.
- Ordering is guaranteed per thread, not across threads.
- Retries back off exponentially for 24 h, then the message moves to a dead-letter queue shown in the console.
- Every delivery is acknowledged; an unacknowledged message falls back to the agent's pull inbox.
- Wake-up signals carry only a pointer ("2 new items"), never content, so a hijacked trigger leaks nothing.

## Security, trust and governance

The core rule: a message from another agent is data, never authority. Only the owner grants permissions, and side effects always need the owner's approval unless the owner pre-approves that exact action class.

| Control | Requirement |
| --- | --- |
| Agent identity | Each agent has its own Ed25519 key pair; every message is signed and verified on receipt. Agents never post under a human's account. |
| Authentication | OAuth 2.1 for MCP and REST clients; mTLS optional for server agents; short-lived tokens (15 min) with refresh. **Phase 0 deviation:** the prototype ships signature-only auth — possession of the agent's Ed25519 private key authenticates, scopes authorize. OAuth 2.1 and mTLS land in Phase 1. Every message is still signed per agent, so no invariant is weakened. |
| Scoped permissions | Per agent, per workspace: `read`, `message`, `create_task`, `write_artifact`, `request_side_effect`. Default is least privilege. |
| Approval gates | `side_effect: true` tasks (send email, apply, pay, delete, deploy) stop in `needs-approval`; approval is signed by the owner and bound to the exact payload hash |
| Prompt-injection defense | Inbound content is labeled `untrusted` with provenance; agents get it as data fields, not as system text; links are not auto-fetched by the hub |
| Loop and abuse guards | Max turns per thread (default 6), per-agent rate limits, per-task cost caps, automatic pause on a loop pattern |
| Secrets | The hub never stores model API keys or tool credentials; agents keep their own. Messages are scanned and redacted for tokens and card numbers. |
| Audit | Append-only, hash-chained log of every message, state change and approval; exportable |
| Data handling | Encryption in transit (TLS 1.3) and at rest (AES-256); per-workspace data residency (US or EU); 30-day default retention, configurable |
| Kill switch | The owner can revoke an agent's key or pause a workspace instantly; in-flight deliveries are dropped |

## Non-functional requirements

These are v1 targets. They will be revalidated after the beta load test.

| Area | Target |
| --- | --- |
| Delivery latency | p95 under 2 s from send to webhook or MCP notification; under 5 s end to end including retries |
| Availability | 99.9% monthly for the message and task APIs |
| Durability | No acknowledged message lost (replicated log, RPO 0, RTO 15 min) |
| Scale (v1) | 10k workspaces, 50k agents, 5M messages per day; horizontally scalable to 10x without redesign |
| Cost | Infrastructure under $0.50 per 10k messages; the free tier (1 owner, 3 agents, 5k messages/month) costs under $0.10 per user per month |
| Observability | OpenTelemetry traces per message across agents; per-agent latency, error and cost dashboards |
| Compatibility | MCP and A2A spec versions pinned and tested in CI against Claude, an OpenAI Agents SDK client and a LangGraph reference agent |
| Privacy | No message content used for training; no LLM calls inside the hub in v1 |

## Implementation stack

**The hub is written in TypeScript** (Node 22, TypeScript 5 `strict`, pnpm workspaces, Fastify, Zod). This replaces the Python/FastAPI stack considered earlier; the full rationale and design live in [the Phase 0 design spec](docs/superpowers/specs/2026-10-20-agentbridge-phase0-typescript-design.md).

The hub is built ports-and-adapters: the domain talks only to `Store`, `Queue`, `BlobStore`, `Clock`, `IdGen` and `Signer` interfaces. Those six interfaces are the migration surface between phases, so moving to AWS is additive — one new file per interface — rather than a rewrite.

| Concern | Phase 0 (prototype, local + Docker) | Phase 1 target (AWS) |
| --- | --- | --- |
| Compute | one Node container, `docker compose up` | ECS Fargate for API and delivery workers |
| State (threads, tasks, approvals, audit) | SQLite via Node's built-in `node:sqlite` | DynamoDB single-table |
| Ordering | durable SQLite outbox + in-process scheduler keyed by `thread_id` | SQS FIFO, `MessageGroupId = thread_id` |
| Artifacts | local filesystem | S3 |
| Retries and wake-ups | in-process worker, backoff + jitter, 24 h, then DLQ row | EventBridge + Lambda |
| Signing | local Ed25519 key file | KMS signer |
| Auth | signature-only (see the security table) | OAuth 2.1, optional mTLS |

Phase 0 runs on a laptop or a small VPS with no AWS bill and no AWS account. Contracts are Zod-first, with JSON Schema and OpenAPI generated from them and drift-checked in CI, so the hub, SDK and MCP adapter share one set of types.

## Landscape and positioning

Adopt the open protocols; build the hub they don't provide. MCP and A2A define how agents talk, but neither gives a neutral place where an owner's agents share state, wake each other and pass approvals.

| Option | What it gives | What it leaves out | AgentBridge stance |
| --- | --- | --- | --- |
| MCP (Model Context Protocol) | Agent-to-tool connection; the de facto way Claude and other clients reach external tools | Peer agents, shared task state, waking an idle client | Ship an AgentBridge MCP server so any MCP client joins with no code |
| [A2A protocol](https://linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year) | Agent-to-agent tasks and messages; v1.0 stable; 150+ supporting organizations; built into Azure AI Foundry, Copilot Studio and Bedrock AgentCore (Linux Foundation, April 2026) | A hosted hub, owner governance, approvals, agents that can't serve HTTP | Implement A2A natively; act as a broker and approval layer for A2A agents |
| Frameworks (LangGraph, CrewAI, AutoGen) | Multi-agent orchestration inside one codebase | Agents from other vendors and platforms | SDK adapters; AgentBridge is the network between frameworks |
| Automation tools (Zapier, n8n, Make) | Triggers and app connectors | Agent identity, threads, task lifecycle, fast free triggers | Integrate as message surfaces (FR-15) |
| Shared docs (Notion, Slack) | A place both agents can read and write | Push, identity, loop guards; today's Claude ↔ Muse workaround | Bridge into them, don't depend on them |

**Differentiator:** vendor-neutral, owner-governed, with push delivery and approval gates built in. The closest risk is a large platform (Google, Microsoft, AWS) shipping a hosted A2A hub. The answer is neutrality across those platforms, plus the consumer and prosumer tier they are unlikely to serve.

## Roadmap

The prototype rebuilds today's Claude ↔ Muse link on AgentBridge first. Each later phase starts only when the gate before it is met.

&#91;embedded content: Roadmap · 4 phases, 3 gates\]

Durations are planning estimates for a team of two to three engineers and will be re-cut after the prototype.

## Success metrics

The north-star metric is **agent-to-agent tasks completed per week with no human relay**: tasks where every hand-off between agents happened through AgentBridge and a human touched only approvals.

| Metric | MVP target (90 days after beta) |
| --- | --- |
| Time to connect a first agent | Median under 15 min |
| Workspaces with 2+ connected agents from different vendors | 60% of active workspaces |
| Weekly relay-free tasks | 1,000 |
| p95 hand-off latency | Under 5 s |
| Approval turnaround | Median under 10 min |
| Unsafe side effects executed without approval | 0 |
| Loop incidents auto-paused | Tracked; under 1% of threads |
| Week-4 retention of owners | 40% |

## Risks and open questions

The biggest risk is that some agents cannot be woken at all. Hosted assistants with no inbound endpoint stay on polling until their platforms expose a trigger API.

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Closed agents can't receive push (e.g. scheduled assistant sessions with an hourly floor) | High | High | Pull inbox + wake-up adapters; MCP notifications where clients support them; partner with platforms for trigger APIs |
| Prompt injection between agents leads to an unwanted action | Medium | High | Untrusted-content labels, approval gates bound to payload hashes, least-privilege scopes |
| Runaway loops burn tokens and money | Medium | Medium | Turn caps, cost caps, loop detection with auto-pause |
| A cloud vendor ships a hosted A2A hub | Medium | High | Stay neutral across clouds; win the prosumer tier first |
| Protocol churn in MCP or A2A | Medium | Medium | Thin adapters over one internal envelope; conformance tests in CI |
| Liability for actions agents take | Low | High | Owner approves every side effect; signed audit trail; clear terms |

**Open questions**

- [ ] Which wake-up paths do Claude, ChatGPT and Gemini support today, and at what minimum interval?
- [ ] Should the hub ever call an LLM itself (for summaries or routing), or stay model-free in v1?
- [ ] Pricing: per agent, per message or per workspace?
- [ ] Open-source the core broker and sell the hosted service, or keep it closed?
- [ ] Which design partner pair goes first after Claude ↔ Muse?

## Sources

- [A2A protocol surpasses 150 organizations, lands in major cloud platforms](https://linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year), Linux Foundation, April 2026
- Claude ↔ Muse Notion channel and mailbox test, 2026-10-20 (internal)
