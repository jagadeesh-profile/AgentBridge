import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * CLAUDE.md §4: never log message bodies. Enforced by pino's redaction config
 * rather than by every call site remembering — a new handler cannot leak a body
 * by forgetting a convention it never read.
 */
export const REDACTED_PATHS = [
  'body',
  'value',
  'payload',
  'inline',
  'req.body',
  '*.body',
  '*.value',
  '*.payload',
  '*.inline',
  'privateKey',
  'webhookSecret',
  'public_key',
  'sig',
];

/**
 * Pino options, not a constructed logger: Fastify keeps its own
 * FastifyBaseLogger type when given options, whereas handing it a pino instance
 * leaks pino's Logger type through every FastifyInstance generic.
 */
export function loggerOptions(level = process.env.LOG_LEVEL ?? 'info'): LoggerOptions {
  return {
    level,
    redact: { paths: REDACTED_PATHS, remove: true },
  };
}

/** For callers outside Fastify (the delivery worker, the CLI). */
export function redactingLogger(level?: string): Logger {
  return pino(loggerOptions(level));
}
