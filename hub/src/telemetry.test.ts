import { describe, expect, it } from 'vitest';
import {
  SPAN_ATTRIBUTE_ALLOWLIST,
  isTraceId,
  newTraceId,
  resolveTraceId,
  spanAttributes,
} from './telemetry.js';

describe('trace ids', () => {
  it('generates a 32-hex trace id', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates a different id each time', () => {
    expect(newTraceId()).not.toBe(newTraceId());
  });

  it('adopts a well-formed inbound id so one trace spans both agents', () => {
    const inbound = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(resolveTraceId(inbound)).toEqual({ traceId: inbound, rejected: false });
  });

  it('mints a fresh id when none is supplied', () => {
    const { traceId, rejected } = resolveTraceId(undefined);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(rejected).toBe(false);
  });

  it('REJECTS a malformed inbound id rather than storing it', () => {
    for (const bad of ['nope', 'ZZZ', '4bf9', 'A'.repeat(32), '../etc/passwd', 123, {}]) {
      const { traceId, rejected } = resolveTraceId(bad);
      expect(rejected, String(bad)).toBe(true);
      // A fresh valid id is used instead, so the field cannot carry free text.
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('rejects an uppercase id, keeping the stored form canonical', () => {
    expect(isTraceId('4BF92F3577B34DA6A3CE929D0E0E4736')).toBe(false);
  });
});

describe('span attributes', () => {
  it('keeps only the allowlisted identifiers', () => {
    const out = spanAttributes({
      workspace: 'ws',
      agent: 'agent:muse',
      task_id: 'tsk_1',
      body: { secret: 'do not export me' },
      payload: { secret: 'nor me' },
      value: 'nor me either',
      inline: 'nope',
    });
    expect(out).toEqual({ workspace: 'ws', agent: 'agent:muse', task_id: 'tsk_1' });
  });

  it('never includes a body-bearing key', () => {
    for (const forbidden of ['body', 'value', 'payload', 'inline']) {
      expect(SPAN_ATTRIBUTE_ALLOWLIST as readonly string[]).not.toContain(forbidden);
    }
  });

  it('drops empty and non-string values', () => {
    expect(spanAttributes({ workspace: '', agent: 42, task_id: null })).toEqual({});
  });
});
