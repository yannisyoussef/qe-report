import { defineConfig } from 'vitest/config';

/** Persists real adapter output into PostgreSQL and replays it: JUnit consumer runs, fresh Playwright runs. */
export default defineConfig({
  test: {
    include: ['test-runs/**/*.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
