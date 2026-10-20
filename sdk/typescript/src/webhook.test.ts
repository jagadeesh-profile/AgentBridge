import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from './webhook.js';

const SECRET = 'shh';
const NOW = new Date('2026-10-20T12:00:00.000Z');

function headersFor(body: string, timestamp = NOW.toISOString(), secret = SECRET) {
  return {
    'x-agentbridge-timestamp': timestamp,
    'x-agentbridge-signature': createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex'),
  };
}

describe('verifyWebhook', () => {
  const body = '{"id":"ob_1"}';

  it('accepts a correctly signed body', () => {
    expect(verifyWebhook(SECRET, headersFor(body), body, { now: NOW })).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyWebhook(SECRET, headersFor(body), '{"id":"ob_2"}', { now: NOW })).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(
      verifyWebhook(SECRET, headersFor(body, NOW.toISOString(), 'wrong'), body, { now: NOW }),
    ).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(
      verifyWebhook(SECRET, { 'x-agentbridge-timestamp': NOW.toISOString() }, body, { now: NOW }),
    ).toBe(false);
  });

  it('rejects a missing timestamp header', () => {
    expect(verifyWebhook(SECRET, { 'x-agentbridge-signature': 'abc' }, body, { now: NOW })).toBe(
      false,
    );
  });

  it('accepts a timestamp 299 s old', () => {
    const ts = new Date(NOW.getTime() - 299_000).toISOString();
    expect(verifyWebhook(SECRET, headersFor(body, ts), body, { now: NOW })).toBe(true);
  });

  it('rejects a timestamp 301 s old, closing the replay window', () => {
    const ts = new Date(NOW.getTime() - 301_000).toISOString();
    expect(verifyWebhook(SECRET, headersFor(body, ts), body, { now: NOW })).toBe(false);
  });

  it('rejects an unparseable timestamp rather than treating it as epoch', () => {
    expect(verifyWebhook(SECRET, headersFor(body, 'not-a-date'), body, { now: NOW })).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(
      verifyWebhook(
        SECRET,
        { 'x-agentbridge-timestamp': NOW.toISOString(), 'x-agentbridge-signature': 'ab' },
        body,
        { now: NOW },
      ),
    ).toBe(false);
  });

  it('rejects a non-hex signature without throwing', () => {
    expect(
      verifyWebhook(
        SECRET,
        { 'x-agentbridge-timestamp': NOW.toISOString(), 'x-agentbridge-signature': 'z'.repeat(64) },
        body,
        { now: NOW },
      ),
    ).toBe(false);
  });
});
