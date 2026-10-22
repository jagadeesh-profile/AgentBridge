import { createHmac } from 'node:crypto';
import type { AgentRecord, Clock, OutboxRow, Store } from '@agentbridge/hub/ports';
import { toA2AState } from '@agentbridge/a2a';
import { redactOutbound } from './redact.js';

export type PushOutcome = 'acked' | 'retry' | 'dead';

export interface PushDeps {
  store: Store;
  clock: Clock;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Delivers one outbox row to its agent's webhook.
 *
 * Outcomes: 2xx is the ack; 410 Gone is permanent (the endpoint says it will
 * never accept again); everything else — 4xx, 5xx, network error, timeout — is
 * retryable, because a 404 is as likely to be a deploy in progress as a real
 * absence.
 */
export async function pushOnce(deps: PushDeps, row: OutboxRow): Promise<PushOutcome> {
  const agent = deps.store.getAgent(row.workspace, row.recipient);
  if (!agent?.webhookUrl || !agent.webhookSecret) return 'dead';
  if (agent.keyStatus === 'revoked') return 'dead';

  const message = deps.store.getMessage(row.workspace, row.messageId);
  if (!message) return 'dead';

  // A2A push (ADR 0007): if the recipient configured push for this task, the
  // notification goes to their configured URL in A2A shape instead. Reusing
  // this function rather than adding a second sender means retries, backoff,
  // the dead-letter queue, redaction and HMAC signing all apply unchanged —
  // a parallel path would have had to re-earn each of those.
  const push = message.task === null ? null : deps.store.getPushConfig(row.workspace, message.task);
  const a2a = push !== null && push.agentRef === row.recipient ? push : null;

  const rawBody = a2a
    ? JSON.stringify(a2aNotification(deps, row, message))
    : JSON.stringify({
        id: row.id,
        thread: row.thread,
        type: message.type,
        task: message.task,
        // Content leaving the hub is redacted (CLAUDE.md §1.6) and wrapped
        // untrusted (§1.1) on the push path exactly as on the pull path.
        body: {
          untrusted: true,
          provenance: { from: message.from, sigVerified: true, receivedAt: message.createdAt },
          value: redactOutbound(message.body),
        },
        created_at: message.createdAt,
      });

  const timestamp = deps.clock.now().toISOString();
  const doFetch = deps.fetch ?? fetch;

  try {
    const res = await doFetch(a2a ? a2a.url : agent.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-timestamp': timestamp,
        // The secret itself never leaves the hub — only the HMAC does. A2A
        // notifications are signed too: the destination is the agent's own
        // origin, so it already holds the secret to verify with.
        'x-agentbridge-signature': signWebhook(agent.webhookSecret, timestamp, rawBody),
        'x-agentbridge-delivery': row.id,
        ...(a2a?.token ? { 'x-a2a-notification-token': a2a.token } : {}),
      },
      body: rawBody,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });

    if (res.status >= 200 && res.status < 300) return 'acked';
    if (res.status === 410) return 'dead';
    return 'retry';
  } catch {
    // Timeout or transport failure: retry rather than hang or crash the worker.
    return 'retry';
  }
}

export function webhookTargetOf(agent: AgentRecord): string | null {
  return agent.webhookUrl;
}

/**
 * The A2A Task shape, for a push notification.
 *
 * Carries no payload: a state change is the notification, and the caller
 * fetches detail with `tasks/get` over an authenticated channel. Shipping the
 * payload here would put it on a second wire for no gain.
 */
function a2aNotification(
  deps: PushDeps,
  row: OutboxRow,
  message: { task: string | null; createdAt: string },
): unknown {
  const task = message.task === null ? null : deps.store.getTask(row.workspace, message.task);
  return {
    id: message.task,
    contextId: row.thread,
    kind: 'task',
    status: {
      state: task ? toA2AState(task.state) : 'unknown',
      timestamp: task?.updatedAt ?? message.createdAt,
    },
    metadata: {
      'agentbridge/state': task?.state ?? 'unknown',
      'agentbridge/delivery': row.id,
    },
  };
}
