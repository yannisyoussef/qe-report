import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'protocol',
);
export const FIXTURES_DIR = join(PROTOCOL_DIR, 'fixtures');

export interface Manifest {
  protocolVersion: string;
  events: {
    valid: { file: string; roundTrip: 'exact' | 'idempotent' }[];
    invalid: { file: string; reason: string; pointer: string | null; codec: 'reject' | 'accept' }[];
  };
  runs: {
    dir: string;
    outcome: 'VALID' | 'INVALID';
    reason?: string;
    detail?: string;
    line?: number;
    complete?: boolean;
    closed?: boolean;
    sessions?: number;
    attempts?: number;
    ignored?: number;
    duplicates?: number;
    roundTrip?: 'idempotent';
  }[];
}

export function manifest(): Manifest {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as Manifest;
}

export function fixtureText(relative: string): string {
  return readFileSync(join(FIXTURES_DIR, relative), 'utf8');
}

export function runLines(dir: string): string[] {
  return fixtureText(join(dir, 'events.ndjson'))
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/** Test-only canonical form: keys sorted recursively, then JSON. Not a wire-format guarantee. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
