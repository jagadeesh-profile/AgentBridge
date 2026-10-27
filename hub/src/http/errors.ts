import { RPC } from '@agentbridge/a2a';
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
/**
 * The A2A JSON-RPC endpoint, which needs its errors in a different shape.
 *
 * Matched on the URL rather than the resolved route because the two failures
 * that made this necessary — a malformed JSON body and a rejected signature —
 * both happen before the handler runs, in the content-type parser and the auth
 * `preHandler` respectively.
 */
const A2A_RPC_PATH = '/a2a/v1';

function isA2ARpc(req: FastifyRequest): boolean {
  return (req.url ?? '').split('?')[0] === A2A_RPC_PATH;
}

/**
 * Renders an error as JSON-RPC 2.0 for the A2A endpoint.
 *
 * Status 200 with the failure in the body, matching what the A2A route itself
 * does: a non-2xx would make a transport failure indistinguishable from an
 * application one. The id is echoed when the request supplied a readable one,
 * because a client correlating by id otherwise waits forever for a reply it
 * can match — and a request whose *body* failed to parse has no id to echo, so
 * null is the honest answer there.
 */
function sendRpcError(
  reply: FastifyReply,
  req: FastifyRequest,
  code: number,
  message: string,
  data?: unknown,
): void {
  const raw = (req.body as { id?: unknown } | undefined)?.id;
  const id = typeof raw === 'string' || typeof raw === 'number' ? raw : null;
  void reply.status(200).send({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void => {
      const traceId = req.traceId ?? String(req.id);

      // A2A callers parse JSON-RPC, so they get JSON-RPC — including for the
      // failures raised before the route runs. Without this they received
      // AgentBridge's own envelope, whose `code` is a string like
      // "schema_invalid" where JSON-RPC requires a number, which the A2A
      // conformance suite caught on both the parse-error and unauthenticated
      // paths. Scoped to this one path so every other route keeps the single
      // error shape spec §6 defines.
      if (isA2ARpc(req)) {
        // NOTE: AgentBridgeError is deliberately NOT handled here, so
        // authentication and authorization failures keep their HTTP status.
        // Spec §5.4 maps authentication errors to 401 and authorization to
        // 403, and a client that must refresh a credential needs to see the
        // status rather than dig a code out of a 200 body. An earlier draft of
        // this change converted them too, which is what made the pre-existing
        // 401 tests fail — the tests were right and the conformance case
        // asserting a numeric code for an unsigned call was wrong.
        if (err instanceof SyntaxError) {
          sendRpcError(reply, req, RPC.parseError, 'invalid JSON payload');
          return;
        }
        if (err instanceof TooDeepError) {
          sendRpcError(reply, req, RPC.invalidRequest, err.message);
          return;
        }
        if (err instanceof ZodError) {
          sendRpcError(reply, req, RPC.invalidParams, 'invalid parameters');
          return;
        }
        // Everything else falls through to the standard handling below, which
        // keeps its HTTP status. That covers authentication (401) and
        // authorization (403) per spec §5.4, rate limiting (429 — transport
        // backpressure, for which the A2A error table has no code), and any
        // unexpected fault (500). Only the three cases above are JSON-RPC-layer
        // concerns that the route would itself have reported as JSON-RPC had it
        // been reached.
        //
        // An earlier draft ended this block with a catch-all that answered 200
        // + -32603, which swallowed the 401s and is exactly the bug the
        // pre-existing auth tests caught.
      }

      if (err instanceof AgentBridgeError) {
        req.log.warn({ code: err.code, trace_id: traceId, detail: err.detail }, 'request rejected');
        void reply
          .status(err.status)
          .send(body(err.code, traceId, err.publicDetail ?? err.message));
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
