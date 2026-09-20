import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReadModel, type ReadModel } from 'qe-report-read-model';
import type { HistoryPage, PostgresQueries } from 'qe-report-postgres';
import { FIXTURES_DIR, manifest } from '../../protocol/test/helpers.js';
import {
  attemptFinished,
  attemptStarted,
  finished,
  freshRoot,
  started,
  testCase,
  writeRun,
  type EventSpec,
} from '../../read-model/test/synthetic.js';
import { occurrenceDto, runDto, runSummaryDto } from '../src/dto.js';
import { encodeRunRef } from '../src/run-ref.js';
import {
  HttpHarness,
  call,
  uploadRun,
  wholeHistory,
  wholeListing,
  type Answer,
  type Service,
} from './harness.js';

const harness = new HttpHarness();
beforeAll(() => harness.start());
afterAll(() => harness.stop());

const fixture = (name: string): string => join(FIXTURES_DIR, name);

/** The committed contract, compiled once: every response below is checked against it. */
const contract = JSON.parse(
  readFileSync(new URL('../../../../openapi/qe-report-api-v1.json', import.meta.url), 'utf8'),
) as { components: { schemas: Record<string, unknown> } };
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addSchema({ $id: 'qe', components: contract.components });
function conforms(name: string, value: unknown): void {
  const validate = ajv.getSchema(`qe#/components/schemas/${name}`);
  if (validate === undefined) throw new Error(`no schema ${name}`);
  expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
}
function problem(answer: Answer, status: number, code: string): void {
  expect(answer.status).toBe(status);
  expect(answer.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
  expect(answer.body.code).toBe(code);
  conforms('Problem', answer.body);
}

function corpus(): string[] {
  return manifest()
    .runs.filter((r) => r.outcome === 'VALID' && r.complete !== false)
    .map((r) => fixture(r.dir));
}

function historyKeys(model: ReadModel): { runnerName: string; historicalId: string }[] {
  const keys = new Map<string, { runnerName: string; historicalId: string }>();
  for (const run of model.runs()) {
    for (const e of run.executions) {
      if (e.runnerName === undefined || e.test.historicalId === undefined) continue;
      keys.set(JSON.stringify([e.runnerName, e.test.historicalId]), {
        runnerName: e.runnerName,
        historicalId: e.test.historicalId,
      });
    }
  }
  return [...keys.values()];
}

/** Every page of a history straight from the query layer, for the three-way comparison. */
async function directHistory(
  queries: PostgresQueries,
  projectId: string,
  runnerName: string,
  historicalId: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let after: HistoryPage['next'];
  for (;;) {
    const page = await queries.getTestHistoryPage({
      projectId,
      runnerName,
      historicalId,
      limit: 7,
      ...(after === undefined ? {} : { after }),
    });
    out.push(...page.occurrences.map(occurrenceDto));
    if (page.next === undefined) return out;
    after = page.next;
  }
}

async function corpusService(
  name: string,
): Promise<{ service: Service; token: string; model: ReadModel }> {
  const service = await harness.service(name);
  const token = await service.key('P');
  const dirs = corpus();
  for (const dir of dirs) {
    const answer = await uploadRun(service.base, token, dir);
    expect(answer.status, dir).toBe(201);
    conforms('IngestionResult', answer.body);
  }
  const built = await buildReadModel(dirs.map((d) => ({ projectId: 'P', runDirectory: d })));
  expect(built.problems).toEqual([]);
  return { service, token, model: built.model };
}

describe('the query API against the in-memory model and the query layer', () => {
  it('answers every run, history, and flakiness question of the corpus exactly as both do', async () => {
    const { service, token, model } = await corpusService('corpus');

    const listed = await wholeListing(service.base, token, 3);
    const direct = await service.queries.listRuns({ projectId: 'P', limit: 1000 });
    expect(listed).toEqual(direct.runs.map(runSummaryDto));
    expect(listed).toHaveLength(model.runs().length);
    for (const summary of listed) conforms('RunSummary', summary);

    for (const run of model.runs()) {
      const answer = await call(service.base, token, 'GET', `/v1/runs/${encodeRunRef(run.runId)}`);
      expect(answer.status, run.runId).toBe(200);
      expect(answer.body, run.runId).toEqual(runDto(run));
      conforms('Run', answer.body);
    }

    const keys = historyKeys(model);
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) {
      const label = `${key.runnerName}/${key.historicalId}`;
      const http = await wholeHistory(service.base, token, key.runnerName, key.historicalId, 2);
      const memory = model
        .getTestHistory('P', key.runnerName, key.historicalId)
        .occurrences.map(occurrenceDto);
      expect(http, label).toEqual(memory);
      expect(http, label).toEqual(
        await directHistory(service.queries, 'P', key.runnerName, key.historicalId),
      );
      for (const o of http) conforms('Occurrence', o);
      const flakiness = await call(service.base, token, 'POST', '/v1/flakiness/query', key);
      const expected = model.getFlakiness('P', key.runnerName, key.historicalId);
      expect(flakiness.body, label).toEqual({
        ...key,
        totalOccurrences: expected.totalOccurrences,
        flakyOccurrences: expected.flakyOccurrences,
        everFlaky: expected.everFlaky,
      });
      conforms('Flakiness', flakiness.body);
    }
    const page = await call(service.base, token, 'POST', '/v1/history/query', {
      ...keys[0],
      limit: 1,
    });
    conforms('HistoryPage', page.body);
    conforms('RunPage', (await call(service.base, token, 'GET', '/v1/runs?limit=2')).body);
    conforms('Health', (await call(service.base, undefined, 'GET', '/healthz')).body);
  });

  it('refuses cross-run answers while the project index is incomplete, and still reads one run', async () => {
    const { service, token, model } = await corpusService('incomplete');
    await service.db.pool.query('DELETE FROM qe_history_occurrences');
    await service.db.pool.query('DELETE FROM qe_run_query_index');
    const key = historyKeys(model)[0] as { runnerName: string; historicalId: string };
    for (const answer of [
      await call(service.base, token, 'GET', '/v1/runs'),
      await call(service.base, token, 'POST', '/v1/history/query', key),
      await call(service.base, token, 'POST', '/v1/flakiness/query', key),
    ]) {
      problem(answer, 503, 'QUERY_INDEX_INCOMPLETE');
      expect(answer.body).toMatchObject({
        totalRuns: model.runs().length,
        missingRuns: model.runs().length,
        staleRuns: 0,
      });
    }
    const run = model.runs()[0];
    expect(
      (await call(service.base, token, 'GET', `/v1/runs/${encodeRunRef(run?.runId ?? '')}`)).status,
    ).toBe(200);
    // A project whose index is incomplete does not make the service unready, or rebuild itself.
    expect((await call(service.base, undefined, 'GET', '/readyz')).status).toBe(200);
    expect((await call(service.base, token, 'GET', '/v1/runs')).status).toBe(503);
    await service.queries.rebuildProjectIndex({ projectId: 'P', maxRuns: 1000 });
    expect((await call(service.base, token, 'GET', '/v1/runs')).status).toBe(200);
  });
});

describe('cursors over HTTP', () => {
  /** A history whose order rests on every tie-breaker and a leap second, across several runs. */
  async function orderedService(
    name: string,
  ): Promise<{ service: Service; token: string; model: ReadModel }> {
    const service = await harness.service(name);
    const token = await service.key('P');
    const root = freshRoot(name);
    const runs: [string, string, number][] = [
      ['run-9', '2026-12-31T23:59:59.000+00:00', 1],
      ['run-8', '2026-12-31T23:59:59.999+00:00', 3],
      ['run-7', '2027-01-01T00:59:60.000+01:00', 1],
      ['run-0', '2026-12-31T23:59:60.500+00:00', 2],
      ['run-6', '2026-12-31T23:59:60.500+00:00', 1],
      ['run-5', '2027-01-01T00:00:00.000+00:00', 3],
      ['run-4', '2027-01-01T00:00:00.000+00:00', 1],
    ];
    const dirs: string[] = [];
    for (const [runId, at, repeats] of runs) {
      // A run with several executions of one test, as repeatEach produces, all at one instant.
      const events: EventSpec[] = [{ ...started('pw'), at }];
      for (let i = repeats; i >= 1; i -= 1) {
        events.push(
          { ...attemptStarted(`e-${i}-1`, 1, testCase(`e-${i}`, 'ordered')), at },
          { ...attemptFinished(`e-${i}-1`, 'passed'), at },
        );
      }
      events.push({ ...finished(), at });
      const dir = writeRun(root, runId, runId, [{ sessionId: 's', events }]);
      dirs.push(dir);
      expect((await uploadRun(service.base, token, dir)).status, runId).toBe(201);
    }
    const model = (await buildReadModel(dirs.map((d) => ({ projectId: 'P', runDirectory: d }))))
      .model;
    return { service, token, model };
  }

  it('pages repeated executions, equal instants, and a leap second exactly as the in-memory model orders them', async () => {
    const { service, token, model } = await orderedService('ordered');
    const memory = model.getTestHistory('P', 'pw', 'ordered').occurrences.map(occurrenceDto);
    expect(memory).toHaveLength(12);
    expect(memory.map((o) => o.runId)).toEqual([
      'run-9',
      'run-8',
      'run-8',
      'run-8',
      'run-7',
      'run-0',
      'run-0',
      'run-6',
      'run-4',
      'run-5',
      'run-5',
      'run-5',
    ]);
    for (const limit of [1, 2, 3, 5, 12, 100]) {
      const http = await wholeHistory(service.base, token, 'pw', 'ordered', limit);
      expect(http, `limit ${limit}`).toEqual(memory);
    }
    const listed = await wholeListing(service.base, token, 2);
    expect(listed.map((r) => r.runId)).toEqual([
      'run-4',
      'run-5',
      'run-6',
      'run-0',
      'run-7',
      'run-8',
      'run-9',
    ]);
  });

  it('refuses a cursor from another listing, another history, or another project', async () => {
    const { service, token } = await orderedService('cursor_binding');
    const other = await service.key('Q');
    const history = await call(service.base, token, 'POST', '/v1/history/query', {
      runnerName: 'pw',
      historicalId: 'ordered',
      limit: 2,
    });
    const historyCursor = history.body.nextCursor as string;
    const listing = await call(service.base, token, 'GET', '/v1/runs?limit=2');
    const listCursor = listing.body.nextCursor as string;
    expect(historyCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(listCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    // The cursors say nothing a client could build on: no SQL tuple, no raw instant.
    expect(historyCursor).not.toContain('(');
    const cases: [string, Promise<Answer>][] = [
      [
        'a listing cursor as a history cursor',
        call(service.base, token, 'POST', '/v1/history/query', {
          runnerName: 'pw',
          historicalId: 'ordered',
          cursor: listCursor,
        }),
      ],
      [
        'a history cursor as a listing cursor',
        call(service.base, token, 'GET', `/v1/runs?cursor=${historyCursor}`),
      ],
      [
        'a history cursor for another historical id',
        call(service.base, token, 'POST', '/v1/history/query', {
          runnerName: 'pw',
          historicalId: 'other',
          cursor: historyCursor,
        }),
      ],
      [
        'a history cursor for another runner',
        call(service.base, token, 'POST', '/v1/history/query', {
          runnerName: 'other',
          historicalId: 'ordered',
          cursor: historyCursor,
        }),
      ],
      [
        'a history cursor under another project key',
        call(service.base, other, 'POST', '/v1/history/query', {
          runnerName: 'pw',
          historicalId: 'ordered',
          cursor: historyCursor,
        }),
      ],
      [
        'a listing cursor under another project key',
        call(service.base, other, 'GET', `/v1/runs?cursor=${listCursor}`),
      ],
      ['a malformed cursor', call(service.base, token, 'GET', '/v1/runs?cursor=%24%24%24')],
      [
        'an edited cursor',
        call(service.base, token, 'GET', `/v1/runs?cursor=${listCursor.slice(0, -2)}AA`),
      ],
    ];
    for (const [label, pending] of cases) {
      const answer = await pending;
      expect(answer.status, label).toBe(400);
      problem(answer, 400, 'BAD_REQUEST');
    }
    // Offsets do not exist.
    expect((await call(service.base, token, 'GET', '/v1/runs?offset=2')).status).toBe(400);
  });
});
