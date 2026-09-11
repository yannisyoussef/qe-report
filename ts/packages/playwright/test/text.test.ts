import { describe, expect, it } from 'vitest';
import { bounded, labelKey, relativeSource, stripAnsi, withoutRoots } from '../src/text.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe('stripAnsi', () => {
  it('returns text without escapes unchanged', () => {
    const text = 'plain text\nwith lines';
    expect(stripAnsi(text)).toBe(text);
  });

  it('removes colour and cursor sequences the way Playwright emits them', () => {
    const coloured = `${ESC}[2mexpect(${ESC}[22m${ESC}[31mreceived${ESC}[39m${ESC}[2m).${ESC}[22mtoBe`;
    expect(stripAnsi(coloured)).toBe('expect(received).toBe');
    expect(stripAnsi(`a${ESC}[1;32;40mb${ESC}[0mc${ESC}[2Kd`)).toBe('abcd');
  });

  it('removes hyperlink sequences terminated by BEL or by ESC backslash', () => {
    expect(stripAnsi(`${ESC}]8;;https://x.test${BEL}link${ESC}]8;;${BEL} end`)).toBe('link end');
    expect(stripAnsi(`${ESC}]0;title${ESC}\\rest`)).toBe('rest');
  });

  it('removes two-byte escapes and tolerates a trailing escape', () => {
    expect(stripAnsi(`${ESC}(Bx${ESC}`)).toBe('x');
    expect(stripAnsi(`${ESC}[31`)).toBe('');
  });

  it('handles long input with many sequences', () => {
    const text = `${ESC}[31mx`.repeat(200_000);
    expect(stripAnsi(text)).toBe('x'.repeat(200_000));
  });
});

describe('bounded', () => {
  it('keeps short text and marks what a long one lost', () => {
    expect(bounded('abc', 3)).toBe('abc');
    const out = bounded('x'.repeat(100), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    const kept = out.indexOf(' [truncated ');
    expect(out.slice(kept)).toBe(` [truncated ${100 - kept} characters]`);
  });
});

describe('paths', () => {
  it('relativises with forward slashes and never yields an absolute path', () => {
    expect(relativeSource('/root/project', '/root/project/tests/a.spec.ts')).toBe(
      'tests/a.spec.ts',
    );
    expect(relativeSource('/root/project', '/root/project')).toBe('.');
    expect(relativeSource('/root/project', '/root/other/b.ts')).toBe('../other/b.ts');
  });

  it('removes the root directory from free text', () => {
    const text = 'at /root/project/tests/a.spec.ts:3:5\nat /root/project/x.ts:1:1';
    expect(withoutRoots(text, ['/root/project'])).toBe('at tests/a.spec.ts:3:5\nat x.ts:1:1');
    expect(
      withoutRoots('at /root/project/tests/a.ts and /cwd/b.ts', ['/root/project', '/cwd']),
    ).toBe('at tests/a.ts and b.ts');
    expect(withoutRoots('nothing here', ['/root/project'])).toBe('nothing here');
    expect(withoutRoots('x', [''])).toBe('x');
  });
});

describe('labelKey', () => {
  it('reduces a free-text annotation type to identifier characters', () => {
    expect(labelKey('annotation.issue')).toBe('annotation.issue');
    expect(labelKey('annotation.token=abc secret')).toBe('annotation.token_abc_secret');
    expect(labelKey(`annotation.${'x'.repeat(100)}`).length).toBeLessThanOrEqual(64);
  });
});
