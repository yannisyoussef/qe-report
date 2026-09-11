import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateRunDirectory } from 'qe-report-validator';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'worker.mjs');
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function runWorker(
  runDir: string,
  sessionId: string,
  rounds: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, runDir, sessionId, String(rounds)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('several producer processes on one run directory', () => {
  it('each own a session file, share attachments, and validate as one run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'qe-mp-'));
    const workers = 5;
    const rounds = 6;
    const results = await Promise.all(
      Array.from({ length: workers }, (_, i) => runWorker(dir ?? '', `worker-${i}`, rounds)),
    );
    for (const r of results) expect(r, r.stderr).toMatchObject({ code: 0 });
    expect(readdirSync(join(dir, 'events'))).toHaveLength(workers);
    const names = readdirSync(join(dir, 'attachments'));
    expect(names.filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    expect(names).toHaveLength(1 + workers * rounds);
    for (const n of names)
      expect(
        createHash('sha256')
          .update(readFileSync(join(dir, 'attachments', n)))
          .digest('hex'),
      ).toBe(n);
    const report = await validateRunDirectory(dir, { requireComplete: true });
    expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(report.summary).toMatchObject({
      files: workers,
      sessions: workers,
      attempts: workers * rounds,
      attachments: 2 * workers * rounds,
      complete: true,
      closed: false,
    });
  }, 60_000);
});
