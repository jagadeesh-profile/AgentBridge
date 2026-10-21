import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, Untrusted, verifyWebhook, type ClientOptions } from '@agentbridge/sdk';
import { museHandler } from '../handler.js';

export interface WebhookMuse {
  url: string;
  received: () => number;
  rejected: () => number;
  close: () => Promise<void>;
}

/**
 * Mode 2 of 3: Muse serves HTTP and the hub pushes to it.
 *
 * Verification is not optional. An unverified endpoint would accept any POST
 * claiming to be the hub, which is the whole reason the webhook is HMAC-signed.
 */
export async function startWebhookMuse(
  secret: string,
  clientOpts: ClientOptions,
): Promise<WebhookMuse> {
  const client = new Client(clientOpts);
  let received = 0;
  let rejected = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // The RAW bytes: the signature covers bytes, so a re-encode would not
      // reproduce it.
      const rawBody = Buffer.concat(chunks).toString('utf8');

      if (!verifyWebhook(secret, req.headers, rawBody)) {
        rejected += 1;
        res.writeHead(401).end();
        return;
      }

      // Ack immediately, then do the work: the hub's retry budget should not be
      // spent waiting for Muse's job sweep.
      res.writeHead(204).end();
      received += 1;

      void (async () => {
        try {
          const parsed = JSON.parse(rawBody) as {
            task?: string | null;
            body?: { provenance?: { from: string; sigVerified: boolean; receivedAt: string } };
          };
          if (typeof parsed.task !== 'string') return;

          const wire = parsed.body as { provenance?: never; value?: unknown } | undefined;
          const payload = new Untrusted(
            wire?.value,
            parsed.body?.provenance ?? {
              from: 'unknown',
              sigVerified: false,
              receivedAt: new Date(0).toISOString(),
            },
          );
          const result = museHandler(payload);

          await client.putArtifact({
            task: parsed.task,
            kind: result.artifact.kind,
            name: result.artifact.name,
            contentType: result.artifact.contentType,
            inline: result.artifact.inline,
          });
          await client.updateTask(parsed.task, 'accepted');
          await client.updateTask(parsed.task, 'working');
          await client.updateTask(parsed.task, 'completed');
        } catch {
          // The hub already has its 204; a failure here surfaces as a task that
          // never completes, which the owner sees on the board.
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    received: () => received,
    rejected: () => rejected,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
