# Claude ↔ Muse pilot

The Phase 0 exit gate: Claude asks Muse for job matches, Muse answers, and
sending the follow-up email waits for your approval. No human relays a message.

## The point of this example

`src/handler.ts` is Muse's entire job. The three files in `src/modes/` differ
only in **how work arrives**:

| Mode | For a Muse that | File |
|---|---|---|
| SDK handler | can run a process | `modes/sdk.ts` |
| Raw webhook | serves HTTP | `modes/webhook.ts` |
| Pull inbox | has no inbound endpoint | `modes/pull.ts` |

Swapping the real Muse between them touches one file and never the handler.
That is what keeps "we don't know yet how Muse connects" from being an
architectural decision you have to make up front.

## Run it

```bash
agentbridge keygen --out owner.key          # prints the owner public key
export AGENTBRIDGE_OWNER_PUBLIC_KEY=<that value>
export AGENTBRIDGE_WORKSPACE=ws_pilot
pnpm run dev                                # hub on :8080, in Docker
```

In another shell:

```bash
agentbridge keygen --out claude.key
agentbridge keygen --out muse.key
agentbridge register --name claude --key claude.key --owner-key owner.key \
  --scopes read,message,create_task,request_side_effect
agentbridge register --name muse   --key muse.key   --owner-key owner.key \
  --scopes read,message,write_artifact
bash examples/claude-muse/scripts/pilot.sh
```

## What the pilot proves

1. Claude creates a task for Muse. The hub delivers it in seconds — no hourly
   scheduler floor.
2. Muse completes it and attaches `matches.json` as a versioned artifact.
3. Claude is notified and reads the result.
4. Claude requests a **side effect** (emailing the recruiter). It stops in
   `needs-approval` and **Muse never sees it**.
5. You approve with `agentbridge approve`. Only then does Muse get the work.
6. The audit chain verifies across the whole exchange.

Step 4 is the one worth watching: the test asserts Muse's handler is never
invoked for a gated task, and throws if it ever is. The gate is checked from the
assignee's side, not just the hub's.

## The 7-day gate

`scripts/pilot.sh` runs the full sequence unattended, so the exit gate can be a
cron job rather than something you remember to do:

```bash
*/30 * * * * cd /path/to/AgentBridge && bash examples/claude-muse/scripts/pilot.sh >> pilot.log 2>&1
```

Any non-zero exit means the link broke and the 7-day clock restarts.
