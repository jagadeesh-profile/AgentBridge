import {
  RPC,
  RpcFailure,
  buildAgentCard,
  err,
  fromParts,
  ok,
  parseEnvelope,
  toA2ATask,
  type Part,
  type RpcId,
} from '@agentbridge/a2a';
import { AgentBridgeError } from '@agentbridge/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AgentRecord, Deps } from '../ports/index.js';
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

/** Hub error code → JSON-RPC code. Unmapped codes surface as internal. */
function hubCodeToRpc(code: string): number {
  switch (code) {
    case 'not_found':
      return RPC.taskNotFound;
    case 'illegal_transition':
      return RPC.taskNotCancelable;
    case 'schema_invalid':
      return RPC.invalidParams;
    case 'scope_denied':
    case 'unauthenticated':
    case 'key_revoked':
      return RPC.invalidRequest;
    case 'approval_required':
      return RPC.unsupportedOperation;
    default:
      return RPC.internalError;
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

    case 'tasks/get': {
      if (typeof p.id !== 'string') throw new RpcFailure(RPC.invalidParams, 'id is required');
      const task = deps.store.getTask(agent.workspace, p.id);
      // Scoped to the caller's own work. Without this an A2A caller could
      // enumerate every task in the workspace by id, which the REST route
      // also permits — recorded as a follow-up rather than widened here.
      if (!task || (task.creator !== agent.ref && task.assignee !== agent.ref)) {
        throw new RpcFailure(RPC.taskNotFound, 'no such task');
      }
      return toA2ATask(task);
    }

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

    case 'tasks/pushNotificationConfig/set':
    case 'tasks/pushNotificationConfig/get':
      throw new RpcFailure(
        RPC.pushNotificationNotSupported,
        'push notifications are not supported; the card declares pushNotifications: false',
      );

    default:
      throw new RpcFailure(RPC.methodNotFound, `unknown method: ${method}`);
  }
}
