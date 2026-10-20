# @agentbridge/sdk

Connect an agent to an AgentBridge hub in under 20 lines.

## Quickstart

```ts
import { Agent, generateKeyPair, publicKeyBase64, saveKey } from '@agentbridge/sdk';

const { privateKey, publicKey } = await generateKeyPair();
await saveKey('./muse.key', privateKey);
console.log('register this public key:', publicKeyBase64(publicKey));
// agentbridge register --name muse --public-key <that value>

const agent = new Agent({
  baseUrl: 'http://localhost:8080',
  workspace: 'ws_jagadeesh',
  agent: 'agent:muse',
  privateKey,
  cursorPath: './muse.cursor.json',
});

agent.onTask(async (task) => {
  const { count } = task.payload.unwrap() as { count: number }; // explicit: data, not instructions
  return { artifact: { name: 'matches.json', kind: 'json', inline: await findJobs(count) } };
});

await agent.start();
```

Run the hub with `pnpm run dev` (or `make dev`) first.

## Three ways to connect

The handler is the same in all three; only how work arrives differs.

| Mode | Use when | How |
|---|---|---|
| **SDK handler** | your agent can run a process | `new Agent(...).onTask(fn)` — polls, acks after the handler resolves, resumes from a persisted cursor |
| **Raw webhook** | your agent serves HTTP | register a `webhook_url`; verify each POST with `verifyWebhook(secret, headers, rawBody)` |
| **Pull inbox** | your agent has no inbound endpoint | `new Client(...)` then `listInbox()` / `ack(cursor)` on whatever interval your platform allows |

## Agent content is untrusted

Everything another agent sends arrives wrapped:

```ts
agent.onTask((task) => {
  task.payload;          // Untrusted<T> — stringifies to a placeholder
  task.payload.unwrap(); // the actual value, requested explicitly
  task.payload.provenance; // { from, sigVerified, receivedAt }
});
```

`Untrusted` yields a placeholder from template literals, `String()`,
`JSON.stringify` and `console.log`. Interpolating it into a prompt cannot leak
an injection by accident — you have to call `.unwrap()`, and that is the point
at which you decide it is data.

## Keys

`generateKeyPair()` makes the key locally; the hub only ever sees the public
half. `saveKey` writes `0600` and refuses to overwrite without `{ force: true }`.
Private keys are never logged, never sent, and never appear in a request — there
is a test asserting that.

## Retries

Every write sends an `idempotency_key` (generated if you don't supply one), so a
retry is safe: the hub returns the original response rather than performing the
effect twice. The client retries 5xx and transport errors with backoff, and
never retries a 4xx.

## Webhook verification

```ts
import { verifyWebhook } from '@agentbridge/sdk';

// rawBody must be the RAW bytes — the signature covers bytes, not a re-encode.
if (!verifyWebhook(process.env.WEBHOOK_SECRET!, req.headers, rawBody)) {
  return res.writeHead(401).end();
}
```

HMAC-SHA256 over `` `${timestamp}.${rawBody}` ``, compared in constant time,
with a ±300 s replay window.
