import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestDescriptor, signDescriptor } from '@agentbridge/contracts';
import { flushTelemetry, initTelemetry, shutdownTelemetry } from '@agentbridge/hub';
import { startHarness, type Harness } from '../e2e/harness.js';

/**
 * Spans actually leaving the hub over OTLP/HTTP.
 *
 * This closes the last of the "verified once by hand" claims: that spans reach
 * a collector carrying the caller's trace id, with no body-bearing attribute
 * and no span for `/healthz`. All three were true when observed, and nothing
 * in the repo reproduced them.
 *
 * It also covers a real gap rather than merely re-asserting the unit tests.
 * `initTelemetry` picks `SimpleSpanProcessor` when an exporter is injected and
 * `BatchSpanProcessor` when an `otlpEndpoint` is configured — so the 22
 * existing tests, which inject `InMemorySpanExporter`, exercise neither the
 * OTLP exporter nor the batch processor. Production uses both. Two of the
 * defects in `docs/TASKS.md` lived exactly there: a processor constructed with
 * a bare exporter (accepted, never stored, dies later on
 * `undefined.forceFlush`) and a span tied to a socket `close` event that never
 * fired. Neither was reachable from a test until this one.
 *
 * The receiver here is a plain HTTP server, not the OpenTelemetry Collector.
 * That is deliberate for this suite — it is deterministic, needs no Docker and
 * can assert on the exact payload. Whether a *real* collector accepts that
 * payload is a different question, and `make test-otel-collector` answers it
 * against the real image.
 */

/** OTLP/JSON, as the exporter emits it. */
interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  attributes?: { key: string; value: Record<string, unknown> }[];
}

interface Receiver {
  url: string;
  spans: () => OtlpSpan[];
  paths: () => string[];
  close: () => Promise<void>;
}

/** A stand-in collector that records what it is sent. */
async function startReceiver(): Promise<Receiver> {
  const received: OtlpSpan[] = [];
  const paths: string[] = [];

  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[];
        };
        for (const rs of body.resourceSpans ?? []) {
          for (const ss of rs.scopeSpans ?? []) {
            received.push(...(ss.spans ?? []));
          }
        }
      } catch {
        // Recorded as a path hit with no spans; a test asserting on spans will
        // fail and say so, which is better than swallowing a parse failure.
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    spans: () => [...received],
    paths: () => [...paths],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let receiver: Receiver;
let h: Harness;

beforeEach(async () => {
  receiver = await startReceiver();
  // Configure the real OTLP exporter against the receiver, BEFORE the hub is
  // built: `startSpan` is a no-op until a provider exists, so a hub created
  // first would record nothing and every assertion below would be vacuous.
  initTelemetry({
    otlpEndpoint: `${receiver.url}/v1/traces`,
    serviceName: 'agentbridge-hub-test',
  });
  h = await startHarness('ws_otel');
});

afterEach(async () => {
  await h.stop();
  await shutdownTelemetry();
  await receiver.close();
});

const SECRET = 'launch-code-8831-do-not-log';

/**
 * Creates a task over raw signed HTTP, so the inbound trace id can be set.
 *
 * Not via the SDK: `Client` does not send `x-agentbridge-trace-id`, which is
 * the only thing the hub reads a caller's trace id from. That is a genuine gap
 * — an SDK-using agent cannot join its trace to the hub's — but it is the
 * SDK's gap, not the exporter's, and this suite is about what leaves the hub.
 */
async function createTaskSigned(
  key: Uint8Array,
  agentRef: string,
  traceId?: string,
): Promise<number> {
  const body = JSON.stringify({
    thread: 'thr_otel',
    assignee: 'agent:muse',
    title: 'traced task',
    payload: { secret: SECRET },
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
      'x-agentbridge-workspace': 'ws_otel',
      'x-agentbridge-agent': agentRef,
      'x-agentbridge-timestamp': timestamp,
      'x-agentbridge-signature': signature,
      ...(traceId === undefined ? {} : { 'x-agentbridge-trace-id': traceId }),
    },
    body,
  });
  return res.status;
}

/** Exercises one authenticated request and waits for the batch to be sent. */
async function requestAndFlush(traceId?: string): Promise<void> {
  const key = await h.registerAgent('tracer');
  const status = await createTaskSigned(key, 'agent:tracer', traceId);
  // Assert the request actually succeeded: a 401 would still produce a span,
  // and every assertion below would then be testing the wrong request.
  expect(status).toBeLessThan(300);
  await flushTelemetry();
  // forceFlush resolves when the exporter's send resolves; the receiver has
  // still to run its 'end' handler, so yield once rather than assume.
  await new Promise((r) => setTimeout(r, 50));
}

describe('OTLP export — the collector claim, reproducible', () => {
  it('delivers spans to the configured /v1/traces endpoint', async () => {
    await requestAndFlush();
    expect(receiver.paths()).toContain('/v1/traces');
    expect(receiver.spans().length).toBeGreaterThan(0);
  });

  it('adopts the CALLER trace id as the real OTel trace id', async () => {
    // The point of §8: one trace spans both agents. A hub that minted its own
    // id would still export spans, so this is the assertion that matters.
    const callerTrace = 'ab'.repeat(16);
    await requestAndFlush(callerTrace);

    const ids = new Set(receiver.spans().map((s) => s.traceId));
    expect(ids).toContain(callerTrace);
  });

  it('does NOT use the all-zero trace id', async () => {
    // A rejected or absent parent must produce a fresh id, not the invalid
    // all-zero one, which collectors drop silently.
    await requestAndFlush();
    for (const span of receiver.spans()) {
      expect(span.traceId).not.toBe('0'.repeat(32));
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('exports NO attribute carrying a message body', async () => {
    // This is the one case that is NOT a restatement of the allowlist unit
    // tests, and establishing that took four attempts to make it fail.
    //
    // Three separate things stop a body reaching a span through the helpers:
    // the request span starts in `onRequest`, before the body is even parsed;
    // `endSpan` takes a closed typed object and forwards only four named
    // fields; and `spanAttributes` filters by allowlist. Adding a body-bearing
    // attribute at any of those points is simply dropped.
    //
    // What none of them stop is a direct `span.setAttributes(...)` on the raw
    // OTel span — it bypasses the helper, the closed type and the allowlist
    // together. Mutating the hub to do exactly that is what finally failed
    // this case, which is precisely why the assertion belongs on the wire
    // rather than on `spanAttributes`.
    await requestAndFlush();
    const serialized = JSON.stringify(receiver.spans());
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('8831');
  });

  it('emits no span for /healthz', async () => {
    // Liveness probes would otherwise dominate the trace volume and cost.
    await fetch(`${h.baseUrl}/healthz`);
    await requestAndFlush();
    for (const span of receiver.spans()) {
      expect(span.name).not.toContain('healthz');
    }
  });

  it('names the span by method and route, not by the full URL', async () => {
    // A URL would put ids in the span name, which makes a trace unaggregatable
    // and can leak a task id into a third-party backend.
    await requestAndFlush();
    const names = receiver.spans().map((s) => s.name);
    expect(names.some((n) => n.startsWith('hub POST /v1/tasks'))).toBe(true);
    expect(names.some((n) => n.includes('?'))).toBe(false);
  });

  it('serves requests normally while the collector is down', async () => {
    // A tracing backend is not a dependency of correctness. If the exporter
    // can take the hub's requests down with it, that is worse than no tracing.
    const key = await h.registerAgent('downtracer');
    await receiver.close();
    await expect(createTaskSigned(key, 'agent:downtracer')).resolves.toBeLessThan(300);
  });

  it('SHUTS DOWN cleanly and promptly when the collector is down', async () => {
    // The defect this suite found. `provider.shutdown()` flushes, so an
    // unreachable collector made it reject after ~8s of exporter retries. The
    // composition root awaited that between `app.close()` and `store.close()`,
    // under a signal handler that discards the promise — so the rejection was
    // unhandled, the database was never closed, and the orchestrator ended up
    // sending SIGKILL. Every deploy, caused by a down tracing backend.
    const key = await h.registerAgent('shutdowntracer');
    await createTaskSigned(key, 'agent:shutdowntracer');
    await receiver.close();

    const started = Date.now();
    const result = await shutdownTelemetry(500);
    const elapsed = Date.now() - started;

    // Reports the failure rather than throwing it…
    expect(result.flushed).toBe(false);
    expect(result.reason).toMatch(/timed out/);
    // …and does not sit there retrying while the orchestrator's clock runs.
    expect(elapsed).toBeLessThan(3_000);
  });

  it('reports a successful flush when the collector is up', async () => {
    // The complement: `flushed: false` must mean something, so the happy path
    // has to report true. Otherwise the warning in the composition root would
    // fire on every clean shutdown and be ignored within a week.
    await requestAndFlush();
    const result = await shutdownTelemetry();
    expect(result.flushed).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
