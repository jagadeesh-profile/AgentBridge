import {
  AgentBridgeError,
  canonicalize,
  ownerRequestDescriptor,
  payloadHash,
  signDescriptor,
  verifyAuditChain,
} from '@agentbridge/contracts';
import type { AuditVerification, ErrorCode } from '@agentbridge/contracts';

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

export interface AuditEntry {
  seq: number;
  workspace: string;
  action: string;
  actor: string;
  subject: string;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface DeadLetter {
  id: string;
  thread: string;
  recipient: string;
  messageId: string;
  attempts: number;
  createdAt: string;
}

interface WireAuditRow {
  seq: number;
  action: string;
  actor: string;
  subject: string;
  prev_hash: string;
  hash: string;
  created_at: string;
}

interface WireDeadLetter {
  id: string;
  thread: string;
  recipient: string;
  messageId: string;
  attempts: number;
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
  /** Absent when the caller asked for include_payload=false. */
  payload?: unknown;
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
  /**
   * Trimmed, because the owner descriptor **signs** the workspace while HTTP
   * strips whitespace from around a header value in transit (RFC 9110 field
   * values carry no surrounding OWS). Sign `"ws_local "` and the hub
   * recomputes the descriptor with `"ws_local"`: the signature cannot verify,
   * and the hub answers `unauthenticated`.
   *
   * The symptom is miserable to diagnose, which is why this is fixed rather
   * than documented. The console's error then reads "check the workspace name,
   * that this is the owner key, and that your clock is right" — and the key,
   * the clock and the visible name are all correct. A trailing space from
   * copy-pasting a workspace id out of a terminal is enough, and the console's
   * workspace box is free text, so that is the normal way to fill it.
   */
  private readonly workspace: string;

  constructor(private readonly opts: OwnerClientOptions) {
    this.workspace = opts.workspace.trim();
    if (this.workspace === '') {
      throw new TypeError('workspace is required and cannot be only whitespace');
    }
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
    // include_payload is explicit: deciding an approval requires the payload,
    // because the hash that gets signed is recomputed from it.
    const res = await this.request<{ items: WireTask[] }>(
      'GET',
      `/v1/tasks?include_payload=true&limit=${limit}&state=needs-approval`,
    );
    return res.items.map(toTask);
  }

  /**
   * Every task in the workspace, for the board.
   *
   * Payloads are left out by default here — the inverse of the hub's default,
   * which stays `true` so older callers keep working. A board shows titles and
   * states; pulling a whole workspace of payloads to draw it is the one place
   * they would all cross the wire at once.
   */
  async listTasks(
    opts: { state?: string; limit?: number; includePayload?: boolean } = {},
  ): Promise<PendingTask[]> {
    const q = new URLSearchParams({
      limit: String(opts.limit ?? 200),
      include_payload: String(opts.includePayload ?? false),
    });
    if (opts.state !== undefined) q.set('state', opts.state);
    const res = await this.request<{ items: WireTask[] }>('GET', `/v1/tasks?${q.toString()}`);
    return res.items.map(toTask);
  }

  /**
   * Cancels a task as the owner.
   *
   * Legal only from a non-terminal state — the transition table decides, not
   * this method — and it notifies both the creator and the assignee.
   */
  async cancelTask(taskId: string): Promise<{ id: string; state: string }> {
    return this.request('DELETE', `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  /**
   * The audit chain, verified HERE rather than taken on trust.
   *
   * The hub also offers `/v1/audit/verify`, but that is the hub vouching for
   * its own log: a hub that rewrote a row would answer "intact" just as
   * readily. This fetches the rows and recomputes the chain with the shared
   * rule from `contracts`, so the verdict comes from the data rather than
   * from the party holding it.
   */
  async auditLog(limit = 200): Promise<{ rows: AuditEntry[]; verification: AuditVerification }> {
    const res = await this.request<{ items: WireAuditRow[] }>('GET', `/v1/audit?limit=${limit}`);
    const rows = res.items.map((r) => ({
      seq: r.seq,
      workspace: this.workspace,
      action: r.action,
      actor: r.actor,
      subject: r.subject,
      prevHash: r.prev_hash,
      hash: r.hash,
      createdAt: r.created_at,
    }));
    return { rows, verification: verifyAuditChain(rows) };
  }

  /** Deliveries that exhausted their retries. */
  async listDeadLetters(): Promise<DeadLetter[]> {
    const res = await this.request<{ items: WireDeadLetter[] }>('GET', '/v1/dlq');
    return res.items.map((d) => ({
      id: d.id,
      thread: d.thread,
      recipient: d.recipient,
      messageId: d.messageId,
      attempts: d.attempts,
      createdAt: d.createdAt,
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
        workspace: this.workspace,
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
        'x-agentbridge-workspace': this.workspace,
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

const toTask = (t: WireTask): PendingTask => ({
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
});

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
