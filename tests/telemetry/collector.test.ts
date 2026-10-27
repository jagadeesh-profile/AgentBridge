import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestDescriptor, signDescriptor } from '@agentbridge/contracts';
import { flushTelemetry, initTelemetry, shutdownTelemetry } from '@agentbridge/hub';
import { startHarness, type Harness } from '../e2e/harness.js';

/**
 * Wire compatibility against the REAL OpenTelemetry Collector.
 *
 * `otlp.test.ts` proves the hub's behaviour — the caller's trace id survives,
 * no body reaches an attribute, `/healthz` is not traced — against a receiver
 * written here. That receiver accepts whatever the exporter sends, so it
 * cannot answer the one question it is not qualified to: does a real collector
 * accept this payload at all? A stub would happily take JSON that the
 * collector rejects as malformed, and the suite would stay green while nothing
 * worked in production.
 *
 * So this file sends to the real thing and asserts the export did not fail.
 * `forceFlush` rejects when the exporter gives up, and the OTLP exporter
 * treats a 4xx as non-retryable — so a payload the collector refuses makes
 * this fail rather than pass quietly. `scripts/test-otel-collector.mjs`
 * starts the container, runs this, and then greps the collector's own log for
 * the trace id, which is the independent confirmation that the span arrived
 * and was parsed rather than merely accepted.
 *
 * Skipped unless `OTEL_COLLECTOR_ENDPOINT` is set, so `make check` stays green
 * without Docker. The script refuses to run at all if the collector is absent,
 * which is what stops that skip becoming a false pass.
 */

const ENDPOINT = process.env.OTEL_COLLECTOR_ENDPOINT;
/** Supplied by the script so it can grep the collector log for the same id. */
const TRACE_ID = process.env.AB_TRACE_ID ?? 'cc'.repeat(16);

let h: Harness;

describe.skipIf(ENDPOINT === undefined)('OTLP export to a real collector', () => {
  beforeEach(async () => {
    initTelemetry({
      otlpEndpoint: `${ENDPOINT}/v1/traces`,
      serviceName: 'agentbridge-hub-collector-test',
    });
    h = await startHarness('ws_coll');
  });

  afterEach(async () => {
    await h.stop();
    await shutdownTelemetry();
  });

  it('exports a span the collector ACCEPTS, under the caller trace id', async () => {
    const key = await h.registerAgent('collectortracer');
    const body = JSON.stringify({
      thread: 'thr_coll',
      assignee: 'agent:muse',
      title: 'collector round trip',
      payload: { n: 1 },
      side_effect: false,
    });
    const timestamp = new Date().toISOString();
    const signature = await signDescriptor(
      requestDescriptor({ method: 'POST', path: '/v1/tasks', query: {}, body, timestamp }),
      key,
    );
    const res = await fetch(`${h.baseUrl}/v1/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': 'ws_coll',
        'x-agentbridge-agent': 'agent:collectortracer',
        'x-agentbridge-timestamp': timestamp,
        'x-agentbridge-signature': signature,
        'x-agentbridge-trace-id': TRACE_ID,
      },
      body,
    });
    expect(res.status).toBeLessThan(300);

    // The assertion: forceFlush resolving means the collector returned 2xx for
    // the payload this exporter produced. A rejected payload surfaces here.
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });
});

if (ENDPOINT === undefined) {
  describe('OTLP export to a real collector', () => {
    it.skip('SKIPPED: set OTEL_COLLECTOR_ENDPOINT, or run `make test-otel-collector`', () => {
      /* the title is the report */
    });
  });
}
