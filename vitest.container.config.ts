import { defineConfig } from 'vitest/config';

/**
 * Drives the real Docker image. Separate from the integration config because a
 * build-plus-boot is minutes, not seconds, and must never be in the inner loop.
 */
export default defineConfig({
  test: {
    include: ['tests/container/**/*.test.ts'],
    environment: 'node',
    // docker build + boot + restart all happen inside this budget.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
