import { describe, expect, it } from 'vitest';
import { validateLines } from 'qe-report-validator';
import {
  buildReadModel,
  compareHistoryInstants,
  historyInstant,
  type ExecutionOccurrence,
  type HistoryInstant,
} from '../src/index.js';
import { compareHistoryOccurrences } from '../src/history-order.js';
import {
  attemptFinished,
  attemptStarted,
  finished,
  freshRoot,
  started,
  testCase,
  writeRun,
} from './synthetic.js';

/** Whether the validator accepts a timestamp as an event's `occurredAt`. */
async function validatorAccepts(occurredAt: string): Promise<boolean> {
  const line = JSON.stringify({
    protocolVersion: '0.3.0',
    eventId: 'e-1',
    eventType: 'session.started',
    runId: 'r',
    sessionId: 's',
    sequence: 1,
    occurredAt,
    payload: { producer: { name: 'p' }, runner: { name: 'pw' } },
  });
  const report = await validateLines([line]);
  return !report.diagnostics.some((d) => d.code === 'SCHEMA_INVALID');
}

const ORDINARY = [
  '2026-09-12T10:00:00Z',
  '2026-09-12T10:00:00.1Z',
  '2026-09-12T10:00:00.123456789+00:00',
  '2026-09-12T10:00:00.9999-05:30',
  '2024-02-29T12:00:00+14:00',
  '0000-01-01T00:00:00Z',
  '0000-01-01T00:00:00+23:59',
  '9999-12-31T23:59:59.999999999-23:59',
  '2016-12-31T23:59:59.999Z',
];

const LEAP = [
  '2016-12-31T23:59:60Z',
  '2016-12-31T23:59:60.5+00:00',
  '2017-01-01T00:59:60.25+01:00',
  '2016-12-31T18:29:60-05:30',
  '2017-01-01T00:29:60+00:30',
];

const INVALID = [
  '2026-13-01T00:00:00Z',
  '2026-02-29T00:00:00Z',
  '2026-04-31T00:00:00Z',
  '2026-01-01T24:00:00Z',
  '2026-01-01T23:60:00Z',
  '2026-01-01T23:58:60Z',
  '2026-01-01T23:59:60+01:00',
  '2026-01-01T23:59:61Z',
  '2026-01-01T00:00:00+24:00',
  '2026-01-01T00:00:00+00:60',
  '2026-01-01 00:00:00Z',
  '2026-01-01T00:00:00',
  '2026-01-01t00:00:00z',
  '2026-01-01T00:00:00.Z',
  '2026-01-01T00:00:00.1234567890Z',
];

describe('history instant', () => {
  it('is Date.parse for every ordinary protocol timestamp, so the established order is kept', () => {
    for (const at of ORDINARY) {
      expect(historyInstant(at), at).toEqual({ epochMs: Date.parse(at), leap: 0 });
    }
  });

  it('places a leap second after the second before it and before the one after it', () => {
    const before = historyInstant('2016-12-31T23:59:59.999Z');
    const leapStart = historyInstant('2016-12-31T23:59:60Z');
    const leapMiddle = historyInstant('2016-12-31T23:59:60.5Z');
    const leapEnd = historyInstant('2016-12-31T23:59:60.999999Z');
    const after = historyInstant('2017-01-01T00:00:00Z');
    const ordered = [before, leapStart, leapMiddle, leapEnd, after];
    for (const [i, earlier] of ordered.slice(0, -1).entries()) {
      const later = ordered[i + 1] as HistoryInstant;
      expect(compareHistoryInstants(earlier, later), String(i)).toBeLessThan(0);
    }
    expect(leapStart).toEqual({ epochMs: Date.parse('2016-12-31T23:59:59.999Z'), leap: 1 });
    expect(leapEnd.leap).toBe(1000);
    // The same UTC leap second written in another offset is the same position.
    expect(historyInstant('2017-01-01T00:59:60.5+01:00')).toEqual(leapMiddle);
    expect(historyInstant('2016-12-31T18:29:60.5-05:30')).toEqual(leapMiddle);
  });

  it('accepts exactly the timestamps the validator accepts, and refuses to place any other', async () => {
    for (const at of [...ORDINARY, ...LEAP]) {
      expect(await validatorAccepts(at), at).toBe(true);
      expect(() => historyInstant(at), at).not.toThrow();
    }
    for (const at of INVALID) {
      expect(await validatorAccepts(at), at).toBe(false);
      expect(() => historyInstant(at), at).toThrow(RangeError);
    }
  });

  it('orders occurrences around a leap second chronologically, whatever the identifiers say', () => {
    // Run ids chosen against the timestamps: an order that fell back on them would be reversed.
    const at = (runId: string, occurredAt: string): ExecutionOccurrence =>
      ({ runId, executionId: 'e', occurredAt }) as ExecutionOccurrence;
    const expected = [
      at('run-z', '2016-12-31T23:59:59Z'),
      at('run-y', '2016-12-31T23:59:59.999Z'),
      at('run-x', '2016-12-31T23:59:60Z'),
      at('run-w', '2016-12-31T23:59:60.999Z'),
      at('run-v', '2017-01-01T00:00:00Z'),
    ];
    expect([...expected].reverse().sort(compareHistoryOccurrences)).toEqual(expected);
  });
});

describe('history order in the read model', () => {
  it('presents a leap-second boundary in history order', async () => {
    const root = freshRoot('leap-boundary');
    const times: [string, string][] = [
      ['run-c', '2016-12-31T23:59:59.000+00:00'],
      ['run-b', '2016-12-31T23:59:60.000+00:00'],
      ['run-a', '2017-01-01T00:00:00.000+00:00'],
    ];
    const sources = times.map(([runId, at]) => ({
      projectId: 'P',
      runDirectory: writeRun(root, runId, runId, [
        {
          sessionId: 's',
          events: [
            { ...started('pw'), at },
            { ...attemptStarted('e-1', 1, testCase('e', 'h')), at },
            { ...attemptFinished('e-1', 'passed'), at },
            { ...finished(), at },
          ],
        },
      ]),
    }));
    const { model, problems } = await buildReadModel(sources);
    expect(problems).toEqual([]);
    expect(model.getTestHistory('P', 'pw', 'h').occurrences.map((o) => o.runId)).toEqual([
      'run-c',
      'run-b',
      'run-a',
    ]);
  });
});
