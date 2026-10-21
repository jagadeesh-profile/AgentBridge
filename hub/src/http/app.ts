import { randomBytes } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  AgentBridgeError,
  ApprovalDecisionRequest,
  CreateTaskRequest,
  InboxQuery,
  PostMessageRequest,
  PutArtifactRequest,
  AuditQuery,
  RegisterAgentRequest,
  TaskListQuery,
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
import { verifyWholeChain } from '../domain/audit.js';
import { registerAgent, revokeKey } from '../domain/registry.js';
import { cancelTaskAsOwner, createTask, updateTask } from '../domain/tasks.js';
import { postMessage } from '../domain/threads.js';
import { ackInbox, listInbox } from '../domain/inbox.js';
import type { AgentRecord, BlobStore, Clock, IdGen, Store } from '../ports/index.js';
import { REPLAY_WINDOW_MS, assertFreshTimestamp, authenticate, authenticateOwner } from './auth.js';
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
    /** Set only on owner-authenticated routes, and only from the signature. */
    ownerWorkspace?: string;
    rawBodyText?: string;
    traceId?: string;
    span?: OtelSpan | null;
  }
}

const AUTHENTICATED_PREFIX = '/v1/';
const OPEN_PATHS = new Set(['/healthz', '/v1/agents']);

/**
 * Routes the OWNER performs, authenticated by the owner key (ADR 0006) rather
 * than by a borrowed agent identity. Matched on method *and* path: POST
 * /v1/tasks is an agent creating work, GET /v1/tasks is the owner reading the
 * approval queue.
 */
const OWNER_ROUTES: readonly (readonly [string, string])[] = [
  ['POST', '/v1/approvals'],
  ['GET', '/v1/tasks'],
  ['GET', '/v1/agents'],
  // The kill switch. Until ADR 0006 this was `requireAgent` with no scope
  // check, so any agent holding the default read+message could revoke every
  // other agent in the workspace — the opposite of CLAUDE.md §1.8.
  ['DELETE', '/v1/agents/:ref/key'],
  // Owner cancel. `cancelTaskAsOwner` writes an audit row attributed to the
  // owner, so an agent reaching it forged that attribution in an append-only,
  // hash-chained log — a lie that outlives the request.
  ['DELETE', '/v1/tasks/:id'],
  // The audit log and the dead-letter queue are workspace-wide views. On agent
  // auth any single agent could read every other agent's failures and the full
  // history of the workspace; neither is an agent's business.
  ['GET', '/v1/audit'],
  ['GET', '/v1/audit/verify'],
  ['GET', '/v1/dlq'],
];

/**
 * Matched against Fastify's route PATTERN, not the concrete URL, so a
 * parameterised route is recognised without re-implementing path matching
 * here. The pattern decides who may call; the concrete path is still what the
 * signature covers, so swapping `:ref` after signing invalidates it.
 */
const isOwnerRoute = (method: string, routePattern: string | undefined): boolean =>
  routePattern !== undefined && OWNER_ROUTES.some(([m, p]) => m === method && p === routePattern);

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

    // Owner-only routes (ADR 0006). `req.agent` stays undefined on these, so a
    // handler that reached for an agent would fail rather than silently act as
    // one; the workspace comes from the signature, never from the header.
    if (isOwnerRoute(req.method, req.routeOptions.url)) {
      req.ownerWorkspace = await authenticateOwner(deps, deps.ownerPublicKey, {
        method: req.method,
        path,
        query: (req.query ?? {}) as Record<string, string | string[]>,
        body: req.rawBodyText ?? '',
        headers: req.headers as Record<string, string | undefined>,
      });
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

    assertFreshTimestamp(deps.clock.now(), timestamp, 'registration timestamp');

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

  /**
   * The workspace the OWNER's signature authorised. Never `workspaceOf`, which
   * reads the header: on an owner route the header is only a hint, and taking
   * it would let a valid signature for one workspace act on another.
   */
  const requireOwner = (req: FastifyRequest): string => {
    if (req.ownerWorkspace === undefined) throw new AgentBridgeError('unauthenticated');
    return req.ownerWorkspace;
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

  /** The owner's roster: who exists and whose key still works. */
  app.get('/v1/agents', async (req) => {
    const ws = requireOwner(req);
    return {
      items: deps.store.listAgents(ws).map((a) => ({
        ref: a.ref,
        name: a.name,
        scopes: a.scopes,
        key_status: a.keyStatus,
        // Deliberately no public_key and no webhook_secret. The roster answers
        // "who is here and can they still act"; neither is needed for that,
        // and the secret must not leave the hub a second time.
        webhook_url: a.webhookUrl,
        created_at: a.createdAt,
      })),
    };
  });

  app.delete<{ Params: { ref: string } }>('/v1/agents/:ref/key', async (req) => {
    const ws = requireOwner(req);
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
    const ws = requireOwner(req);
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

  app.get('/v1/tasks', async (req) => {
    const ws = requireOwner(req);
    const q = TaskListQuery.parse(req.query ?? {});
    const items = deps.store.listTasksByState(ws, q.state ?? null, q.limit);
    return {
      items: items.map((t) => ({
        id: t.id,
        thread: t.thread,
        creator: t.creator,
        assignee: t.assignee,
        title: t.title,
        ...(q.include_payload ? { payload: t.payload } : {}),
        payload_hash: t.payloadHash,
        state: t.state,
        side_effect: t.sideEffect,
        created_at: t.createdAt,
        updated_at: t.updatedAt,
      })),
      // No pagination beyond `limit` in Phase 0: the approval queue is the
      // owner's own backlog, and a workspace with 200 waiting decisions has a
      // bigger problem than paging.
      cursor: null,
    };
  });

  app.post('/v1/approvals', async (req) => {
    const ws = requireOwner(req);
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

  /**
   * The raw chain, so the owner can verify it themselves.
   *
   * `/v1/audit/verify` below asks the hub whether its own log is intact, which
   * is worth little on its own — a hub that rewrote a row would also answer
   * yes. This endpoint hands over the rows and their hashes so the client can
   * recompute the chain with `verifyAuditChain` from `contracts`.
   */
  app.get('/v1/audit', async (req) => {
    const ws = requireOwner(req);
    const q = AuditQuery.parse(req.query ?? {});
    const items = deps.store.listAudit(ws, q.since, q.limit);
    return {
      items: items.map((r) => ({
        seq: r.seq,
        action: r.action,
        actor: r.actor,
        subject: r.subject,
        prev_hash: r.prevHash,
        hash: r.hash,
        created_at: r.createdAt,
      })),
      cursor: items.at(-1)?.seq ?? null,
    };
  });

  app.get('/v1/audit/verify', async (req) => {
    return verifyWholeChain(deps, requireOwner(req));
  });

  app.get('/v1/dlq', async (req) => {
    return { items: deps.store.listDead(requireOwner(req)) };
  });

  return app;
}
