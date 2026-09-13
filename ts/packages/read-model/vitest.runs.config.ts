import { defineConfig } from 'vitest/config';

/** Projects real adapter output: the JUnit consumer runs from the Java build, or fresh Playwright runs. */
export default defineConfig({
  test: {
    include: ['test-runs/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
