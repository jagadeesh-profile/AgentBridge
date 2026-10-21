import { defineConfig } from 'vitest/config';

/**
 * e2e and conformance suites. Separate from the root config so `pnpm test`
 * stays a fast unit run and does not boot real servers, while `make test-e2e`
 * and `make conformance` target these deliberately.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // Real hubs on real ports: give them room, and do not run files in parallel
    // against each other.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
