import { describe, expect, it } from 'vitest';
import { EnvelopeSchema } from './envelope.js';

const valid = {
  id: 'msg_01J000000000000000000000',
  workspace: 'ws_jagadeesh',
  thread: 'thr_job_search',
  from: 'agent:muse',
  to: ['agent:claude'],
  type: 'task.result',
  task: 'tsk_42',
  body: { text: '3 newest matches' },
  side_effect: false,
  idempotency_key: 'muse-sweep-2026-10-20T12:40',
  trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
  created_at: '2026-10-20T20:50:46Z',
  sig: 'ed25519:AAAA',
};

describe('EnvelopeSchema', () => {
  it('accepts a well-formed envelope', () => {
    expect(EnvelopeSchema.parse(valid)).toMatchObject({ from: 'agent:muse' });
  });

  it('rejects an agent ref without the agent: prefix', () => {
    expect(() => EnvelopeSchema.parse({ ...valid, from: 'muse' })).toThrow();
  });

  it('rejects an empty recipient list', () => {
    expect(() => EnvelopeSchema.parse({ ...valid, to: [] })).toThrow();
  });

  it('requires side_effect to be present, not merely falsy', () => {
    const { side_effect: _omitted, ...withoutFlag } = valid;
    expect(() => EnvelopeSchema.parse(withoutFlag)).toThrow();
  });

  it('rejects a signature that is not ed25519-prefixed', () => {
    expect(() => EnvelopeSchema.parse({ ...valid, sig: 'rsa:AAAA' })).toThrow();
  });

  it('strips unknown keys rather than trusting them', () => {
    const parsed = EnvelopeSchema.parse({ ...valid, injected: 'ignore me' });
    expect(parsed).not.toHaveProperty('injected');
  });
});
