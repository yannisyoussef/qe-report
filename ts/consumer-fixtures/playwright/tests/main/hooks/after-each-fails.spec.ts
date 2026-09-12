import { expect, test } from '@playwright/test';

test.afterEach(() => {
  throw new Error('afterEach broke');
});

test('body passed', async () => {
  expect(true).toBe(true);
});
