import { afterEach } from 'vitest';
import { openStore, type SqliteStore } from '../adapters/sqlite/store.js';
import { FakeStore } from './fakes/index.js';
import { describeStoreConformance } from './store-conformance.js';

/**
 * Both implementations, one spec.
 *
 * The hub's tests run against the fake and production runs SQLite, so the two
 * being interchangeable underpins the whole suite. Any Phase 1 adapter —
 * DynamoDB first — joins this list before it is believed.
 */
const open: SqliteStore[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describeStoreConformance('in-memory fake', () => new FakeStore());
describeStoreConformance('sqlite', () => {
  const s = openStore(':memory:');
  open.push(s);
  return s;
});
