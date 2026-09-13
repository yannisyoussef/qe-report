import { describe, expect, it } from 'vitest';
import { eachLimited } from '../src/materialise.js';

describe('bounded iteration', () => {
  it('runs nothing for an empty list and everything once otherwise, never more than the limit at once', async () => {
    await eachLimited([], 3, async () => {
      throw new Error('not called');
    });
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(item);
      inFlight -= 1;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
    const few: number[] = [];
    await eachLimited([1, 2], 8, async (item) => {
      few.push(item);
    });
    expect(few).toEqual([1, 2]);
  });

  it('rejects with the first failure after the work already in flight has settled, starting nothing new', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    await expect(
      eachLimited([1, 2, 3, 4, 5, 6], 2, async (item) => {
        started.push(item);
        await new Promise((r) => setTimeout(r, item === 1 ? 1 : 10));
        if (item === 1) throw new Error('first');
        finished.push(item);
      }),
    ).rejects.toThrow('first');
    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([2]);
  });
});
