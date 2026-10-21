import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import * as ed from '@noble/ed25519';
import { ulid } from 'ulid';
import { buildApp, openBlobStore, openStore, type SqliteStore } from '@agentbridge/hub';
import { makeWorker, type Worker } from '@agentbridge/delivery';
import { canonicalize, ownerRequestDescriptor, signDescriptor } from '@agentbridge/contracts';
import { Client, OwnerClient } from '@agentbridge/sdk';

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
  /** The owner's client: approvals, the queue and the kill switch (ADR 0006). */
  owner: OwnerClient;
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
    {
      store,
      clock,
      ids,
      blob,
      ownerPublicKey: ownerPub,
    },
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

  const owner = new OwnerClient({ baseUrl, workspace, privateKey: ownerPriv });

  const worker = makeWorker({ store, clock }, {});

  return {
    baseUrl,
    owner,
    store,
    app,
    worker,
    claude,
    muse,
    museKey,
    registerAgent,

    // The owner acts with the owner key alone (ADR 0006).
    ownerApprove: async (taskId, decision = 'approve') => {
      const task = (await owner.listPendingApprovals()).find((t) => t.id === taskId);
      if (task === undefined) throw new Error(`${taskId} is not awaiting approval`);
      return owner.decide(task, decision);
    },

    // Deliberately bypasses OwnerClient.decide, which always recomputes the
    // hash: this test needs to put a chosen hash on the wire to prove the hub
    // enforces the binding itself rather than relying on a well-behaved client.
    ownerApproveWithHash: async (taskId, hash) => {
      const { issuedAt, sig } = await signDecision(taskId, 'approve', hash);
      const body = JSON.stringify({
        task: taskId,
        decision: 'approve',
        payload_hash: hash,
        issued_at: issuedAt,
        sig,
      });
      const requestSig = await signDescriptor(
        ownerRequestDescriptor({
          method: 'POST',
          path: '/v1/approvals',
          query: {},
          body,
          workspace,
          issuedAt,
        }),
        ownerPriv,
      );
      const res = await fetch(`${baseUrl}/v1/approvals`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agentbridge-workspace': workspace,
          'x-agentbridge-timestamp': issuedAt,
          'x-agentbridge-owner-signature': requestSig,
        },
        body,
      });
      if (res.ok) return { status: res.status, code: null };
      const parsed = (await res.json()) as { error?: { code?: string } };
      return { status: res.status, code: parsed.error?.code ?? null };
    },

    stop: async () => {
      worker.stop();
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
