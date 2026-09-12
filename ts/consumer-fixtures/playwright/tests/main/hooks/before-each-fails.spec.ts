import { expect, test } from '@playwright/test';

test.beforeEach(() => {
  throw new Error('beforeEach broke');
});

test('body skipped', async () => {
  expect(true).toBe(true);
});
