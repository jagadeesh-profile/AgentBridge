import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'contracts/generated/**', '.superpowers/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md §4: no `any` at module boundaries, no non-null assertions on
      // inbound data. These are errors, not warnings — the hub parses input
      // from untrusted agents.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      // A leading underscore means "deliberately discarded" — the idiom for
      // destructuring a key off an object in order to drop it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Tests may assert on non-null values and print diagnostics.
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    // Build and tooling scripts run under Node directly, outside any tsconfig.
    files: ['**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
