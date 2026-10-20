import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_WINDOW_MS = 300_000;

/**
 * Verifies an inbound AgentBridge webhook. Must stay byte-compatible with
 * delivery/src/push.ts: HMAC-SHA256 hex over `${timestamp}.${rawBody}`.
 *
 * Pass the RAW request body, not a re-serialized object — re-encoding changes
 * bytes and the signature covers bytes.
 */
export function verifyWebhook(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  opts: { now?: Date; windowMs?: number } = {},
): boolean {
  const signature = headerValue(headers, 'x-agentbridge-signature');
  const timestamp = headerValue(headers, 'x-agentbridge-timestamp');
  if (signature === undefined || timestamp === undefined) return false;

  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return false;
  const now = (opts.now ?? new Date()).getTime();
  if (Math.abs(now - parsed) > (opts.windowMs ?? WEBHOOK_WINDOW_MS)) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  let got: Buffer;
  try {
    got = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, so check first: an attacker
  // must not be able to turn a short signature into an exception.
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
