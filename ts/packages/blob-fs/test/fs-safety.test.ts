import { closeSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { entryKind, openRegular } from '../src/fs-safety.js';
import { freshDir } from './helpers.js';

const posix = process.platform === 'win32' ? it.skip : it;

/** The primitive mirrors the validator's: these pin the behaviour the store relies on. */
describe('non-following inspection and opening', () => {
  it('classifies a regular file, a directory, and a missing path', () => {
    const dir = freshDir('kinds');
    writeFileSync(join(dir, 'f'), 'x');
    mkdirSync(join(dir, 'd'));
    expect(entryKind(join(dir, 'f'))).toBe('file');
    expect(entryKind(join(dir, 'd'))).toBe('directory');
    expect(entryKind(join(dir, 'none'))).toBe('missing');
    expect(entryKind(join(dir, 'f', 'below-a-file'))).toBe('missing');
    const opened = openRegular(join(dir, 'f'));
    expect('fd' in opened && opened.size).toBe(1);
    if ('fd' in opened) closeSync(opened.fd);
    expect(openRegular(join(dir, 'd'))).toEqual({ refused: 'directory' });
    expect(openRegular(join(dir, 'none'))).toEqual({ refused: 'missing' });
  });

  posix('reports a link as a link and refuses to open through it', () => {
    const dir = freshDir('links');
    writeFileSync(join(dir, 'target'), 'secret');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    expect(entryKind(join(dir, 'link'))).toBe('symlink');
    expect(openRegular(join(dir, 'link'))).toEqual({ refused: 'symlink' });
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'));
    expect(entryKind(join(dir, 'dangling'))).toBe('symlink');
    expect(openRegular(join(dir, 'dangling'))).toEqual({ refused: 'symlink' });
  });

  posix('reports a pipe as special and neither blocks on it nor reads it', () => {
    const dir = freshDir('fifo');
    execFileSync('mkfifo', [join(dir, 'pipe')]);
    expect(entryKind(join(dir, 'pipe'))).toBe('special');
    expect(openRegular(join(dir, 'pipe'))).toEqual({ refused: 'special' });
  });
});
