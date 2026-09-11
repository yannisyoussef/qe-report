import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test.describe('outer', () => {
  test.describe('inner', () => {
    test(
      'passes with nested steps',
      { tag: ['@smoke', '@fast'], annotation: { type: 'issue', description: 'QE-3' } },
      async ({ page }) => {
        await page.setContent('<h1>hello</h1>');
        await test.step('outer step', async () => {
          await test.step('inner step', async () => {
            await expect(page.locator('h1')).toHaveText('hello');
          });
        });
      },
    );
  });
});

test('attaches bodies and a file', async ({ page }, testInfo) => {
  await page.setContent('<p>attachments</p>');
  await testInfo.attach('note', { body: 'user note with token=abc123', contentType: 'text/plain' });
  await testInfo.attach('data', {
    body: JSON.stringify({ ok: true, password: 'hunter2' }),
    contentType: 'application/json',
  });
  const log = testInfo.outputPath('log.txt');
  writeFileSync(log, 'Authorization: Bearer abc.def.ghi\nline two\n');
  await testInfo.attach('log', { path: log, contentType: 'text/plain' });
  await testInfo.attach('shot', { body: await page.screenshot(), contentType: 'image/png' });
});

test('attaches inside a step', async ({ page }, testInfo) => {
  await page.setContent('<p>step attachment</p>');
  await test.step('step with attachment', async () => {
    await testInfo.attach('in-step', { body: 'attached during a step', contentType: 'text/plain' });
  });
});
