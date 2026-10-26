import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, describe, it } from 'vitest';
import { openBlobStore } from '../adapters/fs/blob.js';
import { openS3BlobStore } from '../adapters/s3/blob.js';
import { describeBlobConformance } from './blob-conformance.js';

/**
 * Both `BlobStore` implementations, one spec.
 *
 * The filesystem store always runs. S3 runs against LocalStack when it is
 * reachable, which is the only way to judge the Phase 1 adapter without an AWS
 * account (`CLAUDE.md` §7 forbids touching a real one).
 *
 * The S3 half is SKIPPED rather than failed when LocalStack is absent, so
 * `make check` stays green on a machine without Docker. A silent skip is how a
 * suite passes vacuously, so it announces itself loudly, and `make test-aws`
 * refuses to run at all unless the endpoint answers — that target is what makes
 * "the S3 adapter passes conformance" a claim with evidence behind it.
 */

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const BUCKET = 'agentbridge-conformance';
const CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' };

const dirs: string[] = [];
const closers: (() => void)[] = [];

afterAll(() => {
  while (closers.length > 0) closers.pop()?.();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describeBlobConformance(
  'filesystem (Phase 0)',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-blob-'));
    dirs.push(dir);
    return openBlobStore(dir);
  },
  (suffix) => suffix,
);

const s3Reachable = await probeS3();

if (s3Reachable) {
  // A fresh prefix per run, because a bucket persists where a temp dir does not.
  const runPrefix = `run-${process.pid}-${process.hrtime.bigint().toString(36)}`;
  describeBlobConformance(
    'S3 via LocalStack (Phase 1)',
    () => {
      const store = openS3BlobStore({
        bucket: BUCKET,
        endpoint: ENDPOINT,
        forcePathStyle: true,
        credentials: CREDENTIALS,
      });
      closers.push(() => store.close());
      return store;
    },
    (suffix) => `${runPrefix}/${suffix}`,
  );
} else {
  describe('BlobStore conformance — S3 via LocalStack (Phase 1)', () => {
    it.skip(`SKIPPED: no S3 endpoint at ${ENDPOINT}. Run \`make test-aws\` with Docker.`, () => {
      /* not executed; the title is the report */
    });
  });
}

/**
 * Creates the bucket as the reachability probe, so a reachable-but-unusable
 * endpoint counts as unreachable rather than failing every case later.
 */
async function probeS3(): Promise<boolean> {
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: CREDENTIALS,
    maxAttempts: 1,
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    return true;
  } catch (err) {
    const name = (err as { name?: string }).name;
    // Already there from an earlier run: reachable, which is what we asked.
    if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') return true;
    return false;
  } finally {
    client.destroy();
  }
}
