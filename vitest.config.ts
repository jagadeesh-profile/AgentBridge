import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live next to the code they test (CLAUDE.md §2); e2e and
    // conformance are run explicitly by their own make targets.
    include: ['{contracts,hub,delivery,sdk,adapters,cli,examples}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
