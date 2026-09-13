import { defineConfig } from 'vitest/config';

/** Real filesystem tests; the multi-process case runs the built dist, so build first. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
