import { expect, test } from '@playwright/test';

test('leaves an unhandled error behind', async () => {
  setTimeout(() => {
    throw new Error('unhandled error outside the test body');
  }, 50);
  await new Promise((resolve) => setTimeout(resolve, 300));
});

test('runs after the error', async () => {
  expect(true).toBe(true);
});
