import { expect, test } from '@playwright/test';

test('flaky passes on retry', async ({}, testInfo) => {
  expect(testInfo.retry, 'fails until the first retry').toBeGreaterThan(0);
});

test('fails on every attempt', async () => {
  expect(1).toBe(2);
});

test('passes on the first attempt', async () => {
  expect(true).toBe(true);
});
