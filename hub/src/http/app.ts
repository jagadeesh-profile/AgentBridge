import { randomBytes } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  AgentBridgeError,
  ApprovalDecisionRequest,
  CreateTaskRequest,
  InboxQuery,
  PostMessageRequest,
  PutArtifactRequest,
  RegisterAgentRequest,
  UpdateTaskRequest,
  payloadHash,
  registrationDescriptor,
  sha256Hex,
  verifyDescriptor,
} from '@agentbridge/contracts';
import type { Span as OtelSpan } from '@opentelemetry/api';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { decideApproval } from '../domain/approvals.js';
import { listArtifacts, putArtifact } from '../domain/artifacts.js';
import { verifyAuditChain } from '../domain/audit.js';
import { registerAgent, revokeKey } from '../domain/registry.js';
import { cancelTaskAsOwner, createTask, updateTask } from '../domain/tasks.js';
import { postMessage } from '../domain/threads.js';
import { ackInbox, listInbox } from '../domain/inbox.js';
import type { AgentRecord, BlobStore, Clock, IdGen, Store } from '../ports/index.js';
import { REPLAY_WINDOW_MS, authenticate } from './auth.js';
import { assertDepth, registerErrorHandler } from './errors.js';
import { withIdempotency } from './idempotency.js';
import { loggerOptions } from './logger.js';
import { endSpan, resolveTraceId, startSpan } from '../telemetry.js';

export interface AppDeps {
  store: Store;
  clock: Clock;
  ids: IdGen;
  blob: BlobStore;
  /** The owner's Ed25519 public key, base64. Approvals verify against it. */
  ownerPublicKey: Uint8Array;
}

export interface AppOptions {
  bodyLimit?: number;
  rateLimitMax?: number;
  rateLimitWindow?: string;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    agent?: AgentRecord;
    rawBodyText?: string;
    traceId?: string;
    span?: OtelSpan | null;
  }
}

const AUTHENTICATED_PREFIX = '/v1/';
const OPEN_PATHS = new Set(['/healthz', '/v1/agents']);

export async function buildApp(deps: AppDeps, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // 1 MiB. An agent is an untrusted sender; a 50 MB body must be refused
    // before it is parsed, not after (Review Focus item 5).
    bodyLimit: opts.bodyLimit ?? 1_048_576,
    genReqId: () => randomBytes(16).toString('hex'),
    logger: opts.logger === false ? false : loggerOptions(),
  });

  registerErrorHandler(app);

  // Keep the exact bytes: the request signature covers sha256(rawBody), so a
  // re-serialization of the parsed object would not reproduce it.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req: FastifyRequest, bodyText: string, done) => {
      req.rawBodyText = bodyText;
      if (bodyText === '') {
        done(null, {});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(bodyText);
        assertDepth(parsed);
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await app.register(rateLimit, {
    max: opts.rateLimitMax ?? 300,
    timeWindow: opts.rateLimitWindow ?? '1 minute',
    // Per agent, not per IP: several agents may sit behind one address.
    keyGenerator: (req: FastifyRequest) => req.headers['x-agentbridge-agent']?.toString() ?? req.ip,
    // No errorResponseBuilder: the plugin's 429 is normalized into the standard
    // { error: { code, message, trace_id } } shape by the single error handler,
    // so there is still exactly one place that builds an error body (spec §6).
  });

  // Adopt the caller's trace id when it is well-formed, so one trace spans both
  // agents (spec §8). A malformed id is replaced, never stored.
  app.addHook('onRequest', async (req) => {
    const { traceId, rejected } = resolveTraceId(req.headers['x-agentbridge-trace-id']);
    req.traceId = traceId;
    if (rejected) req.log.warn({ trace_id: traceId }, 'discarded a malformed inbound trace id');
  });

  // One span per API request, parented on the caller's trace id so the hub's
  // work lands in the SAME trace as the agent that called it (spec §8).
  // Started here and ended in onResponse: a request span outlives a single
  // hook, so it cannot be expressed as "run this function inside a span".
  // Attributes pass the allowlist, so a body can never reach a span.
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.url.startsWith(AUTHENTICATED_PREFIX)) {
      const route = req.url.split('?')[0] ?? req.url;
      req.span = startSpan(
        `hub ${req.method} ${route}`,
        { 'http.method': req.method, 'http.route': route, trace_id: req.traceId },
        { ...(req.traceId === undefined ? {} : { traceId: req.traceId }) },
      );
    }
    done();
  });

  // onResponse runs for success and for handled errors alike, so a span cannot
  // be leaked by an early return.
  app.addHook('onResponse', (req, reply, done) => {
    // agent and workspace are known only after authentication, which runs in
    // preHandler — after the span was started.
    endSpan(req.span ?? null, {
      statusCode: reply.statusCode,
      ...(req.agent === undefined ? {} : { agent: req.agent.ref, workspace: req.agent.workspace }),
    });
    req.span = null;
    done();
  });

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith(AUTHENTICATED_PREFIX)) return;
    const path = req.url.split('?')[0] ?? req.url;
    if (OPEN_PATHS.has(path) && req.method === 'POST') {
      await requireOwnerRegistration(req);
      return;
    }

    const bodyObj = (req.body ?? {}) as { idempotency_key?: unknown };
    const safeMethod = req.method === 'GET' || req.method === 'HEAD';
    const hasIdempotencyKey = typeof bodyObj.idempotency_key === 'string';

    req.agent = await authenticate(
      deps,
      {
        method: req.method,
        path,
        query: (req.query ?? {}) as Record<string, string | string[]>,
        body: req.rawBodyText ?? '',
        headers: req.headers as Record<string, string | undefined>,
      },
      { allowReplay: safeMethod || hasIdempotencyKey },
    );
  });

  /**
   * Registration is authorised by the OWNER's signature over exactly the
   * enrolment being requested (ADR 0005).
   *
   * This is the one operation that cannot be authenticated as the agent — it
   * has no registered key yet — so the owner signs instead. Because the
   * descriptor binds workspace, name, public key, scopes and webhook URL, a
   * captured signature cannot be retargeted: changing any of them invalidates
   * it. The body is re-read here rather than trusted, so what is verified is
   * what will be stored.
   */
  const requireOwnerRegistration = async (req: FastifyRequest): Promise<void> => {
    const signature = req.headers['x-agentbridge-owner-signature'];
    const timestamp = req.headers['x-agentbridge-timestamp'];
    if (typeof signature !== 'string' || signature === '') {
      throw new AgentBridgeError('unauthenticated', 'owner signature required to register');
    }
    if (typeof timestamp !== 'string' || timestamp === '') {
      throw new AgentBridgeError('unauthenticated', 'registration timestamp required');
    }

    const parsedAt = Date.parse(timestamp);
    if (Number.isNaN(parsedAt)) {
      throw new AgentBridgeError('unauthenticated', 'unparseable registration timestamp');
    }
    if (Math.abs(deps.clock.now().getTime() - parsedAt) > REPLAY_WINDOW_MS) {
      throw new AgentBridgeError('unauthenticated', 'registration outside the replay window');
    }

    // Replay check before anything else succeeds: re-submitting a past
    // enrolment must fail as a replay, not as a name conflict.
    const nonce = sha256Hex(signature);
    if (deps.store.seenNonce('owner', nonce)) {
      throw new AgentBridgeError('unauthenticated', 'registration already used');
    }

    const body = RegisterAgentRequest.parse(req.body);
    const descriptor = registrationDescriptor({
      workspace: workspaceOf(req),
      name: body.name,
      publicKey: body.public_key,
      scopes: body.scopes,
      ...(body.webhook_url === undefined ? {} : { webhookUrl: body.webhook_url }),
      issuedAt: timestamp,
    });

    if (!(await verifyDescriptor(descriptor, signature, deps.ownerPublicKey))) {
      throw new AgentBridgeError('unauthenticated', 'registration signature rejected');
    }

    deps.store.recordNonce(
      'owner',
      nonce,
      new Date(deps.clock.now().getTime() + REPLAY_WINDOW_MS).toISOString(),
    );
  };

  const requireAgent = (req: FastifyRequest): AgentRecord => {
    if (req.agent === undefined) throw new AgentBridgeError('unauthenticated');
    return req.agent;
  };

  const workspaceOf = (req: FastifyRequest): string => {
    const ws = req.headers['x-agentbridge-workspace'];
    if (typeof ws !== 'string' || ws === '') {
      throw new AgentBridgeError('unauthenticated', 'missing workspace header');
    }
    return ws;
  };

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post('/v1/agents', async (req, reply) => {
    const parsed = RegisterAgentRequest.parse(req.body);
    const agent = registerAgent(deps, workspaceOf(req), parsed);
    // The secret is returned exactly once, at registration; it is never
    // readable again.
    void reply.status(201);
    return {
      ref: agent.ref,
      scopes: agent.scopes,
      webhook_secret: agent.webhookSecret,
      created_at: agent.createdAt,
    };
  });

  app.delete<{ Params: { ref: string } }>('/v1/agents/:ref/key', async (req) => {
    const ws = workspaceOf(req);
    requireAgent(req);
    revokeKey(deps, ws, decodeURIComponent(req.params.ref));
    return { revoked: decodeURIComponent(req.params.ref) };
  });

  app.post('/v1/messages', async (req, reply) => {
    const agent = requireAgent(req);
    const parsed = PostMessageRequest.parse(req.body);
    const out = await withIdempotency(
      deps,
      agent.workspace,
      agent.ref,
      parsed.idempotency_key,
      payloadHash(parsed),
      () => postMessage(deps, agent, { ...parsed, trace_id: req.traceId }),
    );
    void reply.status(202);
    return out;
  });

  app.post('/v1/tasks', async (req, reply) => {
    const agent = requireAgent(req);
    const parsed = CreateTaskRequest.parse(req.body);
    const out = await withIdempotency(
      deps,
      agent.workspace,
      agent.ref,
      parsed.idempotency_key,
      payloadHash(parsed),
      () => createTask(deps, agent, { ...parsed, trace_id: req.traceId }),
    );
    void reply.status(201);
    return out;
  });

  app.get<{ Params: { id: string } }>('/v1/tasks/:id', async (req) => {
    const agent = requireAgent(req);
    const task = deps.store.getTask(agent.workspace, req.params.id);
    if (!task) throw new AgentBridgeError('not_found', req.params.id);
    return { ...task, artifacts: listArtifacts(deps, agent, task.id) };
  });

  app.patch<{ Params: { id: string } }>('/v1/tasks/:id', async (req) => {
    const agent = requireAgent(req);
    const parsed = UpdateTaskRequest.parse(req.body);
    return withIdempotency(
      deps,
      agent.workspace,
      agent.ref,
      parsed.idempotency_key,
      payloadHash({ id: req.params.id, ...parsed }),
      () =>
        updateTask(deps, agent, req.params.id, parsed.state, {
          ...(parsed.note === undefined ? {} : { note: parsed.note }),
          ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
        }),
    );
  });

  app.delete<{ Params: { id: string } }>('/v1/tasks/:id', async (req) => {
    const ws = workspaceOf(req);
    requireAgent(req);
    return cancelTaskAsOwner(deps, ws, req.params.id, {
      ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
    });
  });

  app.post('/v1/artifacts', async (req, reply) => {
    const agent = requireAgent(req);
    const parsed = PutArtifactRequest.parse(req.body);
    const out = await withIdempotency(
      deps,
      agent.workspace,
      agent.ref,
      parsed.idempotency_key,
      payloadHash(parsed),
      () => putArtifact(deps, agent, { ...parsed, trace_id: req.traceId }),
    );
    void reply.status(201);
    return out;
  });

  app.post('/v1/approvals', async (req) => {
    const ws = workspaceOf(req);
    const parsed = ApprovalDecisionRequest.parse(req.body);
    return decideApproval(deps, deps.ownerPublicKey, ws, {
      ...parsed,
      ...(req.traceId === undefined ? {} : { trace_id: req.traceId }),
    });
  });

  app.get('/v1/inbox', async (req) => {
    const agent = requireAgent(req);
    const q = InboxQuery.parse(req.query ?? {});
    return listInbox(deps, agent, q);
  });

  app.post<{ Body: { up_to?: string } }>('/v1/inbox/ack', async (req) => {
    const agent = requireAgent(req);
    const upTo = req.body?.up_to;
    if (typeof upTo !== 'string' || upTo === '') {
      throw new AgentBridgeError('schema_invalid', 'up_to is required');
    }
    return ackInbox(deps, agent, upTo);
  });

  app.get('/v1/audit/verify', async (req) => {
    const agent = requireAgent(req);
    return verifyAuditChain(deps, agent.workspace);
  });

  app.get('/v1/dlq', async (req) => {
    const agent = requireAgent(req);
    return { items: deps.store.listDead(agent.workspace) };
  });

  return app;
}
