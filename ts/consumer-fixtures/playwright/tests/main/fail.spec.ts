import { expect, test } from '@playwright/test';

test('assertion fails inside a step', async ({ page }) => {
  await page.setContent('<h1>hello</h1>');
  await test.step('failing step', async () => {
    await expect(page.locator('h1')).toHaveText('goodbye', { timeout: 300 });
  });
});

test('throws a plain error', async () => {
  throw new TypeError('plain error with password=hunter2');
});

test('times out', async () => {
  test.setTimeout(700);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
});
