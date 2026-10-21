import { randomBytes } from 'node:crypto';

export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** W3C-shaped trace id: 16 random bytes, lowercase hex. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
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
] as const;

export function spanAttributes(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SPAN_ATTRIBUTE_ALLOWLIST) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}
