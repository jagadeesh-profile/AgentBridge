import { describe, expect, it } from 'vitest';
import type { BlobStore } from './index.js';

/**
 * One behavioural spec every `BlobStore` implementation must satisfy.
 *
 * The same argument as `store-conformance.ts` (ADR 0008): the hub is written
 * against the port, so Phase 0's filesystem store and Phase 1's S3 store must
 * be indistinguishable from the domain's side. An artifact that round-trips on
 * disk and 404s in S3 would be a Phase 1 bug discovered in production, and the
 * cheapest place to rule it out is one spec run against both.
 *
 * `makeKey` exists because the two have different namespaces: a filesystem
 * store is cleared by using a fresh temp directory, while a bucket persists
 * across runs. Prefixing per-run keeps them independent without asking either
 * adapter for a delete method the port does not have.
 */
export function describeBlobConformance(
  name: string,
  makeStore: () => BlobStore,
  makeKey: (suffix: string) => string,
): void {
  describe(`BlobStore conformance — ${name}`, () => {
    it('round-trips bytes exactly', async () => {
      const store = makeStore();
      const key = makeKey('round-trip');
      const bytes = new TextEncoder().encode('hello artifact');
      await store.put(key, bytes, 'text/plain');
      expect(await store.get(key)).toEqual(bytes);
    });

    it('round-trips BINARY bytes, not just text', async () => {
      // A UTF-8 round-trip would hide an adapter that decoded and re-encoded.
      // 0xff/0xfe is invalid UTF-8, so this fails if anything touches a string.
      const store = makeStore();
      const key = makeKey('binary');
      const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x7f, 0x80, 0x01]);
      await store.put(key, bytes, 'application/octet-stream');
      expect(Array.from(await store.get(key))).toEqual(Array.from(bytes));
    });

    it('stores an empty artifact and reads it back as empty', async () => {
      // Zero-length is a legitimate artifact and a classic off-by-one: an
      // adapter that treats a falsy body as absent would throw here.
      const store = makeStore();
      const key = makeKey('empty');
      await store.put(key, new Uint8Array(0), 'application/octet-stream');
      expect((await store.get(key)).length).toBe(0);
    });

    it('survives a payload larger than one buffer chunk', async () => {
      const store = makeStore();
      const key = makeKey('large');
      const bytes = new Uint8Array(512 * 1024);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
      await store.put(key, bytes, 'application/octet-stream');
      const got = await store.get(key);
      expect(got.length).toBe(bytes.length);
      // Spot-check rather than deep-equal 512 KiB, which is slow to diff.
      expect([got[0], got[1000], got[bytes.length - 1]]).toEqual([
        bytes[0],
        bytes[1000],
        bytes[bytes.length - 1],
      ]);
    });

    it('supports nested, slash-separated keys', async () => {
      // `blobKeyFor` produces workspace/task/artifact, so this is the real shape.
      const store = makeStore();
      const key = makeKey('ws/tsk_1/art_1');
      await store.put(key, new TextEncoder().encode('nested'), 'text/plain');
      expect(new TextDecoder().decode(await store.get(key))).toBe('nested');
    });

    it('overwrites an existing key rather than erroring or appending', async () => {
      const store = makeStore();
      const key = makeKey('overwrite');
      await store.put(key, new TextEncoder().encode('first'), 'text/plain');
      await store.put(key, new TextEncoder().encode('second'), 'text/plain');
      expect(new TextDecoder().decode(await store.get(key))).toBe('second');
    });

    it('throws "no such blob" for a key that was never written', async () => {
      // The message is asserted, not just the throw: domain code distinguishes
      // a missing artifact from a transport failure by it.
      const store = makeStore();
      await expect(store.get(makeKey('absent'))).rejects.toThrow(/no such blob/);
    });

    it('refuses an empty key', async () => {
      const store = makeStore();
      await expect(store.put('', new Uint8Array(1), 'text/plain')).rejects.toThrow(
        /invalid blob key/,
      );
    });

    it('refuses an absolute key', async () => {
      const store = makeStore();
      await expect(store.put('/etc/passwd', new Uint8Array(1), 'text/plain')).rejects.toThrow(
        /invalid blob key/,
      );
    });

    it('refuses a key that traverses out of the artifact namespace', async () => {
      // Artifact names come from agents, which are untrusted senders (§1.1).
      // S3 has no directory to escape, but both adapters must refuse the same
      // keys or they are not interchangeable.
      const store = makeStore();
      await expect(store.put('../../etc/passwd', new Uint8Array(1), 'text/plain')).rejects.toThrow(
        /outside the artifact directory/,
      );
    });

    it('refuses traversal on READ as well as write', async () => {
      const store = makeStore();
      await expect(store.get('../../etc/passwd')).rejects.toThrow(/outside the artifact directory/);
    });

    it('keeps two keys independent', async () => {
      const store = makeStore();
      const a = makeKey('independent-a');
      const b = makeKey('independent-b');
      await store.put(a, new TextEncoder().encode('AAA'), 'text/plain');
      await store.put(b, new TextEncoder().encode('BBB'), 'text/plain');
      expect(new TextDecoder().decode(await store.get(a))).toBe('AAA');
      expect(new TextDecoder().decode(await store.get(b))).toBe('BBB');
    });
  });
}
