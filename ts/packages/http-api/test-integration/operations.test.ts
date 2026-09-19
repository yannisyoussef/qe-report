import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyThrough } from '../../postgres/test-integration/support.js';
import { configFrom, startServer } from '../src/index.js';
import { HttpHarness, call } from './harness.js';

const harness = new HttpHarness();
beforeAll(() => harness.start());
afterAll(() => harness.stop());

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    chmodSync(r, 0o700);
    rmSync(r, { recursive: true, force: true });
  }
});

function freshRoots(): { blobRoot: string; stagingRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'qe-http-ops-'));
  roots.push(base);
  mkdirSync(join(base, 'blobs'));
  mkdirSync(join(base, 'staging'));
  return { blobRoot: join(base, 'blobs'), stagingRoot: join(base, 'staging') };
}

describe('the standalone server', () => {
  it('reads its configuration from the environment and binds to loopback unless told otherwise', () => {
    const config = configFrom({
      DATABASE_URL: 'postgres://example/db',
      QE_REPORT_BLOB_ROOT: '/b',
      QE_REPORT_STAGING_ROOT: '/s',
      QE_REPORT_MAX_ATTACHMENT_BYTES: '1024',
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'info',
      limits: { maxAttachmentBytes: 1024 },
    });
    expect(() => configFrom({})).toThrow(/DATABASE_URL/u);
    expect(() =>
      configFrom({
        DATABASE_URL: 'x',
        QE_REPORT_BLOB_ROOT: '/b',
        QE_REPORT_STAGING_ROOT: '/s',
        QE_REPORT_PORT: 'http',
      }),
    ).toThrow(/QE_REPORT_PORT/u);
    expect(() =>
      configFrom({
        DATABASE_URL: 'x',
        QE_REPORT_BLOB_ROOT: '/b',
        QE_REPORT_STAGING_ROOT: '/s',
        QE_REPORT_MAX_EVENT_PARTS: '-1',
      }),
    ).toThrow(/QE_REPORT_MAX_EVENT_PARTS/u);
  });

  it('refuses to start on a schema that is not current, and never migrates it', async () => {
    const db = await harness.pg.emptyDatabase('ops_old_schema');
    await applyThrough(db.pool, 4);
    const url = harness.pg.connectionUriFor(db);
    await expect(
      startServer({
        databaseUrl: url,
        host: '127.0.0.1',
        port: 0,
        logLevel: 'silent',
        limits: {},
        ...freshRoots(),
      }),
    ).rejects.toThrow(/migration 5 is not applied.*qe-report-admin migrate/u);
    const versions = await db.pool.query<{ version: number }>(
      'SELECT version FROM qe_schema_migrations ORDER BY version',
    );
    expect(versions.rows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    const empty = await harness.pg.emptyDatabase('ops_empty');
    await expect(
      startServer({
        databaseUrl: harness.pg.connectionUriFor(empty),
        host: '127.0.0.1',
        port: 0,
        logLevel: 'silent',
        limits: {},
        ...freshRoots(),
      }),
    ).rejects.toThrow(/never been migrated/u);
  });

  it('serves health and readiness on loopback once the schema is current, and reports an unusable root', async () => {
    const db = await harness.pg.database('ops_ready');
    const paths = freshRoots();
    const running = await startServer({
      databaseUrl: harness.pg.connectionUriFor(db),
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      limits: {},
      ...paths,
    });
    try {
      expect(running.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect((await call(running.address, undefined, 'GET', '/healthz')).body).toEqual({
        status: 'ok',
      });
      expect((await call(running.address, undefined, 'GET', '/readyz')).status).toBe(200);
      // A staging root the process can no longer write makes it unready, without naming the path.
      chmodSync(paths.stagingRoot, 0o500);
      const unready = await call(running.address, undefined, 'GET', '/readyz');
      expect(unready.status).toBe(503);
      expect(unready.body).toMatchObject({
        code: 'NOT_READY',
        problems: ['the staging root is not usable'],
      });
      expect(JSON.stringify(unready.body)).not.toContain(paths.stagingRoot);
      chmodSync(paths.stagingRoot, 0o700);
      expect((await call(running.address, undefined, 'GET', '/readyz')).status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it('refuses a staging root inside the blob root at start', async () => {
    const db = await harness.pg.database('ops_nested');
    const paths = freshRoots();
    const nested = join(paths.blobRoot, 'staging');
    mkdirSync(nested);
    await expect(
      startServer({
        databaseUrl: harness.pg.connectionUriFor(db),
        host: '127.0.0.1',
        port: 0,
        logLevel: 'silent',
        limits: {},
        blobRoot: paths.blobRoot,
        stagingRoot: nested,
      }),
    ).rejects.toThrow(/separate/u);
  });
});
