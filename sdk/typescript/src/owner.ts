import {
  AgentBridgeError,
  canonicalize,
  ownerRequestDescriptor,
  payloadHash,
  signDescriptor,
} from '@agentbridge/contracts';
import type { ErrorCode } from '@agentbridge/contracts';

/**
 * The owner's client (ADR 0006). Authenticates with the owner key alone — no
 * agent identity, which is what lets the console hold exactly one secret.
 *
 * Deliberately free of `node:` imports, including transitively: the console
 * loads the owner key into the page and signs there, so this module has to
 * bundle for a browser. The alternative — signing on a server — would put the
 * owner key on a long-lived process that anyone reaching it could approve with.
 */
export interface OwnerClientOptions {
  baseUrl: string;
  workspace: string;
  privateKey: Uint8Array;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export interface PendingTask {
  id: string;
  thread: string;
  creator: string;
  assignee: string;
  title: string;
  payload: unknown;
  /** As advertised by the hub. `decide` recomputes rather than trusting it. */
  payloadHash: string;
  state: string;
  sideEffect: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSummary {
  ref: string;
  name: string;
  scopes: readonly string[];
  keyStatus: 'active' | 'revoked';
  webhookUrl: string | null;
  createdAt: string;
}

interface WireAgent {
  ref: string;
  name: string;
  scopes: string[];
  key_status: 'active' | 'revoked';
  webhook_url: string | null;
  created_at: string;
}

interface WireTask {
  id: string;
  thread: string;
  creator: string;
  assignee: string;
  title: string;
  payload: unknown;
  payload_hash: string;
  state: string;
  side_effect: boolean;
  created_at: string;
  updated_at: string;
}

interface WireError {
  error?: { code?: string; message?: string; trace_id?: string };
}

export class OwnerClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly opts: OwnerClientOptions) {
    // Bound: stored on the instance and called as `this.fetchImpl(...)`, the
    // global would arrive with `this` set to this object, which a browser
    // rejects outright ("Illegal invocation"). Node does not care, so nothing
    // but a real page catches it.
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? (() => new Date());
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async listPendingApprovals(limit = 50): Promise<PendingTask[]> {
    const res = await this.request<{ items: WireTask[] }>(
      'GET',
      `/v1/tasks?limit=${limit}&state=needs-approval`,
    );
    return res.items.map((t) => ({
      id: t.id,
      thread: t.thread,
      creator: t.creator,
      assignee: t.assignee,
      title: t.title,
      payload: t.payload,
      payloadHash: t.payload_hash,
      state: t.state,
      sideEffect: t.side_effect,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }));
  }

  /** Who is in the workspace, and whose key still works. */
  async listAgents(): Promise<AgentSummary[]> {
    const res = await this.request<{ items: WireAgent[] }>('GET', '/v1/agents');
    return res.items.map((a) => ({
      ref: a.ref,
      name: a.name,
      scopes: a.scopes,
      keyStatus: a.key_status,
      webhookUrl: a.webhook_url,
      createdAt: a.created_at,
    }));
  }

  /**
   * The kill switch: revokes an agent's key and drops its pending deliveries.
   *
   * Takes effect on that agent's very next request, because key status is
   * checked inside signature verification. Irreversible in Phase 0 — there is
   * no un-revoke, only re-enrolment with a fresh key.
   */
  async revokeAgentKey(ref: string): Promise<{ revoked: string }> {
    return this.request('DELETE', `/v1/agents/${encodeURIComponent(ref)}/key`);
  }

  /**
   * Signs a decision bound to the hash of the payload **as recomputed here**.
   *
   * Not `task.payloadHash`. The owner is approving what they were shown, and
   * the only hash that means that is one derived from the payload this client
   * holds. Signing the hub's figure would approve whatever the hub asserted —
   * the gate would verify a signature over the hub's own claim. When the two
   * disagree the hub answers `approval_hash_mismatch` and nothing happens,
   * which is the correct outcome.
   */
  async decide(
    task: Pick<PendingTask, 'id' | 'payload'>,
    decision: 'approve' | 'reject',
  ): Promise<{ id: string; state: string }> {
    const payload_hash = payloadHash(task.payload);
    const issued_at = this.now().toISOString();
    const sig = await signDescriptor(
      canonicalize({ task: task.id, decision, payload_hash, issued_at }),
      this.opts.privateKey,
    );
    return this.request('POST', '/v1/approvals', {
      task: task.id,
      decision,
      payload_hash,
      issued_at,
      sig,
    });
  }

  private async request<T>(method: string, pathWithQuery: string, bodyObj?: unknown): Promise<T> {
    const [bare, qs] = pathWithQuery.split('?');
    const path = bare ?? pathWithQuery;
    const query: Record<string, string> = {};
    if (qs !== undefined) {
      for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
    }
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const issuedAt = this.now().toISOString();

    const signature = await signDescriptor(
      ownerRequestDescriptor({
        method,
        path,
        query,
        body,
        workspace: this.opts.workspace,
        issuedAt,
      }),
      this.opts.privateKey,
    );

    // No retries. An owner request carries a single-use nonce, so a replay is
    // refused by design; and an approval is a side effect the owner authorised
    // once, which is not something to re-send automatically.
    const res = await this.fetchImpl(`${this.opts.baseUrl}${pathWithQuery}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': this.opts.workspace,
        'x-agentbridge-timestamp': issuedAt,
        'x-agentbridge-owner-signature': signature,
      },
      ...(bodyObj === undefined ? {} : { body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.ok) return (await res.json()) as T;
    throw await toTypedError(res);
  }
}

async function toTypedError(res: Response): Promise<Error> {
  let parsed: WireError = {};
  try {
    parsed = (await res.json()) as WireError;
  } catch {
    // Non-JSON error body; fall through to a generic error.
  }
  const code = parsed.error?.code;
  if (code !== undefined && code !== 'internal') {
    return new AgentBridgeError(code as ErrorCode, parsed.error?.trace_id, parsed.error?.message);
  }
  return new Error(`hub returned ${res.status}: ${parsed.error?.message ?? res.statusText}`);
}
