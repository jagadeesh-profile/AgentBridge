import { describe, expect, it } from 'vitest';
import { redactOutbound } from './redact.js';

const text = (v: unknown): string => JSON.stringify(redactOutbound(v));

describe('redactOutbound', () => {
  it('redacts a Luhn-valid card number', () => {
    expect(text({ note: 'card 4242424242424242' })).toContain('[REDACTED]');
    expect(text({ note: 'card 4242424242424242' })).not.toContain('4242424242424242');
  });

  it('redacts a card number written with spaces', () => {
    expect(text({ note: '4242 4242 4242 4242' })).toContain('[REDACTED]');
  });

  it('leaves a Luhn-invalid 16-digit number alone', () => {
    expect(text({ id: '1234567812345678' })).not.toContain('[REDACTED]');
  });

  it('leaves an ordinary order number alone', () => {
    expect(text({ order: 'ORD-99812' })).not.toContain('[REDACTED]');
  });

  it('redacts token-shaped strings', () => {
    for (const token of [
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      'ghp_0123456789abcdefghijklmnopqrstuvwx',
      'xoxb-123456789012-abcdefghijkl',
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      expect(text({ t: token }), token).toContain('[REDACTED]');
      expect(text({ t: token }), token).not.toContain(token);
    }
  });

  it('redacts a PEM private key header', () => {
    expect(text({ k: '-----BEGIN RSA PRIVATE KEY-----\nabc' })).toContain('[REDACTED]');
  });

  it('walks nested objects and arrays', () => {
    expect(text({ a: [{ b: { c: 'sk-abcdefghijklmnopqrstuvwxyz012345' } }] })).toContain(
      '[REDACTED]',
    );
  });

  it('leaves ordinary prose untouched', () => {
    const value = { text: 'Three new roles at Acme, apply by Friday.' };
    expect(redactOutbound(value)).toEqual(value);
  });

  it('does not mutate the input', () => {
    const original = { t: 'sk-abcdefghijklmnopqrstuvwxyz012345' };
    redactOutbound(original);
    expect(original.t).toBe('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('redacts a bare string argument', () => {
    expect(redactOutbound('sk-abcdefghijklmnopqrstuvwxyz012345')).toBe('[REDACTED]');
  });

  it('does not recurse without bound on a deep object', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 20_000; i += 1) deep = { n: deep };
    expect(() => redactOutbound(deep)).not.toThrow();
  });

  it('passes through non-objects unchanged', () => {
    expect(redactOutbound(42)).toBe(42);
    expect(redactOutbound(null)).toBeNull();
    expect(redactOutbound(true)).toBe(true);
  });
});
