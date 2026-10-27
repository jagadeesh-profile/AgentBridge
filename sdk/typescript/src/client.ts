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
  /**
   * The caller's current trace id, so the hub's work joins the same trace as
   * the agent that called it (spec §8).
   *
   * A function rather than a value, because an agent handling many tasks has
   * one trace per task, not one per client. Return `undefined` when there is
   * no active trace and the hub will mint one.
   *
   * Without this the SDK sent no `x-agentbridge-trace-id` at all — the only
   * header the hub reads a caller's trace from — so §8's "one trace spans both
   * agents" held for raw HTTP callers and quietly failed for every SDK user,
   * which is to say for the intended way to connect.
   */
  traceId?: () => string | undefined;
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

/**
 * The wire names of fields this SDK takes in camelCase, and what to use instead.
 *
 * Passing the wire name is a silent, dangerous mistake rather than a loud one.
 * `createTask({ side_effect: true })` is an excess property — TypeScript
 * rejects it, but JavaScript does not, and the SDK then applied its
 * `?? false` default: the task was created **ungated** and the assignee ran
 * the side effect with no owner approval. That is the single failure
 * `CLAUDE.md` §1.3 exists to prevent, and the contract explicitly says
 * `side_effect` may not be defaulted.
 *
 * The confusion is structural, not careless: the wire contract, the generated
 * OpenAPI, the CLI and every document use snake_case, and only this client
 * uses camelCase. So the guard covers every such pair rather than the one
 * field that happened to be noticed — `due_at` and `idempotency_key` fail the
 * same way, just less expensively.
 */
const WIRE_NAME_HINTS: Readonly<Record<string, string>> = {
  side_effect: 'sideEffect',
  due_at: 'dueAt',
  idempotency_key: 'idempotencyKey',
  content_type: 'contentType',
  trace_id: 'traceId',
  blob_key: 'blobKey',
  up_to: 'upTo',
};

/**
 * Refuses an input carrying a wire-cased key. Throws rather than translating:
 * accepting both spellings would leave the ambiguity in place, and the whole
 * problem is that the two look interchangeable.
 */
function assertNoWireNames(method: string, input: object): void {
  for (const key of Object.keys(input)) {
    const correct = WIRE_NAME_HINTS[key];
    if (correct !== undefined) {
      throw new TypeError(
        `${method}: "${key}" is the wire field name; this SDK takes "${correct}". ` +
          `Passing "${key}" would have been ignored silently` +
          (key === 'side_effect' ? ' — and the task created WITHOUT the approval gate.' : '.'),
      );
    }
  }
}

/** W3C trace id: 16 bytes of lowercase hex. The hub rejects anything else. */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

export class Client {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly now: () => Date;
  private readonly workspace: string;
  private readonly agent: string;

  constructor(private readonly opts: ClientOptions) {
    // Trimmed for the reason spelled out in OwnerClient: HTTP strips
    // whitespace around a header value, so a padded id signed or looked up
    // verbatim disagrees with what the hub receives.
    //
    // The agent descriptor does not sign the workspace, so the failure here is
    // milder but just as confusing: the hub looks up (workspace, ref), the
    // trimmed pair matches no agent, and the answer is `unauthenticated` —
    // pointing at the key, when the key was never the problem.
    this.workspace = opts.workspace.trim();
    this.agent = opts.agent.trim();
    if (this.workspace === '' || this.agent === '') {
      throw new TypeError('workspace and agent are required and cannot be only whitespace');
    }
    // Bound for the same reason as OwnerClient: an unbound global called as
    // `this.fetchImpl(...)` fails in a browser, and this client is usable
    // from one even though Phase 0 only runs it in Node.
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.now = opts.now ?? (() => new Date());
  }

  get ref(): string {
    return this.agent;
  }

  async send(input: {
    thread: string;
    to: readonly string[];
    body: unknown;
    sideEffect?: boolean;
    idempotencyKey?: string;
  }): Promise<{ id: string }> {
    assertNoWireNames('send', input);
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
    assertNoWireNames('createTask', input);
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
    assertNoWireNames('putArtifact', input);
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
    // Guarded here as well as in createTask: a caller passing
    // `side_effect: false` to THIS method is expressing an intent the method
    // name contradicts, and spreading it through would silently win.
    assertNoWireNames('requestApproval', input);
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

  /**
   * The trace header, or nothing.
   *
   * Throws on a malformed id rather than sending it. The hub replaces a bad
   * id and logs a warning server-side, so the caller would believe its traces
   * were joined while they silently were not — the same shape of bug as a
   * dropped `side_effect`, and just as invisible from the agent's side.
   */
  private traceHeader(): Record<string, string> {
    const id = this.opts.traceId?.();
    if (id === undefined || id === '') return {};
    if (!TRACE_ID_PATTERN.test(id)) {
      throw new TypeError(
        `traceId() returned "${id}", which is not a 32-character lowercase hex ` +
          'trace id. The hub would discard it and your traces would not join.',
      );
    }
    return { 'x-agentbridge-trace-id': id };
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
            'x-agentbridge-workspace': this.workspace,
            'x-agentbridge-agent': this.agent,
            'x-agentbridge-timestamp': timestamp,
            'x-agentbridge-signature': signature,
            // Deliberately outside the signed descriptor, which covers method,
            // path, query, body hash and timestamp only. Adding a header to
            // that set would be a contract change; the trace id is a hint for
            // correlation, carries no authority, and the hub validates its
            // shape and discards anything malformed.
            ...this.traceHeader(),
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
