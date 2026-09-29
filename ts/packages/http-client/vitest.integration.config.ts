import { defineConfig } from 'vitest/config';

/** Integration tests against a real PostgreSQL 16 started through Testcontainers. */
export default defineConfig({
  test: {
    include: ['test-integration/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
