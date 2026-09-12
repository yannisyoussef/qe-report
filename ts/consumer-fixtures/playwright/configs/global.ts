import { join } from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import { base, root } from './base.js';

/** Scenarios outside ordinary test execution live in tests/global and run one at a time. */
export function global(
  testMatch: string | string[],
  overrides: PlaywrightTestConfig = {},
): PlaywrightTestConfig {
  return base({
    testDir: join(root, 'tests', 'global'),
    testMatch,
    projects: [{ name: 'desktop' }],
    ...overrides,
  });
}
