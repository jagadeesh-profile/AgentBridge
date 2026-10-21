import { randomBytes } from 'node:crypto';
import {
  SpanStatusCode,
  TraceFlags,
  context as otelContext,
  trace,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  TracerProvider,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const ALL_ZERO_TRACE_ID = '0'.repeat(32);

/** W3C-shaped trace id: 16 random bytes, lowercase hex. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function isTraceId(value: unknown): value is string {
  if (typeof value !== 'string' || !TRACE_ID_PATTERN.test(value)) return false;
  // W3C defines the all-zero id as invalid, and OTel will refuse to use it as a
  // parent — so accepting it would silently detach the span from its trace.
  return value !== ALL_ZERO_TRACE_ID;
}

/**
 * Resolves the trace id for a request.
 *
 * An inbound id is adopted so one trace spans both agents (spec §8) — that is
 * the whole point of carrying it in the envelope rather than minting a fresh id
 * per hop. A malformed id is rejected rather than stored, so the field cannot
 * become a free-text smuggling channel.
 */
export function resolveTraceId(inbound: unknown): { traceId: string; rejected: boolean } {
  if (inbound === undefined || inbound === null || inbound === '') {
    return { traceId: newTraceId(), rejected: false };
  }
  if (isTraceId(inbound)) return { traceId: inbound, rejected: false };
  return { traceId: newTraceId(), rejected: true };
}

/**
 * Span attributes permitted on hub spans. Deliberately excludes body, value,
 * payload and inline: a span attribute is as exportable as a log line, and
 * CLAUDE.md §4 forbids message bodies in either.
 */
export const SPAN_ATTRIBUTE_ALLOWLIST = [
  'workspace',
  'agent',
  'msg_id',
  'task_id',
  'thread',
  'trace_id',
  'http.method',
  'http.route',
  'http.status_code',
  'error.code',
] as const;

/**
 * The only attributes that may legitimately be numbers. Everything else must be
 * a string: an `agent` or `task_id` is never numeric, so a number there means
 * the caller passed the wrong thing and coercing it would hide that.
 */
const NUMERIC_ATTRIBUTES = new Set<string>(['http.status_code']);

export function spanAttributes(input: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const key of SPAN_ATTRIBUTE_ALLOWLIST) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') {
      out[key] = value;
    } else if (NUMERIC_ATTRIBUTES.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

export interface TelemetryOptions {
  serviceName?: string;
  serviceVersion?: string;
  /** OTLP/HTTP traces endpoint. Omit to disable exporting entirely. */
  otlpEndpoint?: string | undefined;
  /** Inject an exporter directly (tests use InMemorySpanExporter). */
  exporter?: SpanExporter | undefined;
}

export interface Telemetry {
  /** False when nothing is configured: spans run but go nowhere. */
  enabled: boolean;
  tracer: Tracer | null;
}

const TRACER_NAME = 'agentbridge/hub';

let provider: TracerProvider | null = null;
let active: Telemetry = { enabled: false, tracer: null };

/**
 * Starts tracing.
 *
 * There is deliberately **no auto-instrumentation**. The node auto-instrumentations
 * record request and query attributes that have not been vetted against
 * CLAUDE.md §1.6 and §4 — a URL with a query string, or a SQL statement with
 * bound parameters, is exactly the kind of thing that must not leave the hub.
 * Every span here is created explicitly and its attributes pass the allowlist.
 *
 * With neither an endpoint nor an exporter, this is a no-op: spans still run
 * their body, so Phase 0 needs no collector (spec §8).
 */
export function initTelemetry(opts: TelemetryOptions = {}): Telemetry {
  const exporter =
    opts.exporter ??
    (opts.otlpEndpoint === undefined || opts.otlpEndpoint === ''
      ? undefined
      : new OTLPTraceExporter({ url: opts.otlpEndpoint }));

  if (exporter === undefined) {
    active = { enabled: false, tracer: null };
    return active;
  }

  // Simple for an injected exporter so tests see spans without waiting on a
  // batch timer; batched for a real endpoint so the hot path never blocks on
  // the network.
  // sdk-trace 3.0 takes an options object. A bare exporter is accepted without
  // throwing and then silently never stored, so the first forceFlush dies on
  // `undefined.forceFlush` — worth stating, because the failure is nowhere near
  // the mistake.
  const processor =
    opts.exporter === undefined
      ? new BatchSpanProcessor({ exporter })
      : new SimpleSpanProcessor({ exporter });

  provider = new TracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.serviceName ?? 'agentbridge-hub',
      [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? '0.1.0',
    }),
    spanProcessors: [processor],
  });

  active = { enabled: true, tracer: provider.getTracer(TRACER_NAME) };
  return active;
}

/**
 * Flushes pending spans without tearing the provider down. Separate from
 * shutdown because shutting down also disposes the exporter — an
 * InMemorySpanExporter clears its spans on shutdown, so a test that shuts down
 * before reading sees nothing.
 */
export async function flushTelemetry(): Promise<void> {
  if (provider === null) return;
  await provider.forceFlush();
}

export async function shutdownTelemetry(): Promise<void> {
  const current = provider;
  provider = null;
  active = { enabled: false, tracer: null };
  if (current === null) return;
  await current.shutdown();
}

/** A non-recording parent whose trace id is ours, so the span joins that trace. */
function parentContextFor(traceId: string) {
  const spanContext: SpanContext = {
    traceId,
    // A synthetic parent span id. The caller did not send one, but a span
    // context needs it to be well-formed.
    spanId: randomBytes(8).toString('hex'),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
  return trace.setSpanContext(otelContext.active(), spanContext);
}

/**
 * Starts a span the caller must end itself.
 *
 * Needed for a request span, whose lifetime spans two Fastify hooks and so
 * cannot be expressed as "run this function inside a span". Returns null when
 * tracing is off, so callers do not branch on configuration.
 */
export function startSpan(
  name: string,
  attributes: Record<string, unknown>,
  opts: { traceId?: string | undefined } = {},
): Span | null {
  const tracer = active.tracer;
  if (tracer === null) return null;

  const parent =
    opts.traceId !== undefined && isTraceId(opts.traceId)
      ? parentContextFor(opts.traceId)
      : otelContext.active();

  return tracer.startSpan(name, { attributes: spanAttributes(attributes) }, parent);
}

/** Ends a span started by startSpan, recording the outcome. */
export function endSpan(
  span: Span | null,
  outcome: {
    statusCode?: number | undefined;
    errorCode?: string | undefined;
    /** Known only after authentication, so these are set when the span closes. */
    agent?: string | undefined;
    workspace?: string | undefined;
  } = {},
): void {
  if (span === null) return;
  const attrs = spanAttributes({
    ...(outcome.statusCode === undefined ? {} : { 'http.status_code': outcome.statusCode }),
    ...(outcome.errorCode === undefined ? {} : { 'error.code': outcome.errorCode }),
    ...(outcome.agent === undefined ? {} : { agent: outcome.agent }),
    ...(outcome.workspace === undefined ? {} : { workspace: outcome.workspace }),
  });
  span.setAttributes(attrs);
  // 5xx is the server's fault and is what an operator wants to find; a 4xx is
  // the caller's mistake and should not light up an error dashboard.
  const failed = outcome.statusCode !== undefined && outcome.statusCode >= 500;
  span.setStatus({
    code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    ...(outcome.errorCode === undefined ? {} : { message: outcome.errorCode }),
  });
  span.end();
}

/**
 * Runs `fn` inside a span.
 *
 * When `traceId` is given, the span is created as a child of a remote parent
 * carrying that trace id — so the hub's spans land in the CALLER's trace rather
 * than a disconnected one. That is what makes `trace_id` in the envelope
 * useful: one trace covering both agents (spec §8).
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: Span | null) => Promise<T>,
  opts: { traceId?: string | undefined } = {},
): Promise<T> {
  const tracer = active.tracer;
  if (tracer === null) return fn(null);

  const attrs = spanAttributes(attributes);
  const parent =
    opts.traceId !== undefined && isTraceId(opts.traceId)
      ? parentContextFor(opts.traceId)
      : otelContext.active();

  return tracer.startActiveSpan(name, { attributes: attrs }, parent, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        // The error MESSAGE only. recordException would attach a stack, and a
        // stack can quote the values that caused the throw.
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Reads exporter configuration from the environment. */
export function telemetryOptionsFromEnv(): TelemetryOptions {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    (process.env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
      ? undefined
      : `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`);

  return {
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'agentbridge-hub',
    ...(endpoint === undefined ? {} : { otlpEndpoint: endpoint }),
  };
}
