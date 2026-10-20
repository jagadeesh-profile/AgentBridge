import { readFile, writeFile } from 'node:fs/promises';
import { Client, type ClientOptions, type InboxItem } from './client.js';
import type { Untrusted } from './untrusted.js';

export interface TaskDelivery<T = unknown> {
  id: string;
  thread: string;
  type: string;
  task: string | null;
  /** Agent content. Call .unwrap() — it is data, never instructions. */
  payload: Untrusted<T>;
}

export interface ArtifactResult {
  name: string;
  kind: 'text' | 'json' | 'file' | 'link';
  contentType?: string;
  inline?: unknown;
}

export type TaskHandler = (
  delivery: TaskDelivery,
) => Promise<{ artifact?: ArtifactResult } | void> | { artifact?: ArtifactResult } | void;

export interface AgentOptions extends ClientOptions {
  /** Where to persist the inbox cursor so a restart resumes. */
  cursorPath?: string;
  pollIntervalMs?: number;
}

/**
 * A long-running agent. Polls the inbox, hands each item to the handler, and
 * acknowledges ONLY after the handler resolves — a thrown handler leaves the
 * item unacknowledged so it is redelivered rather than silently dropped.
 */
export class Agent {
  private readonly client: Client;
  private handler: TaskHandler | null = null;
  private cursor: string | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: AgentOptions) {
    this.client = new Client(opts);
  }

  get ref(): string {
    return this.client.ref;
  }

  onTask(handler: TaskHandler): this {
    this.handler = handler;
    return this;
  }

  async start(): Promise<void> {
    if (this.handler === null) throw new Error('call onTask(handler) before start()');
    this.cursor = await this.loadCursor();
    this.running = true;

    const interval = this.opts.pollIntervalMs ?? 2000;
    this.timer = setInterval(() => {
      void this.poll();
    }, interval);
    this.timer.unref();
    await this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One polling pass. Exposed so tests and the pilot script can drive it. */
  async poll(): Promise<number> {
    if (this.handler === null) return 0;
    const page = await this.client.listInbox(this.cursor === null ? {} : { since: this.cursor });
    if (page.items.length === 0) return 0;

    let handled = 0;
    // Sequential, not concurrent: within a thread the hub guarantees order, and
    // processing in parallel would throw that away.
    for (const item of page.items) {
      await this.handle(item);
      handled += 1;
      // Ack one at a time so a mid-page failure does not acknowledge the rest.
      await this.client.ack(item.id);
      this.cursor = item.id;
      await this.saveCursor(item.id);
    }
    return handled;
  }

  private async handle(item: InboxItem): Promise<void> {
    if (this.handler === null) return;
    const result = await this.handler({
      id: item.id,
      thread: item.thread,
      type: item.type,
      task: item.task,
      payload: item.body,
    });

    if (result && 'artifact' in result && result.artifact !== undefined && item.task !== null) {
      const a = result.artifact;
      await this.client.putArtifact({
        task: item.task,
        kind: a.kind,
        name: a.name,
        contentType: a.contentType ?? 'application/json',
        ...(a.inline === undefined ? {} : { inline: a.inline }),
      });
      await this.client.updateTask(item.task, 'accepted');
      await this.client.updateTask(item.task, 'working');
      await this.client.updateTask(item.task, 'completed');
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async loadCursor(): Promise<string | null> {
    if (this.opts.cursorPath === undefined) return null;
    try {
      const text = await readFile(this.opts.cursorPath, 'utf8');
      const parsed = JSON.parse(text) as { cursor?: string };
      return parsed.cursor ?? null;
    } catch {
      return null;
    }
  }

  private async saveCursor(cursor: string): Promise<void> {
    if (this.opts.cursorPath === undefined) return;
    await writeFile(this.opts.cursorPath, JSON.stringify({ cursor }), 'utf8');
  }
}
