import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  ServerLifecycle,
  StagingMaintenance,
  resolveDatabaseUrl,
  runAdmin,
  safeMessage,
  scrubConnectionStrings,
  shutdownGraceFrom,
  type ShutdownResult,
} from '../src/index.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `qe-ops-${name}-`));
  roots.push(dir);
  return dir;
}

const posix = process.platform === 'win32' ? it.skip : it;
const SECRET = 'postgres://qe:sup3rs3cret@db.internal:5432/qe_report';
/** Part of the usage text, so a test notices if a parse error stops printing it. */
const USAGE_MARKER = 'qe-report-admin staging preview';

describe('where the database secret comes from', () => {
  it('takes one form or the other, and refuses to choose between them', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: SECRET })).toBe(SECRET);
    const dir = freshDir('secret');
    const file = join(dir, 'database-url');
    writeFileSync(file, SECRET);
    expect(resolveDatabaseUrl({ DATABASE_URL_FILE: file })).toBe(SECRET);

    // Both set is a deployment that has not decided; the process will not decide for it.
    const both = (): string =>
      resolveDatabaseUrl({ DATABASE_URL: SECRET, DATABASE_URL_FILE: file });
    expect(both).toThrow(/only one of DATABASE_URL and DATABASE_URL_FILE/u);
    expect(both).not.toThrow(/sup3rs3cret/u);
    expect(() => resolveDatabaseUrl({})).toThrow(/one of DATABASE_URL and DATABASE_URL_FILE/u);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: '', DATABASE_URL_FILE: '' })).toThrow(
      /must be set/u,
    );
  });

  it('allows the one newline a secret mount leaves, and nothing else', () => {
    const dir = freshDir('newline');
    const one = join(dir, 'one');
    writeFileSync(one, `${SECRET}\n`);
    expect(resolveDatabaseUrl({ DATABASE_URL_FILE: one })).toBe(SECRET);
    const two = join(dir, 'two');
    writeFileSync(two, `${SECRET}\n\n`);
    expect(() => resolveDatabaseUrl({ DATABASE_URL_FILE: two })).toThrow(/more than one line/u);
    const empty = join(dir, 'empty');
    writeFileSync(empty, '');
    expect(() => resolveDatabaseUrl({ DATABASE_URL_FILE: empty })).toThrow(/is empty/u);
    const newlineOnly = join(dir, 'newline-only');
    writeFileSync(newlineOnly, '\n');
    expect(() => resolveDatabaseUrl({ DATABASE_URL_FILE: newlineOnly })).toThrow(/is empty/u);
  });

  it('never names the file it could not read', () => {
    const dir = freshDir('unreadable');
    const missing = join(dir, 'nowhere', 'database-url');
    try {
      resolveDatabaseUrl({ DATABASE_URL_FILE: missing });
      expect.unreachable('a missing secret file is a configuration error');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('cannot be read');
      // The path is a fact about the host; a caller of an HTTP API has no business learning it.
      expect(message).not.toContain(missing);
      expect(message).not.toContain(dir);
    }
  });
});

describe('what a message may say about a connection', () => {
  it('takes the credential out of a connection string, wherever it appears', () => {
    // The credential goes; the host and the database name stay, because they are what an
    // operator needs to see and neither is a secret.
    expect(scrubConnectionStrings(`could not connect to ${SECRET}`)).toBe(
      'could not connect to postgres://[redacted]@db.internal:5432/qe_report',
    );
    expect(scrubConnectionStrings(SECRET)).not.toContain('sup3rs3cret');
    // Two of them in one line, and a URL with no credential at all.
    const two = scrubConnectionStrings(`${SECRET} then postgresql://other:pw@host/db`);
    expect(two).not.toContain('sup3rs3cret');
    expect(two).not.toContain(':pw@');
    expect(scrubConnectionStrings('https://reports.example.com/v1/runs')).toBe(
      'https://[redacted]@reports.example.com/v1/runs',
    );
    // Ordinary text is left alone.
    expect(scrubConnectionStrings('the schema is not current')).toBe('the schema is not current');
    expect(safeMessage(new Error(`ECONNREFUSED ${SECRET}`))).not.toContain('sup3rs3cret');
    expect(safeMessage('plain text')).toBe('plain text');
  });
});

describe('how the server stops', () => {
  const lifecycleFor = (
    close: () => Promise<void>,
    graceMs = 50,
  ): { lifecycle: ServerLifecycle; events: string[] } => {
    const events: string[] = [];
    const lifecycle = new ServerLifecycle({
      close,
      graceMs,
      log: (event) => events.push(event),
    });
    return { lifecycle, events };
  };

  it('drains, closes, and exits cleanly', async () => {
    let closed = false;
    const { lifecycle, events } = lifecycleFor(async () => {
      closed = true;
    });
    expect(lifecycle.current).toBe('running');
    expect(lifecycle.draining).toBe(false);
    const result = await lifecycle.shutdown('SIGTERM');
    expect(result).toMatchObject({ outcome: 'closed', exitCode: 0, phase: 'closed' });
    expect(closed).toBe(true);
    expect(lifecycle.draining).toBe(true);
    expect(events).toEqual(['shutdown requested', 'shutdown completed']);
  });

  it('gives up when the drain outlasts its grace, and says so once', async () => {
    const { lifecycle, events } = lifecycleFor(() => new Promise<void>(() => undefined), 10);
    const result = await lifecycle.shutdown('SIGTERM');
    expect(result.outcome).toBe('grace_exceeded');
    expect(result.exitCode).toBe(1);
    expect(events).toEqual(['shutdown requested', 'shutdown grace exceeded']);
  });

  it('stops at once when a second signal arrives, and answers every caller alike', async () => {
    let release: (() => void) | undefined;
    const { lifecycle, events } = lifecycleFor(
      () => new Promise<void>((resolve) => (release = resolve)),
      60_000,
    );
    const first = lifecycle.shutdown('SIGTERM');
    const second = lifecycle.shutdown('SIGINT');
    const result = await first;
    expect(result.outcome).toBe('forced');
    expect(result.exitCode).toBe(1);
    // Both callers see the same outcome; the shutdown happened once.
    expect(await second).toEqual(result);
    expect(events).toEqual(['shutdown requested', 'shutdown forced', 'shutdown completed']);
    release?.();
  });

  it('reports a close that failed without saying what was running', async () => {
    const { lifecycle, events } = lifecycleFor(async () => {
      throw new Error(`the pool could not close: ${SECRET}`);
    });
    const result: ShutdownResult = await lifecycle.shutdown('SIGTERM');
    expect(result).toMatchObject({ outcome: 'failed', exitCode: 1 });
    expect(events).toEqual(['shutdown requested', 'shutdown failed']);
  });

  it('reads the grace a deployment configured, and refuses one it cannot', () => {
    expect(shutdownGraceFrom({})).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    expect(shutdownGraceFrom({ QE_REPORT_SHUTDOWN_GRACE_MS: '' })).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    expect(shutdownGraceFrom({ QE_REPORT_SHUTDOWN_GRACE_MS: '45000' })).toBe(45_000);
    for (const bad of ['0', '-1', 'soon', '1.5', '01']) {
      expect(() => shutdownGraceFrom({ QE_REPORT_SHUTDOWN_GRACE_MS: bad }), bad).toThrow(
        /positive whole number/u,
      );
    }
    expect(
      () => new ServerLifecycle({ close: async () => undefined, graceMs: 0, log: () => undefined }),
    ).toThrow(TypeError);
  });
});

describe('what staging cleanup will touch', () => {
  const UUIDS = [
    '11111111-2222-4333-8444-555555555555',
    '66666666-7777-4888-8999-aaaaaaaaaaaa',
    'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  ];

  /** A staging root with an old request, a recent one, and a collection of things to leave alone. */
  function stagingRoot(name: string): { root: string; old: string; recent: string } {
    const root = freshDir(name);
    const old = UUIDS[0] as string;
    const recent = UUIDS[1] as string;
    for (const id of [old, recent]) {
      mkdirSync(join(root, id, 'events'), { recursive: true });
      writeFileSync(join(root, id, 'events', '000001.ndjson'), '{}\n');
    }
    // Both times are explicit: a directory modified exactly at the cutoff is not before it, so a
    // test that let "recent" mean "this millisecond" would depend on how fast it ran.
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recently = new Date(Date.now() - 60 * 1000);
    utimesSync(join(root, old), longAgo, longAgo);
    utimesSync(join(root, recent), recently, recently);
    mkdirSync(join(root, 'not-a-request-id'));
    writeFileSync(join(root, 'stray.txt'), 'not mine');
    return { root, old, recent };
  }

  const cutoff = (): Date => new Date(Date.now() - 30 * 60 * 1000);

  it('lists only an old request directory, and reports everything else', () => {
    const { root, old } = stagingRoot('list');
    const report = new StagingMaintenance(root).preview({ before: cutoff() });
    expect(report.dryRun).toBe(true);
    expect(report.entries.map((e) => e.requestId)).toEqual([old]);
    expect(report.removed).toBe(0);
    expect(report.problems.map((p) => [p.code, p.name]).sort()).toEqual([
      ['NOT_A_REQUEST_ID', 'not-a-request-id'],
      ['NOT_A_REQUEST_ID', 'stray.txt'],
    ]);
    // A preview changes nothing at all.
    expect(new StagingMaintenance(root).preview({ before: cutoff() }).entries).toHaveLength(1);
  });

  it('removes the old request directory and nothing else', () => {
    const { root, old, recent } = stagingRoot('clean');
    const report = new StagingMaintenance(root).clean({ before: cutoff() });
    expect(report.dryRun).toBe(false);
    expect(report.entries.map((e) => e.requestId)).toEqual([old]);
    expect(report.removed).toBe(1);
    expect(() => new StagingMaintenance(root).preview({ before: cutoff() })).not.toThrow();
    const after = new StagingMaintenance(root).preview({ before: cutoff() });
    expect(after.entries).toEqual([]);
    // The recent request, the unfamiliar directory, and the stray file are all still there.
    const remaining = new StagingMaintenance(root).preview({ before: new Date() });
    expect(remaining.entries.map((e) => e.requestId)).toEqual([recent]);
    expect(remaining.problems).toHaveLength(2);
  });

  posix('never follows a link or removes a canonical name that is not a directory', () => {
    const { root } = stagingRoot('unsafe');
    const elsewhere = freshDir('elsewhere');
    writeFileSync(join(elsewhere, 'precious'), 'keep me');
    const linked = UUIDS[2] as string;
    symlinkSync(elsewhere, join(root, linked));
    const asFile = '99999999-8888-4777-8666-555555555555';
    writeFileSync(join(root, asFile), 'not a directory');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(join(root, asFile), longAgo, longAgo);
    const report = new StagingMaintenance(root).clean({ before: cutoff() });
    const problems = new Map(report.problems.map((p) => [p.name, p.code]));
    expect(problems.get(linked)).toBe('NOT_A_DIRECTORY');
    expect(problems.get(asFile)).toBe('NOT_A_DIRECTORY');
    // Neither was followed and neither was removed.
    expect(new StagingMaintenance(root).preview({ before: new Date() }).problems.length).toBe(
      report.problems.length,
    );
    expect(readdirSync(elsewhere)).toEqual(['precious']);
  });

  it('is bounded, and says when more remain', () => {
    const root = freshDir('bounded');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) {
      const id = `0000000${i}-2222-4333-8444-555555555555`;
      mkdirSync(join(root, id));
      utimesSync(join(root, id), longAgo, longAgo);
    }
    const first = new StagingMaintenance(root).preview({ before: cutoff(), max: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.truncated).toBe(true);
    const all = new StagingMaintenance(root).clean({ before: cutoff(), max: 100 });
    expect(all.removed).toBe(5);
    expect(all.truncated).toBe(false);
  });

  it('requires a cutoff it can use', () => {
    const root = freshDir('cutoff');
    for (const before of [undefined, new Date(Number.NaN), '2027-01-01' as unknown as Date]) {
      expect(() => new StagingMaintenance(root).clean({ before: before as Date })).toThrow(
        TypeError,
      );
    }
    expect(() =>
      new StagingMaintenance(join(root, 'nowhere')).preview({ before: new Date() }),
    ).toThrow(/staging root cannot be read/u);
    expect(() => new StagingMaintenance(root).preview({ before: new Date(), max: 0 })).toThrow(
      TypeError,
    );
  });
});

describe('what the operator commands refuse before touching anything', () => {
  /** A pool that fails if a command reaches the database; these cases must not get that far. */
  const noDatabase = {
    query: () => {
      throw new Error('no command under test may reach the database');
    },
  } as unknown as pg.Pool;

  const run = async (
    argv: readonly string[],
    env: NodeJS.ProcessEnv = {},
  ): Promise<{ code: number; out: string; err: string }> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAdmin(
      argv,
      noDatabase,
      {
        out: (t) => out.push(t),
        err: (t) => err.push(t),
      },
      env,
    );
    return { code, out: out.join(''), err: err.join('') };
  };

  it('needs a destructive staging clean to be asked for explicitly', async () => {
    const root = freshDir('cli-staging');
    const env = { QE_REPORT_STAGING_ROOT: root };
    const withoutExecute = await run(['staging', 'clean', '--older-than-ms', '1000'], env);
    expect(withoutExecute.code).toBe(2);
    expect(withoutExecute.err).toContain('--execute');
    expect(withoutExecute.err).toContain('stop the API instance');

    // A preview needs no --execute, and says what it found.
    const preview = await run(['staging', 'preview', '--older-than-ms', '1000'], env);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain('preview: 0 abandoned request directories');
  });

  it('needs exactly one cutoff, and one root', async () => {
    const root = freshDir('cli-cutoff');
    const env = { QE_REPORT_STAGING_ROOT: root };
    for (const argv of [
      ['staging', 'preview'],
      ['staging', 'preview', '--before', '2027-01-01T00:00:00Z', '--older-than-ms', '1000'],
    ]) {
      const answer = await run(argv, env);
      expect(answer.code, argv.join(' ')).toBe(2);
      expect(answer.err).toContain('exactly one of --before or --older-than-ms');
    }
    const badInstant = await run(['staging', 'preview', '--before', 'tomorrow'], env);
    expect(badInstant.code).toBe(2);
    expect(badInstant.err).toContain('--before must be');
    const noRoot = await run(['staging', 'preview', '--older-than-ms', '1000'], {});
    expect(noRoot.code).toBe(2);
    expect(noRoot.err).toContain('QE_REPORT_STAGING_ROOT must be set');
  });

  it('needs a retention pass to state the instant it judges by', async () => {
    const env = { QE_REPORT_BLOB_ROOT: freshDir('cli-blobs') };
    for (const argv of [
      ['maintenance', 'run'],
      ['maintenance', 'run', '--as-of', '2027-01-01T00:00:00Z', '--now'],
    ]) {
      const answer = await run(argv, env);
      expect(answer.code, argv.join(' ')).toBe(2);
      expect(answer.err).toContain('exactly one of --as-of or --now');
    }
    const badInstant = await run(
      ['maintenance', 'preview', '--as-of', '2027-02-30T00:00:00Z'],
      env,
    );
    expect(badInstant.code).toBe(2);
    expect(badInstant.err).toContain('--as-of must be');
    const noRoot = await run(['maintenance', 'preview', '--as-of', '2027-01-01T00:00:00Z'], {});
    expect(noRoot.code).toBe(2);
    expect(noRoot.err).toContain('QE_REPORT_BLOB_ROOT must be set');
  });

  it('needs a project for every index command, and a run for a verify', async () => {
    for (const argv of [
      ['index', 'status'],
      ['index', 'rebuild'],
      ['index', 'verify'],
    ]) {
      const answer = await run(argv);
      expect(answer.code, argv.join(' ')).toBe(2);
      expect(answer.err).toContain('--project is required');
    }
    const noRun = await run(['index', 'verify', '--project', 'web']);
    expect(noRun.code).toBe(2);
    expect(noRun.err).toContain('--run-id is required');
    const unknown = await run(['index', 'explain', '--project', 'web']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown command');
  });

  it('refuses a bound that is not a number, and an unknown option', async () => {
    const env = { QE_REPORT_STAGING_ROOT: freshDir('cli-bounds') };
    const badMax = await run(
      ['staging', 'preview', '--older-than-ms', '1000', '--max', 'lots'],
      env,
    );
    expect(badMax.code).toBe(2);
    expect(badMax.err).toContain('--max must be a whole number');
    const unknownOption = await run(['staging', 'preview', '--sweep'], env);
    expect(unknownOption.code).toBe(2);
    expect(unknownOption.err).toContain(USAGE_MARKER);
  });
});
