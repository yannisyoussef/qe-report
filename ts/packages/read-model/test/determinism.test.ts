import { cpSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadModel, buildReadModel, projectRunDirectory } from '../src/index.js';
import type { ProjectedRun } from '../src/index.js';
import { FIXTURES_DIR } from '../../protocol/test/helpers.js';
import { freshRoot } from './synthetic.js';

/** The run without its locator, which is the only field allowed to differ between copies. */
function facts(run: ProjectedRun): Omit<ProjectedRun, 'runDirectory'> {
  const { runDirectory: _dir, ...rest } = run;
  void _dir;
  return rest;
}

/** Copies a fixture run and renames its session files so that name order is reversed. */
function reversedCopy(fixture: string): string {
  const root = freshRoot('rev');
  const dir = join(root, 'runs', 'copy');
  mkdirSync(join(root, 'runs'), { recursive: true });
  cpSync(join(FIXTURES_DIR, fixture), dir, { recursive: true });
  const files = readdirSync(join(dir, 'events')).sort();
  files.forEach((f, i) => {
    const prefix = String(files.length - i).padStart(3, '0');
    renameSync(join(dir, 'events', f), join(dir, 'events', `${prefix}-${f}`));
  });
  return dir;
}

async function project(dir: string): Promise<ProjectedRun> {
  const r = await projectRunDirectory({ projectId: 'A', runDirectory: dir });
  if (r.kind !== 'projected') throw new Error(JSON.stringify(r.problem));
  return r.run;
}

describe('determinism', () => {
  it('projects the same run identically whatever the enumeration order of its session files', async () => {
    for (const fixture of [
      'runs/forked',
      'runs/playwright',
      'runs/coordinator',
      'runs/junit',
      'runs/retry-across-sessions',
    ]) {
      const original = await project(join(FIXTURES_DIR, fixture));
      const again = await project(join(FIXTURES_DIR, fixture));
      const reversed = await project(reversedCopy(fixture));
      expect(facts(again), fixture).toEqual(facts(original));
      expect(facts(reversed), fixture).toEqual(facts(original));
    }
  });

  it('assembles the same snapshot whatever the order of its runs', async () => {
    const dirs = ['runs/forked', 'runs/playwright', 'runs/karate', 'runs/flaky-session-passed'].map(
      (f) => join(FIXTURES_DIR, f),
    );
    const forward = await buildReadModel(
      dirs.map((runDirectory) => ({ projectId: 'A', runDirectory })),
    );
    const backward = await buildReadModel(
      [...dirs].reverse().map((runDirectory) => ({ projectId: 'A', runDirectory })),
    );
    expect(backward.model.runs()).toEqual(forward.model.runs());
    expect(backward.model.blobs()).toEqual(forward.model.blobs());
    for (const run of forward.model.runs()) {
      for (const e of run.executions) {
        if (e.test.historicalId === undefined || e.runnerName === undefined) continue;
        expect(backward.model.getTestHistory('A', e.runnerName, e.test.historicalId)).toEqual(
          forward.model.getTestHistory('A', e.runnerName, e.test.historicalId),
        );
      }
    }
    const reassembled = ReadModel.assemble([...forward.model.runs()].reverse());
    expect(reassembled.model.runs()).toEqual(forward.model.runs());
  });
});
