import { defineConfig } from 'vitest/config';

export default defineConfig({
  // JSX for the console's component tests, via the bundler's own transform
  // rather than @vitejs/plugin-react. The plugin pulls esbuild, whose install
  // script this repo's supply-chain policy blocks, and the only thing needed
  // here is the automatic runtime — so a dependency would buy nothing (§4).
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    // Unit tests live next to the code they test (CLAUDE.md §2); e2e and
    // conformance are run explicitly by their own make targets.
    // `.tsx` as well, for the console's component tests. Those select jsdom
    // per-file with a `@vitest-environment` docblock rather than a global
    // override, so the other ~640 tests keep running in plain node.
    include: [
      '{contracts,hub,delivery,sdk,adapters,cli,console,examples,infra}/**/*.test.ts',
      'console/**/*.test.tsx',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
