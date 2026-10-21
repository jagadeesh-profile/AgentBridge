import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import * as ed from '@noble/ed25519';
import {
  canonicalize,
  ownerRequestDescriptor,
  payloadHash,
  registrationDescriptor,
  signDescriptor,
} from '@agentbridge/contracts';
import { Client, OwnerClient, publicKeyBase64 } from '@agentbridge/sdk';

const run = promisify(execFile);

export const IMAGE = process.env.AGENTBRIDGE_IMAGE ?? 'agentbridge-hub:e2e';
export const CONTAINER = 'agentbridge-e2e';
export const PORT = Number(process.env.AGENTBRIDGE_TEST_PORT ?? 18099);
export const WORKSPACE = 'ws_container';

export interface ContainerHarness {
  baseUrl: string;
  /** Registers over the real HTTP API and returns the agent's private key. */
  register: (name: string, scopes: string[], webhookUrl?: string) => Promise<Uint8Array>;
  client: (name: string, privateKey: Uint8Array) => Client;
  /** The owner's client: queue, board, roster, kill switch, audit. */
  owner: OwnerClient;
  ownerApprove: (
    taskId: string,
    decision?: 'approve' | 'reject',
  ) => Promise<{ status: number; code: string | null }>;
  /** Signs an owner decision over a hash the caller picks — for negatives. */
  ownerApproveWithHash: (
    taskId: string,
    hash: string,
  ) => Promise<{ status: number; code: string | null }>;
  /**
   * Owner-signs the REQUEST but sends the decision body verbatim, so a test
   * can vary the body's own signature independently of request auth.
   */
  postDecision: (
    decisionBody: Record<string, unknown>,
  ) => Promise<{ status: number; code: string | null }>;
  restart: () => Promise<void>;
  logs: () => Promise<string>;
  stop: () => Promise<void>;
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await run('docker', ['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch {
    return false;
  }
}

async function silent(args: string[]): Promise<void> {
  try {
    await run('docker', args);
  } catch {
    // Teardown of something that is not there is not a failure.
  }
}

async function waitHealthy(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'never responded';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`container never became healthy on ${baseUrl}: ${lastError}`);
}

/**
 * Builds the image, starts it, and waits for it to serve.
 *
 * Everything here goes through the published HTTP API — no Store handle exists
 * on this side of the container boundary, which is the point: this suite tests
 * the artifact that would actually be deployed, including its env contract,
 * its entrypoint and its volume.
 */
export async function startContainer(): Promise<ContainerHarness> {
  const ownerPriv = ed.utils.randomPrivateKey();
  const ownerPub = await ed.getPublicKeyAsync(ownerPriv);
  const baseUrl = `http://127.0.0.1:${PORT}`;

  await run('docker', ['build', '-t', IMAGE, '.'], { maxBuffer: 64 * 1024 * 1024 });

  // A fresh volume per run, so "survives a restart" means what it says and no
  // earlier run's state can make a test pass.
  const volume = `agentbridge-e2e-${randomBytes(4).toString('hex')}`;
  await silent(['rm', '-f', CONTAINER]);

  await run('docker', [
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-p',
    `${PORT}:8080`,
    '-e',
    `AGENTBRIDGE_OWNER_PUBLIC_KEY=${publicKeyBase64(ownerPub)}`,
    '-e',
    'DELIVERY_INTERVAL_MS=300',
    '-e',
    // info, not warn: the body-redaction test is only meaningful if there are
    // request logs to search. At warn it passed against an empty log.
    'LOG_LEVEL=info',
    '-v',
    `${volume}:/data`,
    IMAGE,
  ]);

  await waitHealthy(baseUrl);

  const client = (name: string, privateKey: Uint8Array): Client =>
    new Client({ baseUrl, workspace: WORKSPACE, agent: `agent:${name}`, privateKey });

  const register = async (
    name: string,
    scopes: string[],
    webhookUrl?: string,
  ): Promise<Uint8Array> => {
    const priv = ed.utils.randomPrivateKey();
    const publicKey = publicKeyBase64(await ed.getPublicKeyAsync(priv));
    const issuedAt = new Date().toISOString();
    const res = await fetch(`${baseUrl}/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': WORKSPACE,
        'x-agentbridge-timestamp': issuedAt,
        // Enrolment is authorised by the OWNER's signature (ADR 0005).
        'x-agentbridge-owner-signature': await signDescriptor(
          registrationDescriptor({
            workspace: WORKSPACE,
            name,
            publicKey,
            scopes,
            ...(webhookUrl === undefined ? {} : { webhookUrl }),
            issuedAt,
          }),
          ownerPriv,
        ),
      },
      body: JSON.stringify({
        name,
        capabilities: { skills: [], input: ['text', 'json'], output: ['text', 'json'] },
        public_key: publicKey,
        scopes,
        ...(webhookUrl === undefined ? {} : { webhook_url: webhookUrl }),
      }),
    });
    if (!res.ok) throw new Error(`register ${name} failed: ${res.status} ${await res.text()}`);
    return priv;
  };

  const sign = async (taskId: string, decision: string, hash: string) => {
    const issuedAt = new Date().toISOString();
    const sig = await ed.signAsync(
      new TextEncoder().encode(
        canonicalize({ task: taskId, decision, payload_hash: hash, issued_at: issuedAt }),
      ),
      ownerPriv,
    );
    return { issuedAt, sig: `ed25519:${Buffer.from(sig).toString('base64')}` };
  };

  /**
   * Posts an owner decision over a hash the caller chose.
   *
   * Signed and sent by hand rather than through OwnerClient.decide, which
   * always recomputes the hash from the payload — these tests need to put a
   * chosen hash on the wire to prove the HUB enforces the binding rather than
   * relying on a well-behaved client. The request itself is owner-signed
   * (ADR 0006); it used to ride on a borrowed agent identity.
   */
  const ownerClient = new OwnerClient({ baseUrl, workspace: WORKSPACE, privateKey: ownerPriv });

  const postDecision = async (
    decisionBody: Record<string, unknown>,
  ): Promise<{ status: number; code: string | null }> => {
    const issuedAt = new Date().toISOString();
    const body = JSON.stringify(decisionBody);
    const requestSig = await signDescriptor(
      ownerRequestDescriptor({
        method: 'POST',
        path: '/v1/approvals',
        query: {},
        body,
        workspace: WORKSPACE,
        issuedAt,
      }),
      ownerPriv,
    );
    const res = await fetch(`${baseUrl}/v1/approvals`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-workspace': WORKSPACE,
        'x-agentbridge-timestamp': issuedAt,
        'x-agentbridge-owner-signature': requestSig,
      },
      body,
    });
    if (res.ok) return { status: res.status, code: null };
    const parsed = (await res.json()) as { error?: { code?: string } };
    return { status: res.status, code: parsed.error?.code ?? null };
  };

  const submit = async (
    taskId: string,
    decision: 'approve' | 'reject',
    hash: string,
  ): Promise<{ status: number; code: string | null }> => {
    const { issuedAt, sig } = await sign(taskId, decision, hash);
    return postDecision({
      task: taskId,
      decision,
      payload_hash: hash,
      issued_at: issuedAt,
      sig,
    });
  };

  return {
    baseUrl,
    register,
    client,
    owner: ownerClient,

    ownerApprove: async (taskId, decision = 'approve') => {
      // Read from the owner's own queue, with payloads, so the hash signed is
      // derived from what the owner would have been shown.
      const task = (await ownerClient.listPendingApprovals()).find((t) => t.id === taskId);
      if (task === undefined) throw new Error(`${taskId} is not awaiting approval`);
      return submit(taskId, decision, payloadHash(task.payload));
    },

    ownerApproveWithHash: async (taskId, hash) => submit(taskId, 'approve', hash),

    postDecision,

    restart: async () => {
      await run('docker', ['restart', CONTAINER]);
      await waitHealthy(baseUrl);
    },

    logs: async () => {
      const { stdout, stderr } = await run('docker', ['logs', CONTAINER], {
        maxBuffer: 16 * 1024 * 1024,
      });
      return `${stdout}\n${stderr}`;
    },

    stop: async () => {
      await silent(['rm', '-f', CONTAINER]);
      await silent(['volume', 'rm', '-f', volume]);
    },
  };
}
