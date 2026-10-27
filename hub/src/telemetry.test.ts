import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import {
  SPAN_ATTRIBUTE_ALLOWLIST,
  flushTelemetry,
  initTelemetry,
  isTraceId,
  newTraceId,
  resolveTraceId,
  shutdownTelemetry,
  spanAttributes,
  startSpan,
  endSpan,
  withSpan,
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
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('rejects an all-zero id, which W3C defines as invalid', () => {
    expect(isTraceId('0'.repeat(32))).toBe(false);
    expect(resolveTraceId('0'.repeat(32)).rejected).toBe(true);
  });

  it('rejects an uppercase id, keeping the stored form canonical', () => {
    expect(isTraceId('4BF92F3577B34DA6A3CE929D0E0E4736')).toBe(false);
  });
});

describe('span attributes', () => {
  it('keeps only the allowlisted identifiers', () => {
    expect(
      spanAttributes({
        workspace: 'ws',
        agent: 'agent:muse',
        task_id: 'tsk_1',
        body: { secret: 'do not export me' },
        payload: { secret: 'nor me' },
        value: 'nor me either',
        inline: 'nope',
      }),
    ).toEqual({ workspace: 'ws', agent: 'agent:muse', task_id: 'tsk_1' });
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

describe('the exporter', () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('is a no-op when no endpoint is configured, and does not throw', async () => {
    const t = initTelemetry({ serviceName: 'test' });
    expect(t.enabled).toBe(false);
    // Spans still run their body; they are simply not recorded anywhere.
    const out = await withSpan('noop.span', { workspace: 'ws' }, async () => 'ran');
    expect(out).toBe('ran');
  });

  it('records a span when an exporter is supplied', async () => {
    const exporter = new InMemorySpanExporter();
    initTelemetry({ serviceName: 'test', exporter });

    await withSpan('hub.request', { workspace: 'ws', agent: 'agent:muse' }, async () => 'ok');
    await flushTelemetry();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('hub.request');
    expect(spans[0]?.attributes).toMatchObject({ workspace: 'ws', agent: 'agent:muse' });
  });

  // The whole reason trace_id lives in the envelope (spec §8): the hub's span
  // must join the CALLER's trace, not start a disconnected one.
  it('uses the supplied trace id as the real OTel trace id', async () => {
    const exporter = new InMemorySpanExporter();
    initTelemetry({ serviceName: 'test', exporter });

    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    await withSpan('hub.request', { workspace: 'ws' }, async () => 'ok', { traceId });
    await flushTelemetry();

    expect(exporter.getFinishedSpans()[0]?.spanContext().traceId).toBe(traceId);
  });

  it('gives two spans in one trace the same trace id and different span ids', async () => {
    const exporter = new InMemorySpanExporter();
    initTelemetry({ serviceName: 'test', exporter });

    const traceId = 'aaaaaaaabbbbbbbbccccccccdddddddd';
    await withSpan('one', {}, async () => undefined, { traceId });
    await withSpan('two', {}, async () => undefined, { traceId });
    await flushTelemetry();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.spanContext().traceId)).toEqual([traceId, traceId]);
    const ids = spans.map((s) => s.spanContext().spanId);
    expect(new Set(ids).size).toBe(2);
  });

  it('never records a body, even when one is passed in the attribute bag', async () => {
    const exporter = new InMemorySpanExporter();
    initTelemetry({ serviceName: 'test', exporter });

    await withSpan(
      'hub.request',
      { workspace: 'ws', body: { canary: 'MUST-NOT-BE-EXPORTED' } } as Record<string, unknown>,
      async () => undefined,
    );
    await flushTelemetry();

    const serialized = JSON.stringify(exporter.getFinishedSpans()[0]?.attributes);
    expect(serialized).not.toContain('MUST-NOT-BE-EXPORTED');
    expect(serialized).not.toContain('body');
  });

  it('marks a span as errored when the body throws, and rethrows', async () => {
    const exporter = new InMemorySpanExporter();
    initTelemetry({ serviceName: 'test', exporter });

    await expect(
      withSpan('hub.request', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await flushTelemetry();

    const span = exporter.getFinishedSpans()[0];
    // ERROR is 2 in the OTel status enum.
    expect(span?.status.code).toBe(2);
    // The message is recorded, but it must not carry a body.
    expect(span?.status.message).toContain('boom');
  });

  it('shutdown disposes the exporter, so callers must flush before reading', async () => {
    const exporter = new InMemorySpanExporter();
    initTelemetry({ serviceName: 'test', exporter });
    await withSpan('gone.after.shutdown', {}, async () => undefined);
    await flushTelemetry();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    await shutdownTelemetry();
    // Not a bug — InMemorySpanExporter clears on shutdown. Recorded because it
    // looks exactly like "spans were never created".
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('shutdown is idempotent, and reports a flush both times', async () => {
    // `shutdownTelemetry` returns `{ flushed, reason? }` rather than void, so
    // the composition root can log dropped spans instead of being unable to
    // tell. A second call has no provider to flush, which counts as flushed:
    // reporting failure there would warn on every clean double-shutdown.
    initTelemetry({ serviceName: 'test', exporter: new InMemorySpanExporter() });
    await expect(shutdownTelemetry()).resolves.toEqual({ flushed: true });
    await expect(shutdownTelemetry()).resolves.toEqual({ flushed: true });
  });

  it('reports enabled when an OTLP endpoint is configured', () => {
    const t = initTelemetry({
      serviceName: 'test',
      otlpEndpoint: 'http://127.0.0.1:4318/v1/traces',
    });
    expect(t.enabled).toBe(true);
  });
});

describe('endSpan outcome attributes', () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('records the status code, agent and workspace on the closed span', async () => {
    const exporter = new InMemorySpanExporter();
    initTelemetry({ serviceName: 'test', exporter });

    const span = startSpan('hub GET /v1/inbox', { 'http.method': 'GET' });
    endSpan(span, { statusCode: 200, agent: 'agent:muse', workspace: 'ws' });
    await flushTelemetry();

    expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
      'http.method': 'GET',
      'http.status_code': 200,
      agent: 'agent:muse',
      workspace: 'ws',
    });
  });

  it('marks 5xx as an error but leaves 4xx OK', async () => {
    const exporter = new InMemorySpanExporter();
    initTelemetry({ serviceName: 'test', exporter });

    endSpan(startSpan('server', {}), { statusCode: 500 });
    endSpan(startSpan('client', {}), { statusCode: 404 });
    await flushTelemetry();

    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s.status.code]));
    // A caller's own 404 must not light up an error dashboard.
    expect(byName.get('server')).toBe(2);
    expect(byName.get('client')).toBe(1);
  });

  it('is a no-op on a null span, so callers need not branch on config', () => {
    expect(() => endSpan(null, { statusCode: 200 })).not.toThrow();
  });
});
