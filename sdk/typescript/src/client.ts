import { AgentBridgeError, requestDescriptor, signDescriptor } from '@agentbridge/contracts';
import type { ErrorCode } from '@agentbridge/contracts';
import { ulid } from 'ulid';
import { fromWire, type Untrusted } from './untrusted.js';

export interface ClientOptions {
  baseUrl: string;
  workspace: string;
  agent: string;
  privateKey: Uint8Array;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Retries apply to 5xx and transport errors only — never to a 4xx. */
  maxRetries?: number;
  now?: () => Date;
}

export interface InboxItem<T = unknown> {
  id: string;
  thread: string;
  type: string;
  task: string | null;
  body: Untrusted<T>;
  createdAt: string;
}

export interface TaskView {
  id: string;
  thread: string;
  creator: string;
  assignee: string;
  title: string;
  payload: unknown;
  payloadHash: string;
  state: string;
  sideEffect: boolean;
}

interface WireError {
  error?: { code?: string; message?: string; trace_id?: string };
}

export class Client {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly now: () => Date;

  constructor(private readonly opts: ClientOptions) {
    // Bound for the same reason as OwnerClient: an unbound global called as
    // `this.fetchImpl(...)` fails in a browser, and this client is usable
    // from one even though Phase 0 only runs it in Node.
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.now = opts.now ?? (() => new Date());
  }

  get ref(): string {
    return this.opts.agent;
  }

  async send(input: {
    thread: string;
    to: readonly string[];
    body: unknown;
    sideEffect?: boolean;
    idempotencyKey?: string;
  }): Promise<{ id: string }> {
    return this.request('POST', '/v1/messages', {
      thread: input.thread,
      to: input.to,
      body: input.body,
      side_effect: input.sideEffect ?? false,
      // Always send a key: the hub treats a keyed replay as a safe retry, and
      // an unkeyed one as a replay attack.
      idempotency_key: input.idempotencyKey ?? ulid(),
    });
  }

  async createTask(input: {
    thread: string;
    assignee: string;
    title: string;
    payload: unknown;
    sideEffect?: boolean;
    dueAt?: string;
    idempotencyKey?: string;
  }): Promise<TaskView> {
    return this.request('POST', '/v1/tasks', {
      thread: input.thread,
      assignee: input.assignee,
      title: input.title,
      payload: input.payload,
      side_effect: input.sideEffect ?? false,
      ...(input.dueAt === undefined ? {} : { due_at: input.dueAt }),
      idempotency_key: input.idempotencyKey ?? ulid(),
    });
  }

  async updateTask(
    taskId: string,
    state: string,
    opts: { note?: string; idempotencyKey?: string } = {},
  ): Promise<TaskView> {
    return this.request('PATCH', `/v1/tasks/${encodeURIComponent(taskId)}`, {
      state,
      ...(opts.note === undefined ? {} : { note: opts.note }),
      idempotency_key: opts.idempotencyKey ?? ulid(),
    });
  }

  async getTask(taskId: string): Promise<TaskView> {
    return this.request('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async putArtifact(input: {
    task: string;
    kind: 'text' | 'json' | 'file' | 'link';
    name: string;
    contentType: string;
    inline?: unknown;
    idempotencyKey?: string;
  }): Promise<{ id: string; version: number }> {
    return this.request('POST', '/v1/artifacts', {
      task: input.task,
      kind: input.kind,
      name: input.name,
      content_type: input.contentType,
      ...(input.inline === undefined ? {} : { inline: input.inline }),
      idempotency_key: input.idempotencyKey ?? ulid(),
    });
  }

  /** Asks the owner to approve a side effect by creating a gated task. */
  async requestApproval(input: {
    thread: string;
    assignee: string;
    title: string;
    payload: unknown;
    idempotencyKey?: string;
  }): Promise<TaskView> {
    return this.createTask({ ...input, sideEffect: true });
  }

  async listInbox(opts: { since?: string; limit?: number } = {}): Promise<{
    items: InboxItem[];
    cursor: string | null;
  }> {
    const params = new URLSearchParams();
    if (opts.since !== undefined) params.set('since', opts.since);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();

    const page = await this.request<{
      items: {
        id: string;
        thread: string;
        type: string;
        task: string | null;
        body: unknown;
        created_at: string;
      }[];
      cursor: string | null;
    }>('GET', `/v1/inbox${qs === '' ? '' : `?${qs}`}`);

    return {
      items: page.items.map((raw) => ({
        id: raw.id,
        thread: raw.thread,
        type: raw.type,
        task: raw.task,
        body: fromWire(raw.body),
        createdAt: raw.created_at,
      })),
      cursor: page.cursor,
    };
  }

  async ack(upTo: string): Promise<{ acked: number }> {
    return this.request('POST', '/v1/inbox/ack', { up_to: upTo });
  }

  /**
   * Submits an owner-signed approval decision.
   *
   * Two signatures are in play and they do different jobs: `sig` is the OWNER's
   * signature over the decision, which the hub verifies against the owner key;
   * the HTTP request itself is signed by this client's agent key, like every
   * other call.
   */
  async decideApproval(input: {
    task: string;
    decision: 'approve' | 'reject';
    payloadHash: string;
    issuedAt: string;
    sig: string;
  }): Promise<{ id: string; state: string }> {
    return this.request('POST', '/v1/approvals', {
      task: input.task,
      decision: input.decision,
      payload_hash: input.payloadHash,
      issued_at: input.issuedAt,
      sig: input.sig,
    });
  }

  /** The kill switch: revokes an agent's key and drops its pending deliveries. */
  async revokeAgentKey(ref: string): Promise<{ revoked: string }> {
    return this.request('DELETE', `/v1/agents/${encodeURIComponent(ref)}/key`);
  }

  private async request<T>(method: string, pathWithQuery: string, bodyObj?: unknown): Promise<T> {
    const [bare, qs] = pathWithQuery.split('?');
    const path = bare ?? pathWithQuery;
    const query: Record<string, string> = {};
    if (qs !== undefined) {
      for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
    }
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      // Re-sign per attempt: the timestamp is inside the signed material, so a
      // retry minutes later must not reuse the first signature.
      const timestamp = this.now().toISOString();
      const signature = await signDescriptor(
        requestDescriptor({ method, path, query, body, timestamp }),
        this.opts.privateKey,
      );

      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl}${pathWithQuery}`, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-agentbridge-workspace': this.opts.workspace,
            'x-agentbridge-agent': this.opts.agent,
            'x-agentbridge-timestamp': timestamp,
            'x-agentbridge-signature': signature,
          },
          ...(bodyObj === undefined ? {} : { body }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (res.ok) return (await res.json()) as T;

        // A 4xx is the caller's fault and will not improve on retry.
        if (res.status < 500) throw await toTypedError(res);

        lastError = await toTypedError(res);
      } catch (err) {
        if (err instanceof AgentBridgeError) throw err;
        lastError = err;
      }

      if (attempt < this.maxRetries) {
        await sleep(2 ** attempt * 100 + Math.floor(Math.random() * 100));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`request failed: ${method} ${pathWithQuery}`);
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
    return new AgentBridgeError(code as ErrorCode, parsed.error?.trace_id);
  }
  return new Error(`hub returned ${res.status}: ${parsed.error?.message ?? res.statusText}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
