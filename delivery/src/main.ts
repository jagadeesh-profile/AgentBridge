#!/usr/bin/env node
/**
 * The Phase 0 composition root: the one place that wires the hub library to
 * concrete adapters and starts the delivery worker beside it.
 *
 * It lives in `delivery` rather than `hub` because delivery already depends on
 * hub, and putting the bootstrap in hub would make the two packages mutually
 * dependent — which pnpm tolerates but TypeScript project references do not.
 * The hub stays a library that knows nothing about the worker.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ulid } from 'ulid';
import {
  buildApp,
  initTelemetry,
  openBlobStore,
  openS3BlobStore,
  openStore,
  shutdownTelemetry,
  telemetryOptionsFromEnv,
  type Clock,
  type IdGen,
} from '@agentbridge/hub';
import { makeWorker } from './worker.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    // Fail at startup, not at the first approval. A hub that accepted
    // approvals against a placeholder owner key would be worse than one that
    // refuses to boot.
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const dbPath = process.env.AGENTBRIDGE_DB ?? './data/agentbridge.sqlite';
  const artifactDir = process.env.AGENTBRIDGE_ARTIFACTS ?? './data/artifacts';
  const port = Number(process.env.PORT ?? 8080);

  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(artifactDir, { recursive: true });

  const ownerPublicKey = new Uint8Array(
    Buffer.from(required('AGENTBRIDGE_OWNER_PUBLIC_KEY'), 'base64'),
  );
  if (ownerPublicKey.length !== 32) {
    throw new Error('AGENTBRIDGE_OWNER_PUBLIC_KEY must be a base64 Ed25519 public key (32 bytes)');
  }

  // Tracing first, so startup spans are captured. With no OTLP endpoint
  // configured this is a no-op and the hub needs no collector.
  const telemetry = initTelemetry(telemetryOptionsFromEnv());

  const store = openStore(dbPath);
  const clock: Clock = { now: () => new Date() };
  const ids: IdGen = { ulid: (prefix) => `${prefix}_${ulid()}` };
  // Artifacts go to S3 when a bucket is configured, and to the local
  // filesystem otherwise. Both satisfy the same `BlobStore` port and the same
  // conformance suite (ADR 0009), so this is the only line that knows which.
  // Phase 1's single-writer topology (ADR 0010) keeps SQLite on a volume but
  // has no reason to keep artifact bytes there.
  const artifactBucket = process.env.AGENTBRIDGE_ARTIFACT_BUCKET;
  const blob =
    artifactBucket === undefined || artifactBucket === ''
      ? openBlobStore(artifactDir)
      : openS3BlobStore({
          bucket: artifactBucket,
          ...(process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION }),
          // Set only for LocalStack; unset against real S3.
          ...(process.env.AWS_ENDPOINT_URL === undefined
            ? {}
            : { endpoint: process.env.AWS_ENDPOINT_URL, forcePathStyle: true }),
        });

  const app = await buildApp(
    {
      store,
      clock,
      ids,
      blob,
      ownerPublicKey,
    },
    {
      // The address remote agents reach this hub at, published in the A2A
      // Agent Card. Without it the card advertised http://localhost:8080 —
      // correct for the pilot on one machine, useless to any remote agent,
      // and invisible to every local test until the A2A conformance suite
      // checked it.
      ...(process.env.AGENTBRIDGE_PUBLIC_URL === undefined
        ? {}
        : { publicUrl: process.env.AGENTBRIDGE_PUBLIC_URL }),
    },
  );

  // Phase 0 runs delivery in-process. DELIVERY_MODE=worker runs only the
  // worker; =api serves without one (spec §2.4).
  const mode = process.env.DELIVERY_MODE ?? 'inline';
  const worker =
    mode === 'api'
      ? null
      : makeWorker(
          { store, clock },
          { intervalMs: Number(process.env.DELIVERY_INTERVAL_MS ?? 1000) },
        );

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    worker?.stop();
    await app.close();
    await shutdownTelemetry();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (mode === 'worker') {
    app.log.info('delivery worker only; not serving HTTP');
    return;
  }

  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(
    { port, dbPath, artifactDir, mode, tracing: telemetry.enabled },
    'agentbridge hub listening',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `hub failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
