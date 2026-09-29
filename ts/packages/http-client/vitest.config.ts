import { defineConfig } from 'vitest/config';

/** Unit tests: ordering, fingerprint, archive building. No database. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
