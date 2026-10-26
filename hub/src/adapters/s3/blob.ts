import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { BlobStore } from '../../ports/index.js';

/**
 * S3 artifact store for Phase 1, implementing the same `BlobStore` port as the
 * Phase 0 filesystem adapter (spec §4.1).
 *
 * This is the only one of the three "small" Phase 1 adapters that is genuinely
 * one new file. `BlobStore.put`/`get` already return promises, so there is no
 * sync boundary to cross and no read-modify-write to make atomic — see ADR 0009
 * for why `Queue` (SQS) and `Store` (DynamoDB) are not in the same position.
 *
 * Behaviour is kept deliberately identical to the filesystem adapter, including
 * the rejected-key rules and the `no such blob` message, because the domain is
 * written against the port and must not be able to tell which one it has.
 */
export interface S3BlobStoreOptions {
  bucket: string;
  region?: string;
  /** Set for LocalStack or any S3-compatible endpoint. */
  endpoint?: string;
  /** Required by LocalStack path addressing; harmless against real S3. */
  forcePathStyle?: boolean;
  /** Per-request ceiling. §4 requires a timeout on every network call. */
  timeoutMs?: number;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function openS3BlobStore(opts: S3BlobStoreOptions): BlobStore & { close(): void } {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const client = new S3Client({
    region: opts.region ?? 'us-east-1',
    ...(opts.endpoint === undefined ? {} : { endpoint: opts.endpoint }),
    ...(opts.forcePathStyle === undefined ? {} : { forcePathStyle: opts.forcePathStyle }),
    ...(opts.credentials === undefined ? {} : { credentials: opts.credentials }),
    // The SDK's default retry mode is exponential backoff with jitter, which is
    // what §4 asks for. Pinned explicitly rather than inherited so a change in
    // SDK defaults cannot silently turn one failed PUT into a long stall.
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: timeout,
      requestTimeout: timeout,
    }),
  });

  return {
    async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: assertKey(key),
          Body: bytes,
          // The filesystem adapter has nowhere to put this; S3 does, and an
          // artifact served back with the wrong type is a real bug.
          ContentType: contentType,
        }),
      );
    },

    async get(key: string): Promise<Uint8Array> {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: opts.bucket, Key: assertKey(key) }),
        );
        if (res.Body === undefined) throw new Error(`no such blob: ${key}`);
        return await res.Body.transformToByteArray();
      } catch (err) {
        if (isNotFound(err)) {
          // Same message as the filesystem adapter, so domain code that
          // matches on it keeps working after the migration.
          throw new Error(`no such blob: ${key}`);
        }
        throw err;
      }
    },

    close(): void {
      client.destroy();
    },
  };
}

/**
 * S3 has no filesystem to escape, but the key rules are enforced anyway so the
 * two adapters accept and refuse exactly the same set. A key like
 * `../../etc/passwd` is meaningless in a bucket rather than dangerous — the
 * reason to refuse it is that silently storing an object the filesystem adapter
 * would have rejected makes the adapters non-interchangeable, which is the one
 * property the port exists to provide.
 */
function assertKey(key: string): string {
  if (key === '' || key.startsWith('/')) {
    throw new Error(`invalid blob key: ${key}`);
  }
  const parts = key.split(/[\\/]/);
  if (parts.some((p) => p === '..')) {
    throw new Error(`blob key resolves outside the artifact directory: ${key}`);
  }
  return key;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  const status = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}
