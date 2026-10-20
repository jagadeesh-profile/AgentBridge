import { createHmac } from 'node:crypto';
import type { AgentRecord, Clock, OutboxRow, Store } from '@agentbridge/hub/ports';
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

  const rawBody = JSON.stringify({
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
    const res = await doFetch(agent.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-timestamp': timestamp,
        // The secret itself never leaves the hub — only the HMAC does.
        'x-agentbridge-signature': signWebhook(agent.webhookSecret, timestamp, rawBody),
        'x-agentbridge-delivery': row.id,
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
