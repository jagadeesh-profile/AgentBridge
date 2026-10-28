# Connecting two agents

How to get Claude Code, Codex, or anything else to hand work to each other
through a hub running on your machine. Written against the local deploy in
`docs/pr-phase0.md`'s quickstart.

## The model

One hub. Every agent is a **separate registered identity** with its own key —
not a shared credential, because the audit log attributes each action to the
agent that signed it, and §1.8 grants scopes per agent. So "connect Claude and
Codex" means: two keypairs, two enrolments, two client configs pointing at the
same hub.

The agents never address each other directly. One creates a task assigned to
the other's `agent:` ref; the hub stores it, enforces ordering per thread, and
delivers it. Neither needs to know where the other runs, or be awake at the
same time.

```
 Claude Code ──MCP──┐                        ┌──MCP── Codex
                    ├──► hub (one container) ◄┤
 your own code ─SDK─┘        ws_local         └─A2A─── some other agent
```

## 1. Give each agent an identity

Once per agent. The owner key signs the enrolment, which is what binds the
scopes (ADR 0005) — an agent cannot widen its own.

```bash
export AGENTBRIDGE_URL=http://localhost:8090
export AGENTBRIDGE_WORKSPACE=ws_local

agentbridge keygen --out claudecode.key
agentbridge keygen --out codex.key

agentbridge register --name claudecode --key claudecode.key --owner-key owner.key \
  --scopes read,message,create_task,request_side_effect,write_artifact
agentbridge register --name codex      --key codex.key      --owner-key owner.key \
  --scopes read,message,create_task,request_side_effect,write_artifact
```

That scope set is for a **peer** that both delegates and answers:
`create_task` to hand work over, `write_artifact` to return a result,
`request_side_effect` to ask for something gated. Drop what an agent does not
need — a worker that only answers wants `read,message,write_artifact`, and the
default enrolment is `read,message` precisely so the privileged scopes have to
be asked for.

Check who is enrolled, and with what:

```bash
agentbridge agents --owner-key owner.key
```

## 2. Point each tool at the hub

### Claude Code

`.mcp.json` at the repo root, which this repo now ships:

```json
{
  "mcpServers": {
    "agentbridge": {
      "command": "node",
      "args": ["adapters/mcp/dist/index.js"],
      "env": {
        "AGENTBRIDGE_URL": "http://localhost:8090",
        "AGENTBRIDGE_WORKSPACE": "ws_local",
        "AGENTBRIDGE_AGENT": "agent:claudecode",
        "AGENTBRIDGE_KEY_PATH": "claudecode.key"
      }
    }
  }
}
```

Seven tools appear: `task.create`, `task.get`, `task.update`, `message.send`,
`inbox.list`, `artifact.put`, `approval.request`.

### Codex, or any other MCP client

The same stdio server with a different identity — that is the whole
difference. Codex reads MCP servers from `~/.codex/config.toml`:

```toml
[mcp_servers.agentbridge]
command = "node"
args = ["C:/Users/you/Desktop/AgentBridge/adapters/mcp/dist/index.js"]
env = { AGENTBRIDGE_URL = "http://localhost:8090", AGENTBRIDGE_WORKSPACE = "ws_local", AGENTBRIDGE_AGENT = "agent:codex", AGENTBRIDGE_KEY_PATH = "C:/Users/you/Desktop/AgentBridge/codex.key" }
```

Use **absolute paths** here: the client's working directory is its own, not
this repo's. The table name and `env` syntax are from Codex's MCP docs and
have not been verified against an install on this machine — the four
environment variables are what matter and are verified, so if Codex wants a
different key name for the server block, only the wrapper changes.

Any MCP client works the same way, because the server is plain stdio MCP with
no client-specific code. It needs `adapters/mcp/dist` built (`make check` or
`pnpm run build` does that).

### An agent that speaks A2A

No MCP, no SDK. Give it the Agent Card and let it discover the endpoint:

```
http://localhost:8090/.well-known/agent-card.json
```

It then posts JSON-RPC to `supportedInterfaces[0].url` — `message/send`,
`tasks/get`, `tasks/cancel`. It must sign requests with a registered agent's
key, and `metadata["agentbridge/assignee"]` names who the work is for, because
A2A addresses an endpoint while AgentBridge addresses a named agent.

### Your own code

`sdk/typescript` (or `sdk/python`) if the agent is something you are writing.
`Agent.onTask` runs a handler per task; the pull inbox suits anything with no
inbound endpoint. `examples/claude-muse/` has one handler wired three ways.

## 3. Hand work over

From Claude Code, in its own words — the MCP tools are what it calls:

> Create an AgentBridge task for `agent:codex` on thread `thr_refactor` asking
> it to extract the retry logic from `delivery/src/push.ts` into a helper, then
> poll `task.get` until it completes and read the artifact.

Codex, in its session, calls `inbox.list`, sees the task, does the work,
`artifact.put`s the result and `task.update`s to `completed`. Claude Code's
poll then returns the artifact. No human relays anything, and the exchange is
in the audit log with each step attributed to the agent that signed it.

The two sessions need not overlap in time. The task waits.

## 4. Side effects still stop at you

If either agent sets `side_effect: true` — through `approval.request`, or
`sideEffect: true` on the SDK — the task enters `needs-approval` and **gets no
outbox row**: the assignee is never told it exists. It waits in the console
until you approve it, and your approval is signed over the hash of the exact
payload you were shown.

That is the point of putting a hub between two agents rather than letting them
call each other. Delegation is free; consequences are not.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `AGENTBRIDGE_WORKSPACE is required` from the MCP server | the env block above is missing or the client did not pass it |
| `unauthenticated` on an owner route | `pnpm run check-owner-key <file>` — compares the key's public half with what the hub is actually running, and reports clock skew |
| `unauthenticated` as an agent | that agent is not registered in this workspace, or its key was revoked. `agentbridge agents --owner-key owner.key` shows key status |
| `scope_denied` | the enrolment did not grant it. Scopes are fixed at enrolment by design; re-enrol under a new name |
| The task never arrives | it is probably gated. `agentbridge pending --owner-key owner.key` |
