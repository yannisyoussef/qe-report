import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const ROOTS: string[] = [];
afterAll(() => {
  for (const d of ROOTS) rmSync(d, { recursive: true, force: true });
});

export function freshDir(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `qe-blob-${name}-`));
  ROOTS.push(d);
  return d;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface Source {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly bytes: Buffer;
}

/** A source file with its true declaration. */
export function sourceFile(dir: string, name: string, bytes: Buffer): Source {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, sha256: sha256(bytes), sizeBytes: bytes.length, bytes };
}

export function objectPath(root: string, hash: string): string {
  return join(root, 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash);
}

export function tempEntries(root: string): string[] {
  try {
    return readdirSync(join(root, 'tmp'));
  } catch {
    return [];
  }
}

export const posixIt = process.platform === 'win32' ? 'skip' : 'run';
