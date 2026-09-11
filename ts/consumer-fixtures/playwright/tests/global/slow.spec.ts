import { writeFileSync } from 'node:fs';
import { test } from '@playwright/test';

/** Each body announces its start through a marker file so a harness can act on it. */
async function slow(): Promise<void> {
  if (process.env.PW_MARKER_FILE) writeFileSync(process.env.PW_MARKER_FILE, 'started');
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}

test('slow one', async () => {
  test.setTimeout(30_000);
  await slow();
});

test('slow two', async () => {
  test.setTimeout(30_000);
  await slow();
});
