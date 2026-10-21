import { Client, type ClientOptions } from '@agentbridge/sdk';
import { museHandler } from '../handler.js';

export interface PullMuse {
  drain: () => Promise<number>;
  handled: () => number;
}

/**
 * Mode 3 of 3: Muse has no inbound endpoint and reads the pull inbox.
 *
 * This is the mode a hosted assistant with an hourly scheduler floor uses — the
 * case that blocked Claude ↔ Muse on Notion in the first place. The hub never
 * claims an outbox row for a pull-only agent, so nothing burns retry budget
 * while Muse waits for its next window.
 */
export function startPullMuse(clientOpts: ClientOptions): PullMuse {
  const client = new Client(clientOpts);
  let handled = 0;
  let cursor: string | null = null;

  async function drain(): Promise<number> {
    let n = 0;
    for (;;) {
      const page = await client.listInbox(cursor === null ? {} : { since: cursor });
      if (page.items.length === 0) break;

      for (const item of page.items) {
        if (item.task !== null) {
          const result = museHandler(item.body);
          await client.putArtifact({
            task: item.task,
            kind: result.artifact.kind,
            name: result.artifact.name,
            contentType: result.artifact.contentType,
            inline: result.artifact.inline,
          });
          await client.updateTask(item.task, 'accepted');
          await client.updateTask(item.task, 'working');
          await client.updateTask(item.task, 'completed');
        }
        await client.ack(item.id);
        cursor = item.id;
        handled += 1;
        n += 1;
      }
    }
    return n;
  }

  return { drain, handled: () => handled };
}
