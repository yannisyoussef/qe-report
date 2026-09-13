import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRunDirectory, validateRunDirectorySnapshot } from 'qe-report-validator';
import type { ValidatedRun } from 'qe-report-validator';
import type { AttemptStartedEvent, Event, SessionStartedEvent } from 'qe-report-protocol';
import { AmbiguousRunError, projectRun, projectRunDirectory } from '../src/index.js';
import { FIXTURES_DIR } from '../../protocol/test/helpers.js';

/**
 * The execution invariants (one attempt per attempt number, one history identity, one runner
 * family per execution) are enforced by the validator, so validation-first ingestion rejects a
 * run that breaks them before projection. The projector keeps the same checks for callers that
 * hand it a snapshot the validator did not produce.
 */
describe('validation-first ingestion of runs that break an execution invariant', () => {
  const cases: [string, string][] = [
    ['runs/invalid/duplicate-attempt-number', 'DUPLICATE_ATTEMPT_NUMBER'],
    ['runs/invalid/historical-id-changed', 'HISTORICAL_IDENTITY_CHANGED'],
    ['runs/invalid/historical-stability-changed', 'HISTORICAL_IDENTITY_CHANGED'],
    ['runs/invalid/historical-identity-appeared', 'HISTORICAL_IDENTITY_CHANGED'],
    ['runs/invalid/execution-runner-changed', 'EXECUTION_RUNNER_CHANGED'],
    ['runs/invalid/execution-runner-absent', 'EXECUTION_RUNNER_CHANGED'],
  ];
  for (const [fixture, detail] of cases) {
    it(`${fixture} is RUN_INVALID with LIFECYCLE_INVALID(${detail}), never PROJECTION_AMBIGUOUS`, async () => {
      const dir = join(FIXTURES_DIR, fixture);
      const result = await projectRunDirectory({ projectId: 'A', runDirectory: dir });
      expect(result.kind).toBe('rejected');
      if (result.kind !== 'rejected') return;
      expect(result.problem.code).toBe('RUN_INVALID');
      expect(result.problem.runId).toBeDefined();
      expect(result.problem.diagnostics.map((d) => [d.code, d.detail])).toContainEqual([
        'LIFECYCLE_INVALID',
        detail,
      ]);
    });
  }
});

/** A valid snapshot with one event replaced: what a caller of projectRun could fabricate. */
async function fabricated(
  fixture: string,
  replace: (events: readonly Event[]) => Event[],
): Promise<ValidatedRun> {
  const snapshot = await validateRunDirectorySnapshot(join(FIXTURES_DIR, fixture));
  expect(snapshot.report.valid).toBe(true);
  return { report: snapshot.report, events: replace(snapshot.events), sourceLines: [] };
}

function attemptStarted(events: readonly Event[], attemptId: string): AttemptStartedEvent {
  const e = events.find(
    (x): x is AttemptStartedEvent =>
      x.eventType === 'attempt.started' && x.payload.attemptId === attemptId,
  );
  if (!e) throw new Error(`no attempt.started for ${attemptId}`);
  return e;
}

function swap(events: readonly Event[], from: Event, to: Event): Event[] {
  return events.map((e) => (e === from ? to : e));
}

describe('defensive projector for snapshots the validator did not produce', () => {
  it('refuses two attempts of one execution with one attempt number', async () => {
    const snapshot = await fabricated('runs/flaky-session-passed', (events) => {
      const second = attemptStarted(events, 'a-2');
      return swap(events, second, {
        ...second,
        payload: { ...second.payload, attemptNumber: 1 },
      });
    });
    let caught: unknown;
    try {
      projectRun('A', 'dir', snapshot);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AmbiguousRunError);
    expect((caught as AmbiguousRunError).detail).toBe('DUPLICATE_ATTEMPT_NUMBER');
    expect((caught as AmbiguousRunError).executionId).toBe('t-1');
  });

  it('refuses a history identity that changes between attempts', async () => {
    for (const change of [
      { historicalId: 'h-other' },
      { historicalIdStability: 'uncertain' as const },
    ]) {
      const snapshot = await fabricated('runs/flaky-session-passed', (events) => {
        const second = attemptStarted(events, 'a-2');
        return swap(events, second, {
          ...second,
          payload: { ...second.payload, test: { ...second.payload.test, ...change } },
        });
      });
      let detail: string | undefined;
      try {
        projectRun('A', 'dir', snapshot);
      } catch (e) {
        detail = (e as AmbiguousRunError).detail;
      }
      expect(detail).toBe('HISTORICAL_IDENTITY_CHANGED');
    }
  });

  it('refuses an execution whose sessions declare different runners, under the validator name', async () => {
    const snapshot = await fabricated('runs/retry-across-sessions', (events) => {
      const second = events.find(
        (x): x is SessionStartedEvent =>
          x.eventType === 'session.started' && x.sessionId === 'worker-2',
      );
      if (!second) throw new Error('no second session');
      return swap(events, second, {
        ...second,
        payload: { ...second.payload, runner: { name: 'another-runner' } },
      });
    });
    let detail: string | undefined;
    try {
      projectRun('A', 'dir', snapshot);
    } catch (e) {
      detail = (e as AmbiguousRunError).detail;
    }
    expect(detail).toBe('EXECUTION_RUNNER_CHANGED');
  });

  it('is never reached through validation-first ingestion: the same shapes on disk are RUN_INVALID', async () => {
    for (const fixture of [
      'runs/invalid/duplicate-attempt-number',
      'runs/invalid/historical-id-changed',
      'runs/invalid/execution-runner-changed',
    ]) {
      const dir = join(FIXTURES_DIR, fixture);
      expect((await validateRunDirectory(dir)).valid).toBe(false);
      const result = await projectRunDirectory({ projectId: 'A', runDirectory: dir });
      expect(result.kind === 'rejected' && result.problem.code).toBe('RUN_INVALID');
    }
  });
});
