import { expect, test } from '@playwright/test';

test('skipped by the author', async () => {
  test.skip();
});

test('marked fixme', async () => {
  test.fixme();
});

test('expected to fail and fails', async () => {
  test.fail();
  expect(1).toBe(2);
});

test('expected to fail but passes', async () => {
  test.fail();
  expect(1).toBe(1);
});

test('conditionally expected to fail', async ({ browserName }) => {
  test.fail(browserName === 'chromium', 'known problem on chromium');
  expect(1).toBe(2);
});
