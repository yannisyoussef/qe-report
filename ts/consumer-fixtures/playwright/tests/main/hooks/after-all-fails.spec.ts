import { expect, test } from '@playwright/test';

test.afterAll(() => {
  throw new Error('afterAll broke');
});

test('first passes', async () => {
  expect(true).toBe(true);
});
test('second passes', async () => {
  expect(true).toBe(true);
});
