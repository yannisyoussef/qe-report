import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReadModel, discoverRunDirectories, projectRunDirectory } from '../src/index.js';
import {
  attachment,
  attemptFinished,
  attemptStarted,
  execution,
  finished,
  freshRoot,
  sha256,
  simpleRun,
  started,
  testCase,
  writeRun,
} from './synthetic.js';

describe('run directory discovery', () => {
  it('lists real run directories one level below runs, sorted, and reports everything else', () => {
    const root = freshRoot('disc');
    const b = simpleRun(
      root,
      'b-run',
      'run-b',
      'playwright',
      execution(testCase('e', 'h'), [['passed']]),
    );
    const a = simpleRun(
      root,
      'a-run',
      'run-a',
      'playwright',
      execution(testCase('e', 'h'), [['passed']]),
    );
    const elsewhere = freshRoot('elsewhere');
    simpleRun(
      elsewhere,
      'target',
      'run-x',
      'playwright',
      execution(testCase('e', 'h'), [['passed']]),
    );
    symlinkSync(join(elsewhere, 'runs', 'target'), join(root, 'runs', 'link'));
    writeFileSync(join(root, 'runs', 'notes.txt'), 'not a run');
    mkdirSync(join(root, 'runs', 'empty'));
    mkdirSync(join(root, 'runs', 'linked-events'));
    symlinkSync(
      join(elsewhere, 'runs', 'target', 'events'),
      join(root, 'runs', 'linked-events', 'events'),
    );
    mkdirSync(join(root, 'runs', 'nested', 'deeper', 'events'), { recursive: true });

    const d = discoverRunDirectories(root);
    expect(d.runDirectories).toEqual([a, b]);
    expect(d.problems.map((p) => [p.code, p.path])).toEqual([
      ['NO_EVENTS_DIRECTORY', join(root, 'runs', 'empty')],
      ['SYMLINK_SKIPPED', join(root, 'runs', 'link')],
      ['SYMLINK_SKIPPED', join(root, 'runs', 'linked-events', 'events')],
      ['NO_EVENTS_DIRECTORY', join(root, 'runs', 'nested')],
      ['NOT_A_DIRECTORY', join(root, 'runs', 'notes.txt')],
    ]);
  });

  it('does not follow a runs collection that is itself a link', () => {
    const root = freshRoot('linkroot');
    const elsewhere = freshRoot('elsewhere');
    simpleRun(elsewhere, 'r', 'run-1', 'playwright', execution(testCase('e', 'h'), [['passed']]));
    symlinkSync(join(elsewhere, 'runs'), join(root, 'runs'));
    const d = discoverRunDirectories(root);
    expect(d.runDirectories).toEqual([]);
    expect(d.problems.map((p) => [p.code, p.path])).toEqual([
      ['SYMLINK_SKIPPED', join(root, 'runs')],
    ]);
  });

  it('reports a missing runs collection instead of scanning the root', () => {
    const root = freshRoot('none');
    mkdirSync(join(root, 'events'));
    const d = discoverRunDirectories(root);
    expect(d.runDirectories).toEqual([]);
    expect(d.problems.map((p) => p.code)).toEqual(['RUNS_DIRECTORY_MISSING']);
  });

  it('carries discovery problems into the build with the project id, and ingests nothing through a link', async () => {
    const root = freshRoot('build');
    simpleRun(root, 'real', 'run-1', 'playwright', execution(testCase('e', 'h'), [['passed']]));
    const elsewhere = freshRoot('elsewhere');
    simpleRun(
      elsewhere,
      'target',
      'run-2',
      'playwright',
      execution(testCase('e', 'h'), [['passed']]),
    );
    symlinkSync(join(elsewhere, 'runs', 'target'), join(root, 'runs', 'link'));
    const { model, problems } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(model.runs().map((r) => r.runId)).toEqual(['run-1']);
    expect(problems.map((p) => [p.code, p.projectId, p.runDirectory])).toEqual([
      ['SYMLINK_SKIPPED', 'A', join(root, 'runs', 'link')],
    ]);
  });
});

describe('entries inside a run directory', () => {
  it('rejects a run whose event file or attachment is a link or not a regular file, before validation', async () => {
    const elsewhere = freshRoot('secret');
    writeFileSync(join(elsewhere, 'secret.txt'), 'password=hunter2\n');
    const root = freshRoot('entries');
    const body = execution(testCase('e', 'h'), [['passed']]);
    const linkedEvent = simpleRun(root, 'linked-event', 'run-1', 'playwright', body);
    symlinkSync(join(elsewhere, 'secret.txt'), join(linkedEvent, 'events', 'zz.ndjson'));
    const linkedBytes = simpleRun(root, 'linked-bytes', 'run-2', 'playwright', body);
    mkdirSync(join(linkedBytes, 'attachments'));
    symlinkSync(join(elsewhere, 'secret.txt'), join(linkedBytes, 'attachments', 'a'.repeat(64)));
    const dirEvent = simpleRun(root, 'dir-event', 'run-3', 'playwright', body);
    mkdirSync(join(dirEvent, 'events', 'nested.ndjson'));
    const good = simpleRun(root, 'good', 'run-4', 'playwright', body);

    const { model, problems } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(model.runs().map((r) => r.runDirectory)).toEqual([good]);
    expect(problems.map((p) => [p.code, p.runDirectory, p.message])).toEqual([
      [
        'NOT_A_REGULAR_FILE',
        dirEvent,
        `${join(dirEvent, 'events', 'nested.ndjson')} is not a regular file`,
      ],
      [
        'SYMLINK_SKIPPED',
        linkedBytes,
        `${join(linkedBytes, 'attachments', 'a'.repeat(64))} is not a regular file`,
      ],
      [
        'SYMLINK_SKIPPED',
        linkedEvent,
        `${join(linkedEvent, 'events', 'zz.ndjson')} is not a regular file`,
      ],
    ]);
    expect(JSON.stringify(problems)).not.toContain('hunter2');
    const direct = await projectRunDirectory({ projectId: 'A', runDirectory: linkedEvent });
    expect(direct.kind === 'rejected' && direct.problem.diagnostics).toEqual([]);
  });

  it("receives the validator's own refusal when a direct run directory links its attachments directory", async () => {
    // Discovery is bypassed and the entry check sees regular files inside the linked directory,
    // so this rejection comes from the validator itself: defence in depth, not a single gate.
    const elsewhere = freshRoot('bytes');
    const root = freshRoot('attachments-link');
    const bytes = Buffer.from('linked bytes');
    const dir = writeRun(root, 'linked', 'run-1', [
      {
        sessionId: 's',
        events: [
          started('playwright'),
          attemptStarted('a', 1, testCase('e', 'h')),
          attachment('a', bytes),
          attemptFinished('a', 'passed'),
          finished(),
        ],
      },
    ]);
    mkdirSync(join(elsewhere, 'attachments'));
    writeFileSync(join(elsewhere, 'attachments', sha256(bytes)), bytes);
    symlinkSync(join(elsewhere, 'attachments'), join(dir, 'attachments'));
    const result = await projectRunDirectory({ projectId: 'A', runDirectory: dir });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.problem.code).toBe('RUN_INVALID');
    expect(result.problem.diagnostics.map((d) => [d.code, d.file])).toEqual([
      ['UNSAFE_FILESYSTEM_ENTRY', join(dir, 'attachments')],
    ]);
  });

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  (process.platform === 'win32' || asRoot ? it.skip : it)(
    'reports an event file the validator cannot open as VALIDATION_ERROR (not run as root, not Windows)',
    async () => {
      const root = freshRoot('unreadable');
      const dir = simpleRun(
        root,
        'r',
        'run-1',
        'playwright',
        execution(testCase('e', 'h'), [['passed']]),
      );
      chmodSync(join(dir, 'events', 's-1.ndjson'), 0);
      const { model, problems } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
      expect(model.runs()).toEqual([]);
      expect(problems.map((p) => [p.code, p.runDirectory])).toEqual([['VALIDATION_ERROR', dir]]);
      expect(problems[0]?.message).toContain('EACCES');
    },
  );

  it('projects a run with an absurdly deep unknown property: the validator survives it', async () => {
    const root = freshRoot('deep');
    const dir = simpleRun(
      root,
      'deep',
      'run-1',
      'playwright',
      execution(testCase('e', 'h'), [['passed']]),
    );
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    const line = JSON.stringify({
      protocolVersion: '0.3.0',
      eventId: 'x-1',
      eventType: 'session.started',
      runId: 'run-1',
      sessionId: 'x',
      sequence: 1,
      occurredAt: '2026-09-12T10:00:00.000+00:00',
      payload: { producer: { name: 'p' } },
    }).replace('"payload":{', `"payload":{"extra":${deep},`);
    const done = line
      .replace('"eventId":"x-1"', '"eventId":"x-2"')
      .replace('"eventType":"session.started"', '"eventType":"session.finished"')
      .replace('"sequence":1', '"sequence":2')
      .replace(/"payload":\{.*\}$/u, '"payload":{}}');
    writeFileSync(join(dir, 'events', 'x.ndjson'), `${line}\n${done}\n`);
    const { model, problems } = await buildReadModel([{ projectId: 'A', outputRoot: root }]);
    expect(problems).toEqual([]);
    expect(model.getRun('A', 'run-1')?.sessions.map((s) => s.sessionId)).toEqual(['s-1', 'x']);
  });
});
