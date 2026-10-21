import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import * as ed from '@noble/ed25519';
import { ulid } from 'ulid';
import { buildApp, openBlobStore, openStore, type SqliteStore } from '@agentbridge/hub';
import { makeWorker, type Worker } from '@agentbridge/delivery';
import { canonicalize, payloadHash } from '@agentbridge/contracts';
import { Client } from '@agentbridge/sdk';

export interface Harness {
  baseUrl: string;
  store: SqliteStore;
  app: FastifyInstance;
  worker: Worker;
  claude: Client;
  muse: Client;
  museKey: Uint8Array;
  /** Signs an owner decision over the task's CURRENT payload. */
  ownerApprove: (taskId: string, decision?: 'approve' | 'reject') => Promise<unknown>;
  /** Signs a decision over a hash the caller chooses — for negative tests. */
  ownerApproveWithHash: (taskId: string, hash: string) => Promise<Response>;
  registerAgent: (name: string, webhookUrl?: string | null) => Promise<Uint8Array>;
  stop: () => Promise<void>;
}

/**
 * Boots a REAL hub — SQLite on disk, filesystem artifacts, the delivery worker
 * — on an ephemeral port. Not the in-memory fakes: these tests exist to catch
 * what only appears when the actual adapters are in play.
 */
export async function startHarness(workspace = 'ws_e2e'): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ab-e2e-'));
  const store = openStore(join(dir, 'e2e.sqlite'));
  const blob = openBlobStore(join(dir, 'artifacts'));
  const clock = { now: (): Date => new Date() };
  const ids = { ulid: (prefix: string): string => `${prefix}_${ulid()}` };

  const ownerPriv = ed.utils.randomPrivateKey();
  const ownerPub = await ed.getPublicKeyAsync(ownerPriv);

  const app = await buildApp(
    { store, clock, ids, blob, ownerPublicKey: ownerPub },
    { logger: false, rateLimitMax: 5000 },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const registerAgent = async (
    name: string,
    webhookUrl: string | null = null,
  ): Promise<Uint8Array> => {
    const priv = ed.utils.randomPrivateKey();
    store.putAgent({
      ref: `agent:${name}`,
      workspace,
      name,
      publicKey: Buffer.from(await ed.getPublicKeyAsync(priv)).toString('base64'),
      webhookUrl,
      webhookSecret: webhookUrl === null ? null : 'e2e-secret',
      scopes: ['read', 'message', 'create_task', 'write_artifact', 'request_side_effect'],
      keyStatus: 'active',
      capabilities: {},
      createdAt: new Date().toISOString(),
    });
    return priv;
  };

  const claudeKey = await registerAgent('claude');
  const museKey = await registerAgent('muse');
  const mk = (agent: string, privateKey: Uint8Array): Client =>
    new Client({ baseUrl, workspace, agent, privateKey });

  const claude = mk('agent:claude', claudeKey);
  const muse = mk('agent:muse', museKey);

  const signDecision = async (taskId: string, decision: string, hash: string) => {
    const issuedAt = new Date().toISOString();
    const sig = await ed.signAsync(
      new TextEncoder().encode(
        canonicalize({ task: taskId, decision, payload_hash: hash, issued_at: issuedAt }),
      ),
      ownerPriv,
    );
    return { issuedAt, sig: `ed25519:${Buffer.from(sig).toString('base64')}` };
  };

  const worker = makeWorker({ store, clock }, {});

  return {
    baseUrl,
    store,
    app,
    worker,
    claude,
    muse,
    museKey,
    registerAgent,

    ownerApprove: async (taskId, decision = 'approve') => {
      const task = await claude.getTask(taskId);
      const hash = payloadHash(task.payload);
      const { issuedAt, sig } = await signDecision(taskId, decision, hash);
      return claude.decideApproval({ task: taskId, decision, payloadHash: hash, issuedAt, sig });
    },

    ownerApproveWithHash: async (taskId, hash) => {
      const { issuedAt, sig } = await signDecision(taskId, 'approve', hash);
      try {
        await claude.decideApproval({
          task: taskId,
          decision: 'approve',
          payloadHash: hash,
          issuedAt,
          sig,
        });
        return { status: 200, code: null };
      } catch (err) {
        const code = err instanceof Error && 'code' in err ? String(err.code) : null;
        const status =
          err instanceof Error && 'status' in err ? Number(err.status) : code === null ? 500 : 409;
        return { status, code };
      }
    },

    stop: async () => {
      worker.stop();
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
