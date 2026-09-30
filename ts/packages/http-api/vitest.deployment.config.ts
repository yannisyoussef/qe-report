import { defineConfig } from 'vitest/config';

/**
 * The reference deployment, as containers: an image build, a Compose stack, a TLS edge, a real
 * producer, backup, and a destructive restore. Slow by nature and serialised on purpose, because
 * each phase is the state the next one reads.
 */
export default defineConfig({
  test: {
    include: ['test-deployment/**/*.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
