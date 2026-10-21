import type { Untrusted } from '@agentbridge/sdk';

export interface JobMatch {
  title: string;
  company: string;
  url: string;
}

export interface MuseResult {
  artifact: {
    name: string;
    kind: 'json';
    contentType: string;
    inline: { matches: JobMatch[] };
  };
}

/**
 * Muse's one job, shared by all three transports.
 *
 * The mode files differ only in HOW work arrives — SDK handler, raw webhook, or
 * pull inbox. Swapping the real Muse between them touches one file and never
 * this one, which is what keeps the "not sure yet how Muse connects" decision
 * cheap to settle.
 */
export function museHandler(payload: Untrusted<unknown>): MuseResult {
  // Explicit unwrap: this came from another agent, so it is data to parse, not
  // instructions to follow (CLAUDE.md §1.1).
  const raw = payload.unwrap();
  const count = readCount(raw);

  return {
    artifact: {
      name: 'matches.json',
      kind: 'json',
      contentType: 'application/json',
      inline: { matches: findJobs(count) },
    },
  };
}

/**
 * Reads the one field Muse cares about and ignores everything else. A hostile
 * sender cannot widen Muse's behaviour by adding fields, and a missing or
 * absurd count degrades to a sane default rather than throwing.
 */
function readCount(raw: unknown): number {
  const candidate =
    raw !== null && typeof raw === 'object' && 'count' in raw
      ? (raw as { count: unknown }).count
      : undefined;
  const n = typeof candidate === 'number' && Number.isFinite(candidate) ? Math.floor(candidate) : 3;
  return Math.min(Math.max(n, 1), 10);
}

/** Stands in for the real job sweep. */
function findJobs(count: number): JobMatch[] {
  const pool: JobMatch[] = [
    { title: 'Senior Platform Engineer', company: 'Acme', url: 'https://jobs.example/acme-1' },
    { title: 'Staff Backend Engineer', company: 'Globex', url: 'https://jobs.example/globex-2' },
    { title: 'Infrastructure Lead', company: 'Initech', url: 'https://jobs.example/initech-3' },
    { title: 'Principal Engineer', company: 'Umbrella', url: 'https://jobs.example/umbrella-4' },
  ];
  return pool.slice(0, count);
}
