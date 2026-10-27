import {
  RPC,
  RpcFailure,
  buildAgentCard,
  err,
  fromParts,
  hubCodeToRpc,
  ok,
  parseEnvelope,
  toA2ATask,
  type Part,
  type RpcId,
} from '@agentbridge/a2a';
import { AgentBridgeError } from '@agentbridge/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AgentRecord, Deps, TaskRecord } from '../ports/index.js';
import { createTask, updateTask } from '../domain/tasks.js';

/**
 * The A2A v1.0 endpoint.
 *
 * Served from inside the hub rather than from a proxy in `adapters/`, because
 * the remote agent's Ed25519 signature covers the method, path and body hash
 * of *this* request. A proxy would have to either re-sign with its own key —
 * becoming a confused deputy whose scopes every caller inherits — or ask the
 * hub to trust a header about what was signed. Here the hub's ordinary
 * `preHandler` authenticates the caller, so `req.agent` is the remote agent
 * and the audit log names it.
 *
 * Everything protocol-shaped (card, envelope, mapping) lives in
 * `@agentbridge/a2a` and is imported; this file is routing and nothing else.
 */

export interface A2ADeps {
  deps: Deps;
  publicUrl: string;
}

export function registerA2A(app: FastifyInstance, a2a: A2ADeps): void {
  const card = () => buildAgentCard({ publicUrl: a2a.publicUrl });

  // Unauthenticated: discovery has to work before credentials exist. The card
  // carries protocol facts only — no agent names, no workspace contents.
  app.get('/.well-known/agent-card.json', async () => card());
  app.get('/.well-known/agent.json', async () => card());

  app.post('/a2a/v1', async (req, reply) => {
    let id: RpcId = null;
    try {
      const parsed = parseEnvelope(req.body);
      id = parsed.id;
      const agent = req.agent;
      if (agent === undefined) throw new RpcFailure(RPC.invalidRequest, 'unauthenticated');
      return ok(
        id,
        await dispatch(a2a.deps, agent, req, parsed.request.method, parsed.request.params),
      );
    } catch (e: unknown) {
      // JSON-RPC carries failure in the body with a 200: a non-2xx would make
      // transport failures indistinguishable from application ones.
      void reply.status(200);
      if (e instanceof RpcFailure) return err(e.id ?? id, e.code, e.message, e.data);
      if (e instanceof AgentBridgeError) {
        return err(id, hubCodeToRpc(e.code), e.message, { agentbridgeCode: e.code });
      }
      req.log.error({ err: e }, 'a2a dispatch failed');
      return err(id, RPC.internalError, 'internal error');
    }
  });
}

/**
 * The task, if it is the caller's business.
 *
 * Without this an A2A caller could enumerate every task in the workspace by
 * id. "Not yours" and "does not exist" deliberately give the same answer, so
 * the error cannot be used to probe for ids.
 */
function ownTaskOrThrow(deps: Deps, agent: AgentRecord, taskId: string): TaskRecord {
  const task = deps.store.getTask(agent.workspace, taskId);
  if (!task || (task.creator !== agent.ref && task.assignee !== agent.ref)) {
    throw new RpcFailure(RPC.taskNotFound, 'no such task');
  }
  return task;
}

/**
 * A push URL must share an origin with the agent's registered webhook.
 *
 * This is the whole SSRF answer. An endpoint where a caller names a URL the
 * hub will then POST to is an SSRF primitive — cloud metadata, internal
 * services, anything the hub can reach. Constraining it to the origin the
 * OWNER signed at enrolment (ADR 0005) means push can only ever reach a
 * destination already authorised; the caller chooses the path, not the host.
 *
 * An agent with no registered webhook cannot use push at all. That is
 * correct rather than restrictive: it has no authorised origin, and the pull
 * inbox already serves it.
 */
function assertAuthorisedOrigin(agent: AgentRecord, url: string): void {
  if (agent.webhookUrl === null) {
    // -32003 PushNotificationNotSupportedError, not -32004. The spec has a
    // dedicated code for "push notifications used but not supported", and
    // -32004 ("operation not supported by this agent") reads as though the
    // method itself were unavailable — which would contradict the card, since
    // it declares pushNotifications: true. The accurate statement is that push
    // is unsupported *for this caller*, having no authorised origin.
    throw new RpcFailure(
      RPC.pushNotificationNotSupported,
      'this agent has no registered webhook, so it has no owner-authorised origin to ' +
        'push to. Register one at enrolment, or poll tasks/get.',
    );
  }
  let target: URL;
  let allowed: URL;
  try {
    target = new URL(url);
    allowed = new URL(agent.webhookUrl);
  } catch {
    throw new RpcFailure(RPC.invalidParams, 'pushNotificationConfig.url is not a valid URL');
  }
  if (target.origin !== allowed.origin) {
    throw new RpcFailure(
      RPC.invalidParams,
      `push url must share an origin with this agent's registered webhook (${allowed.origin}); ` +
        'the hub will not POST to a destination the owner did not authorise',
    );
  }
}

async function dispatch(
  deps: Deps,
  agent: AgentRecord,
  req: FastifyRequest,
  method: string,
  params: unknown,
): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  const traceId = req.traceId;

  switch (method) {
    case 'message/send': {
      const message = p.message as { parts?: Part[] } | undefined;
      if (message === undefined) throw new RpcFailure(RPC.invalidParams, 'message is required');

      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      const assignee = meta['agentbridge/assignee'];
      if (typeof assignee !== 'string') {
        // A2A addresses an endpoint; AgentBridge addresses an agent. The hub
        // will not pick one on the caller's behalf — a guess here would route
        // someone's work to an arbitrary agent.
        throw new RpcFailure(
          RPC.invalidParams,
          'metadata["agentbridge/assignee"] is required: A2A addresses an endpoint, ' +
            'AgentBridge addresses a named agent',
        );
      }

      const task = createTask(deps, agent, {
        thread: typeof p.contextId === 'string' ? p.contextId : `thr_${agent.ref}_a2a`,
        assignee,
        title:
          typeof meta['agentbridge/title'] === 'string' ? meta['agentbridge/title'] : 'a2a task',
        payload: fromParts(message.parts ?? []),
        side_effect: meta['agentbridge/side_effect'] === true,
        ...(traceId === undefined ? {} : { trace_id: traceId }),
      });
      return toA2ATask(task);
    }

    case 'tasks/get':
      if (typeof p.id !== 'string') throw new RpcFailure(RPC.invalidParams, 'id is required');
      return toA2ATask(ownTaskOrThrow(deps, agent, p.id));

    case 'tasks/cancel': {
      if (typeof p.id !== 'string') throw new RpcFailure(RPC.invalidParams, 'id is required');
      // As the creator, via the ordinary transition table — not the
      // owner-only cancel. A remote agent may cancel work it created and
      // nothing else, and the table enforces that rather than this file.
      const task = updateTask(deps, agent, p.id, 'canceled', {
        ...(traceId === undefined ? {} : { traceId }),
      });
      return toA2ATask(task);
    }

    case 'message/stream':
    case 'tasks/resubscribe':
      throw new RpcFailure(
        RPC.unsupportedOperation,
        'streaming is not supported; the agent card declares streaming: false. Poll tasks/get.',
      );

    case 'tasks/pushNotificationConfig/set': {
      const taskId = typeof p.taskId === 'string' ? p.taskId : p.id;
      if (typeof taskId !== 'string') throw new RpcFailure(RPC.invalidParams, 'taskId is required');
      const cfg = (p.pushNotificationConfig ?? p.config ?? {}) as Record<string, unknown>;
      const url = cfg.url;
      if (typeof url !== 'string') {
        throw new RpcFailure(RPC.invalidParams, 'pushNotificationConfig.url is required');
      }

      const task = ownTaskOrThrow(deps, agent, taskId);
      assertAuthorisedOrigin(agent, url);

      deps.store.putPushConfig({
        workspace: agent.workspace,
        task: task.id,
        agentRef: agent.ref,
        url,
        token: typeof cfg.token === 'string' ? cfg.token : null,
        createdAt: new Date().toISOString(),
      });
      return { taskId: task.id, pushNotificationConfig: { url, token: cfg.token ?? undefined } };
    }

    case 'tasks/pushNotificationConfig/get': {
      const taskId = typeof p.taskId === 'string' ? p.taskId : p.id;
      if (typeof taskId !== 'string') throw new RpcFailure(RPC.invalidParams, 'taskId is required');
      const task = ownTaskOrThrow(deps, agent, taskId);
      const cfg = deps.store.getPushConfig(agent.workspace, task.id);
      if (!cfg || cfg.agentRef !== agent.ref) {
        throw new RpcFailure(RPC.taskNotFound, 'no push configuration for that task');
      }
      // The token is write-only: echoing it back would turn a read into a
      // way to recover a secret from a task id.
      return { taskId: task.id, pushNotificationConfig: { url: cfg.url } };
    }

    default:
      throw new RpcFailure(RPC.methodNotFound, `unknown method: ${method}`);
  }
}
