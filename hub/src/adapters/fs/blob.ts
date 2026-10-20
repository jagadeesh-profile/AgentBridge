import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BlobStore } from '../../ports/index.js';

/**
 * Filesystem artifact store for Phase 0. S3 replaces this at Phase 1 as one new
 * file implementing the same port (spec §4.1).
 */
export function openBlobStore(dir: string): BlobStore {
  const root = resolve(dir);

  /**
   * Resolves a key under the artifact root, refusing anything that escapes it.
   * Artifact names reach us from agents, which are untrusted senders, so a key
   * like `../../etc/passwd` must not become a write outside the volume.
   */
  function pathFor(key: string): string {
    if (key === '' || isAbsolute(key)) {
      throw new Error(`invalid blob key: ${key}`);
    }
    const full = resolve(root, key);
    const rel = relative(root, full);
    if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`blob key resolves outside the artifact directory: ${key}`);
    }
    return full;
  }

  return {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      const full = pathFor(key);
      await mkdir(dirname(full), { recursive: true });
      // Write to a temp file and rename, so a crash mid-write cannot leave a
      // partially written artifact readable under its final name.
      const tmp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, full);
    },

    async get(key: string): Promise<Uint8Array> {
      const full = pathFor(key);
      try {
        return new Uint8Array(await readFile(full));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`no such blob: ${key}`);
        }
        throw err;
      }
    },
  };
}

/** Where a task's artifact bytes live, relative to the artifact root. */
export function blobKeyFor(workspace: string, task: string, artifactId: string): string {
  return join(sanitize(workspace), sanitize(task), sanitize(artifactId));
}

function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9._:-]/g, '_');
}
