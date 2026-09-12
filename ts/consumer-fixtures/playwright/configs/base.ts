import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** The fixture project directory; configs resolve everything from here, never from the cwd. */
export const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The reporter is registered by package name, as a consumer would after installing it. The
 * run directory and run id come from the environment so that one fixture serves every scenario.
 */
export function base(overrides: PlaywrightTestConfig = {}): PlaywrightTestConfig {
  return defineConfig({
    testDir: join(root, 'tests', 'main'),
    outputDir: join(root, 'test-results'),
    fullyParallel: true,
    workers: 2,
    retries: Number(process.env.PW_RETRIES ?? '0'),
    repeatEach: Number(process.env.PW_REPEAT_EACH ?? '1'),
    timeout: 10_000,
    reporter: [
      ['qe-report-playwright'],
      ['dot'],
      ...(process.env.PW_STATUS_FILE
        ? [
            [
              join(root, 'configs', 'status-probe.ts'),
              { file: process.env.PW_STATUS_FILE },
            ] as const,
          ]
        : []),
    ],
    use: {
      browserName: 'chromium',
      headless: true,
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      video: 'retain-on-failure',
    },
    projects: [
      { name: 'desktop', use: { viewport: { width: 1200, height: 800 } } },
      { name: 'mobile', use: { viewport: { width: 375, height: 800 } } },
    ],
    ...overrides,
  });
}
