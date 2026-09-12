import { defineConfig } from 'vitest/config';

/** The consumer fixture runs real Playwright executions; each test may take a minute. */
export default defineConfig({
  test: {
    include: ['test-consumer/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
