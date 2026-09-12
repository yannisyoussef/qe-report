import { describe, expect, it } from 'vitest';
import { hierarchy, historicalId, pathSegments } from '../src/identity.js';
import { ROOT, testCase } from './fakes.js';

describe('identity', () => {
  it('builds the path from project, root-relative file, and describe titles', () => {
    const h = hierarchy(testCase({ groups: ['outer', 'inner'] }), ROOT);
    expect(h).toEqual({
      project: 'desktop',
      file: 'tests/a.spec.ts',
      groups: ['outer', 'inner'],
      title: 'does a thing',
    });
    expect(pathSegments(h)).toEqual([
      { kind: 'project', name: 'desktop' },
      { kind: 'file', name: 'tests/a.spec.ts' },
      { kind: 'group', name: 'outer' },
      { kind: 'group', name: 'inner' },
    ]);
  });

  it('omits the project segment when the configuration names none', () => {
    const h = hierarchy(testCase({ project: '' }), ROOT);
    expect(pathSegments(h)[0]).toEqual({ kind: 'file', name: 'tests/a.spec.ts' });
  });

  it('gives the same historical id to retries, repeats, and moves within the file', () => {
    const a = historicalId(hierarchy(testCase({ line: 3 }), ROOT));
    expect(a).toMatch(/^[0-9a-f]{40}$/u);
    expect(historicalId(hierarchy(testCase({ line: 40, id: 'other-id' }), ROOT))).toBe(a);
    expect(historicalId(hierarchy(testCase({ repeatEachIndex: 1 }), ROOT))).toBe(a);
  });

  it('changes the historical id when the project, file, group, or title changes', () => {
    const base = historicalId(hierarchy(testCase(), ROOT));
    expect(historicalId(hierarchy(testCase({ project: 'mobile' }), ROOT))).not.toBe(base);
    expect(historicalId(hierarchy(testCase({ file: `${ROOT}/tests/b.spec.ts` }), ROOT))).not.toBe(
      base,
    );
    expect(historicalId(hierarchy(testCase({ groups: ['g'] }), ROOT))).not.toBe(base);
    expect(historicalId(hierarchy(testCase({ title: 'renamed' }), ROOT))).not.toBe(base);
  });

  it('never contains the absolute checkout path', () => {
    const h = hierarchy(testCase(), ROOT);
    expect(JSON.stringify(pathSegments(h))).not.toContain(ROOT);
  });
});
