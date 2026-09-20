import { describe, expect, it } from 'vitest';
import { MAX_PROJECT_ID_UTF8_BYTES, buildReadModel, checkProjectId } from '../src/index.js';
import { execution, freshRoot, simpleRun, testCase } from './synthetic.js';

/** A string of exactly `bytes` UTF-8 bytes, built from one character whose width divides it. */
function ofBytes(bytes: number, char = 'x'): string {
  const width = Buffer.byteLength(char, 'utf8');
  if (bytes % width !== 0) throw new Error('the width must divide the length');
  return char.repeat(bytes / width);
}

const E_ACUTE = String.fromCodePoint(0xe9);
const EURO = String.fromCodePoint(0x20ac);
const GRINNING = String.fromCodePoint(0x1f600);

describe('the project id contract', () => {
  it('is 512 bytes of UTF-8', () => {
    expect(MAX_PROJECT_ID_UTF8_BYTES).toBe(512);
  });

  it('accepts exactly the boundary and refuses one byte past it, counting bytes not characters', () => {
    expect(() => checkProjectId(ofBytes(512))).not.toThrow();
    expect(() => checkProjectId(ofBytes(513))).toThrow(TypeError);
    // 256 two-byte characters are the limit; one more is 514 bytes, though only 257 characters.
    expect(() => checkProjectId(ofBytes(512, E_ACUTE))).not.toThrow();
    expect(() => checkProjectId(`${ofBytes(512, E_ACUTE)}${E_ACUTE}`)).toThrow(/512 bytes/u);
    expect(() => checkProjectId(`${ofBytes(511)}${E_ACUTE}`)).toThrow(TypeError);
    // Three-byte characters: 510 bytes fit, and two more bytes of ASCII reach the boundary.
    expect(() => checkProjectId(`${ofBytes(510, EURO)}xx`)).not.toThrow();
    expect(() => checkProjectId(`${ofBytes(510, EURO)}${EURO}`)).toThrow(TypeError);
    // 128 four-byte characters are 256 JavaScript code units and exactly 512 bytes.
    expect(ofBytes(512, GRINNING).length).toBe(256);
    expect(() => checkProjectId(ofBytes(512, GRINNING))).not.toThrow();
    expect(() => checkProjectId(`${ofBytes(512, GRINNING)}x`)).toThrow(TypeError);
  });

  it('refuses empty, U+0000, and text that is not Unicode', () => {
    const nul = String.fromCharCode(0);
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdc00);
    for (const bad of ['', nul, `a${nul}b`, high, `a${low}`, `${low}${high}`, `x${high}`]) {
      expect(() => checkProjectId(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(() => checkProjectId(undefined as unknown as string)).toThrow(TypeError);
    expect(() => checkProjectId(7 as unknown as string)).toThrow(TypeError);
    // A paired surrogate is an ordinary character, not a malformed one.
    expect(() => checkProjectId(`${high}${low}`)).not.toThrow();
  });

  it('neither trims nor normalises, so different spellings are different projects', async () => {
    const composed = `caf${E_ACUTE}`;
    const decomposed = `cafe${String.fromCodePoint(0x301)}`;
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'));
    const padded = ' padded ';
    const tabbed = `${String.fromCharCode(9)}tab`;
    for (const id of [padded, tabbed, composed, decomposed]) {
      expect(() => checkProjectId(id)).not.toThrow();
    }
    const root = freshRoot('project-ids');
    const dir = simpleRun(root, 'r', 'run-1', 'pw', execution(testCase('e', 'h'), [['passed']]));
    const { model, problems } = await buildReadModel([
      { projectId: composed, runDirectory: dir },
      { projectId: decomposed, runDirectory: dir },
      { projectId: padded, runDirectory: dir },
    ]);
    expect(problems).toEqual([]);
    expect(new Set(model.runs().map((r) => r.projectId))).toEqual(
      new Set([composed, decomposed, padded]),
    );
    expect(model.getRun('padded', 'run-1')).toBeUndefined();
    expect(model.getTestHistory(composed, 'pw', 'h').occurrences).toHaveLength(1);
    expect(model.getTestHistory(decomposed, 'pw', 'h').occurrences).toHaveLength(1);
    expect(model.getTestHistory(ofBytes(512), 'pw', 'h').occurrences).toHaveLength(0);
    expect(() => model.getTestHistory(ofBytes(513), 'pw', 'h')).toThrow(TypeError);
  });
});
