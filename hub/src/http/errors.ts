import { AgentBridgeError, ERROR_CATALOG, type ErrorCode } from '@agentbridge/contracts';
import { ZodError } from 'zod';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ErrorBody {
  error: { code: string; message: string; trace_id: string };
}

const MAX_DEPTH = 64;

/** A body too deeply nested to be legitimate — Zod recursion is the hazard. */
export class TooDeepError extends Error {
  constructor() {
    super('payload nesting exceeds the permitted depth');
    this.name = 'TooDeepError';
  }
}

export function assertDepth(value: unknown, max = MAX_DEPTH): void {
  // Iterative, not recursive: a recursive guard would itself overflow on the
  // input it is meant to reject.
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    const { node, depth } = entry;
    if (node === null || typeof node !== 'object') continue;
    if (depth >= max) throw new TooDeepError();
    for (const child of Object.values(node as Record<string, unknown>)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
}

function body(code: ErrorCode | 'internal', traceId: string, message?: string): ErrorBody {
  if (code === 'internal') {
    return {
      error: { code, message: 'Internal error.', trace_id: traceId },
    };
  }
  return {
    error: { code, message: message ?? ERROR_CATALOG[code].message, trace_id: traceId },
  };
}

/**
 * One place maps a thrown error to a status and a response shape, so routes
 * never build error bodies and a newly added code cannot ship inconsistent
 * (spec §6). Stack traces are never returned (CLAUDE.md §4).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void => {
      const traceId = req.traceId ?? String(req.id);

      if (err instanceof AgentBridgeError) {
        req.log.warn({ code: err.code, trace_id: traceId, detail: err.detail }, 'request rejected');
        void reply.status(err.status).send(body(err.code, traceId, err.message));
        return;
      }

      // A malformed JSON body is a client mistake, not a server fault: the
      // content-type parser rethrows SyntaxError from JSON.parse.
      if (err instanceof ZodError || err instanceof TooDeepError || err instanceof SyntaxError) {
        void reply.status(400).send(body('schema_invalid', traceId));
        return;
      }

      const fastifyErr = err as FastifyError;
      if (fastifyErr.statusCode === 429) {
        void reply.status(429).send(body('rate_limited', traceId));
        return;
      }
      if (fastifyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        void reply.status(413).send(body('schema_invalid', traceId, 'Payload too large.'));
        return;
      }
      if (fastifyErr.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
        void reply.status(415).send(body('schema_invalid', traceId, 'Unsupported media type.'));
        return;
      }
      if (fastifyErr.statusCode === 400) {
        void reply.status(400).send(body('schema_invalid', traceId));
        return;
      }

      // Unexpected: log it server-side, tell the client nothing but a trace id.
      req.log.error({ err, trace_id: traceId }, 'unhandled error');
      void reply.status(500).send(body('internal', traceId));
    },
  );
}
