import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'consumer-fixtures/playwright/tests/global/broken.spec.ts',
    ],
  },
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    },
  },
);
