import { expect, test } from '@playwright/test';

test.beforeAll(() => {
  throw new Error('beforeAll broke');
});

test('a never runs', async () => {
  expect(true).toBe(true);
});
test('b never runs', async () => {
  expect(true).toBe(true);
});
