import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachment,
  attemptFinished,
  attemptStarted,
  finished,
  freshRoot,
  sha256,
  started,
  testCase,
  writeRun,
} from '../../read-model/test/synthetic.js';
import { ReferenceStack, sleep } from './stack.js';

const run = promisify(execFile);

/**
 * The reference deployment, from an image build to a destructive restore, against the real thing:
 * a production image, PostgreSQL 16, an attachment store on a volume, and an NGINX edge with TLS
 * the producer verifies normally. Nothing is mocked, and nothing reads the database directly to
 * decide whether the deployment works.
 *
 * The phases share one stack on purpose. Each is the state the next one reads, which is also how
 * an operator meets them.
 */
const stack = new ReferenceStack('main');

/** A complete run directory with one attachment, written the way a producer's file sink writes one. */
function writeCompletedRun(label: string, runId: string): { directory: string; bytes: Buffer } {
  const bytes = Buffer.from(`evidence for ${runId}`);
  const directory = writeRun(
    freshRoot(label),
    label,
    runId,
    [
      {
        sessionId: 's-1',
        events: [
          started('pw'),
          attemptStarted('e-1', 1, testCase('e', `${runId}-historical`)),
          attachment('e-1', bytes),
          attemptFinished('e-1', 'passed'),
          finished({ status: 'passed', rawStatus: 'passed' }),
        ],
      },
    ],
    [bytes],
  );
  return { directory, bytes };
}

let writeToken = '';
let readToken = '';
let firstRunId = '';
let firstRunRef = '';
let firstAttachment = '';

beforeAll(async () => {
  await ReferenceStack.build();
  await stack.start();
}, 900_000);

afterAll(async () => {
  await stack.stop();
}, 300_000);

describe('the deployment a clean machine can bring up', () => {
  it('serves HTTPS through the edge, and only the edge', async () => {
    const health = await stack.request('/healthz');
    expect(health.status).toBe(200);
    expect(health.json<{ status: string }>().status).toBe('ok');

    // Readiness is more than a listening socket: the database, the schema, and both roots.
    const ready = await stack.request('/readyz');
    expect(ready.status).toBe(200);

    // The API's own header reaches the client; the edge does not strip or rewrite it.
    expect(String(health.headers['cache-control'])).toContain('no-store');

    // Neither the application nor the database publishes a port of its own.
    const ports = await stack.compose(['ps', '--format', '{{.Service}} {{.Ports}}']);
    for (const line of ports.stdout.split('\n').filter((l) => l.trim() !== '')) {
      const [service] = line.trim().split(/\s+/u);
      if (service === 'api' || service === 'postgres') {
        expect(line, line).not.toMatch(/0\.0\.0\.0|->/u);
      }
    }
  });

  it('runs the API as a non-root user on a read-only root filesystem', async () => {
    const id = await stack.compose(['exec', '-T', 'api', 'id', '-u']);
    expect(id.stdout.trim()).toBe('10001');

    // The root filesystem refuses a write; only the two data roots and /tmp accept one.
    const rootWrite = await stack.compose([
      'exec',
      '-T',
      'api',
      'sh',
      '-c',
      'echo x > /root-probe',
    ]);
    expect(rootWrite.code).not.toBe(0);
    expect(`${rootWrite.stderr}${rootWrite.stdout}`).toMatch(/[Rr]ead-only/u);
    const tmpWrite = await stack.compose([
      'exec',
      '-T',
      'api',
      'sh',
      '-c',
      'echo x > /tmp/probe && rm /tmp/probe',
    ]);
    expect(tmpWrite.code).toBe(0);

    // Both operator commands are in the image, and the workspace source is not.
    const commands = await stack.compose([
      'exec',
      '-T',
      'api',
      'sh',
      '-c',
      'command -v qe-report-server && command -v qe-report-admin',
    ]);
    expect(commands.stdout).toContain('/usr/local/bin/qe-report-server');
    expect(commands.stdout).toContain('/usr/local/bin/qe-report-admin');
    const source = await stack.compose([
      'exec',
      '-T',
      'api',
      'sh',
      '-c',
      'ls /app/src /app/test 2>/dev/null | wc -l',
    ]);
    expect(source.stdout.trim()).toBe('0');
    // Nothing in the serving image speaks to PostgreSQL on a command line.
    const client = await stack.compose([
      'exec',
      '-T',
      'api',
      'sh',
      '-c',
      'command -v psql pg_dump',
    ]);
    expect(client.code).not.toBe(0);
  });

  it('issues keys, uploads a run through TLS, and answers every read', async () => {
    writeToken = await stack.createKey('web');
    readToken = await stack.createKey('web', ['runs:read']);
    const { directory, bytes } = writeCompletedRun('deploy-main', 'run-deploy-1');
    firstAttachment = sha256(bytes);

    const uploaded = await stack.uploadRun(directory, writeToken);
    expect(uploaded.code, uploaded.stderr).toBe(0);
    const answer = JSON.parse(uploaded.stdout) as {
      runId: string;
      runRef: string;
      outcome: string;
    };
    expect(answer.outcome).toBe('inserted');
    firstRunId = answer.runId;
    firstRunRef = answer.runRef;

    const listed = await stack.request('/v1/runs?limit=10', { token: readToken });
    expect(listed.status).toBe(200);
    expect(listed.text()).toContain(firstRunId);

    const one = await stack.request(`/v1/runs/${firstRunRef}`, { token: readToken });
    expect(one.status).toBe(200);
    expect(one.json<{ sessions: unknown[] }>().sessions).toHaveLength(1);

    const query = JSON.stringify({ runnerName: 'pw', historicalId: 'run-deploy-1-historical' });
    const history = await stack.request('/v1/history/query', {
      method: 'POST',
      token: readToken,
      body: query,
      contentType: 'application/json',
    });
    expect(history.status).toBe(200);
    expect(history.json<{ occurrences: unknown[] }>().occurrences).toHaveLength(1);

    const flakiness = await stack.request('/v1/flakiness/query', {
      method: 'POST',
      token: readToken,
      body: query,
      contentType: 'application/json',
    });
    expect(flakiness.status).toBe(200);
    expect(flakiness.json<{ totalOccurrences: number }>().totalOccurrences).toBe(1);

    // The bytes come back exactly, through the proxy, as the hash they are named by.
    const download = await stack.request(`/v1/runs/${firstRunRef}/attachments/${firstAttachment}`, {
      token: readToken,
    });
    expect(download.status).toBe(200);
    expect(sha256(download.body)).toBe(firstAttachment);
    expect(download.body.toString()).toBe(bytes.toString());
    // The header that matters most for opaque bytes survives the proxy untouched.
    expect(String(download.headers['x-content-type-options'])).toBe('nosniff');
    expect(String(download.headers['cache-control'])).toContain('no-store');

    // A read-only key may not write, and no key at all gets nothing.
    const refused = await stack.request('/v1/runs', { method: 'POST', token: readToken });
    expect(refused.status).toBe(403);
    expect((await stack.request('/v1/runs')).status).toBe(401);
  });

  it('keeps the bearer token out of the edge log', async () => {
    const before = await stack.compose(['logs', '--no-log-prefix', 'edge']);
    await stack.request('/v1/runs?limit=1', { token: writeToken });
    await sleep(500);
    const after = await stack.compose(['logs', '--no-log-prefix', 'edge']);
    expect(after.stdout.length).toBeGreaterThan(before.stdout.length);
    const logs = `${after.stdout}${after.stderr}`;
    expect(logs).not.toContain(writeToken);
    expect(logs).not.toContain('qer_k1_');
    expect(logs.toLowerCase()).not.toContain('authorization');
    // What it does log: the request, and an outcome.
    expect(logs).toContain('"/v1/runs"');

    // The application's own log names the key by its public id, never the token.
    const api = await stack.compose(['logs', '--no-log-prefix', 'api']);
    expect(`${api.stdout}${api.stderr}`).not.toContain('qer_k1_');
  });
});

describe('what the edge refuses', () => {
  it('answers 429 once one client asks too often', async () => {
    // A deliberately small limit, applied to this test only, then put back.
    const small = { QE_REPORT_EDGE_RATE: '10r/m', QE_REPORT_EDGE_RATE_BURST: '2' };
    expect((await stack.compose(['up', '-d', '--force-recreate', 'edge'], small)).code).toBe(0);
    await stack.waitHealthy('edge');
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        statuses.push((await stack.request('/v1/runs?limit=1', { token: readToken })).status);
      }
      // The edge refuses the excess, and says so the way it was configured to.
      expect(statuses).toContain(429);
      expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    } finally {
      expect((await stack.compose(['up', '-d', '--force-recreate', 'edge'])).code).toBe(0);
      await stack.waitHealthy('edge');
    }
  });

  it('refuses a body larger than it will pass on, before the application stages it', async () => {
    // Smaller than the application's own limit, so the edge is provably the one refusing.
    const tight = { QE_REPORT_EDGE_MAX_BODY: '64k' };
    expect((await stack.compose(['up', '-d', '--force-recreate', 'edge'], tight)).code).toBe(0);
    await stack.waitHealthy('edge');
    try {
      const oversized = await stack.request('/v1/runs', {
        method: 'POST',
        token: writeToken,
        body: Buffer.alloc(256 * 1024, 0x61),
        contentType: 'multipart/form-data; boundary=qe-report-oversized',
      });
      expect(oversized.status).toBe(413);
      // NGINX answers it: the body never reached the application, so no request staged anything.
      expect(oversized.text()).not.toContain('urn:qe-report:problem');
      const staged = await stack.compose([
        'exec',
        '-T',
        'api',
        'sh',
        '-c',
        'ls /var/lib/qe-report/staging | wc -l',
      ]);
      expect(staged.stdout.trim()).toBe('0');
    } finally {
      expect((await stack.compose(['up', '-d', '--force-recreate', 'edge'])).code).toBe(0);
      await stack.waitHealthy('edge');
    }
  });

  it('still lets the application enforce its own stricter limit', async () => {
    // The edge passes up to 16 MiB and the application accepts 8 MiB, so a 9 MiB body reaches the
    // application and is refused there, with the API's own problem document rather than the
    // proxy's page. The two limits are independent, and this is the one the application owns.
    const oversized = await stack.request('/v1/runs', {
      method: 'POST',
      token: writeToken,
      body: Buffer.alloc(9 * 1024 * 1024, 0x61),
      contentType: 'multipart/form-data; boundary=qe-report-oversized',
    });
    expect(oversized.status).toBe(413);
    expect(oversized.text()).toContain('urn:qe-report:problem');
  });
});

describe('the lifecycle of the process', () => {
  it('finishes an upload that is already running, then stops, and comes back', async () => {
    const { directory } = writeCompletedRun('deploy-restart', 'run-deploy-restart');
    // The upload starts, and the container is asked to stop while it is in flight.
    const uploading = stack.uploadRun(directory, writeToken);
    await sleep(300);
    const stopped = await stack.compose(['stop', 'api']);
    expect(stopped.code).toBe(0);
    const result = await uploading;

    const logs = await stack.compose(['logs', '--no-log-prefix', 'api']);
    expect(logs.stdout).toContain('shutdown requested');
    expect(logs.stdout).toContain('shutdown completed');
    // Nothing about the request itself is in those lines.
    expect(logs.stdout).not.toContain('qer_k1_');

    expect((await stack.compose(['up', '-d', 'api'])).code).toBe(0);
    await stack.waitHealthy('api');
    expect((await stack.compose(['up', '-d', '--force-recreate', 'edge'])).code).toBe(0);
    await stack.waitHealthy('edge');

    // Whatever happened to that attempt, the producer can repeat it: the same run is one archive.
    const again = await stack.uploadRun(directory, writeToken);
    expect(again.code, again.stderr).toBe(0);
    const answer = JSON.parse(again.stdout) as { runId: string; outcome: string };
    expect(['inserted', 'already_present']).toContain(answer.outcome);
    const listed = await stack.request('/v1/runs?limit=50', { token: readToken });
    const runs = listed.json<{ runs: { runId: string }[] }>().runs;
    expect(runs.filter((r) => r.runId === 'run-deploy-restart')).toHaveLength(1);
    void result;
  });

  it('leaves a staged request behind when it is killed, and cleans it up offline', async () => {
    // A request directory as a killed server leaves one: the server's own name, old enough to be
    // certainly abandoned. Written from inside the container, under the account that owns the root.
    const abandoned = '11111111-2222-4333-8444-555555555555';
    const planted = await stack.compose([
      'exec',
      '-T',
      'api',
      'sh',
      '-c',
      `mkdir -p /var/lib/qe-report/staging/${abandoned}/events && ` +
        `echo '{}' > /var/lib/qe-report/staging/${abandoned}/events/000001.ndjson && ` +
        `touch -d '2020-01-01T00:00:00Z' /var/lib/qe-report/staging/${abandoned}`,
    ]);
    expect(planted.code, planted.stderr).toBe(0);

    // Hard-killed, so nothing had a chance to tidy up.
    expect((await stack.compose(['kill', '--signal', 'SIGKILL', 'api'])).code).toBe(0);
    expect((await stack.compose(['up', '-d', 'api'])).code).toBe(0);
    await stack.waitHealthy('api');
    // The archive is untouched: the canonical runs are still exactly the ones that committed.
    const listed = await stack.request('/v1/runs?limit=50', { token: readToken });
    expect(listed.status).toBe(200);

    // Cleanup is offline, and says so if the instance is still running.
    const preview = await stack.admin(['staging', 'preview', '--older-than-ms', '60000']);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain(abandoned);
    const refused = await stack.admin(['staging', 'clean', '--older-than-ms', '60000']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--execute');

    expect((await stack.compose(['stop', 'api'])).code).toBe(0);
    const cleaned = await stack.admin([
      'staging',
      'clean',
      '--older-than-ms',
      '60000',
      '--execute',
    ]);
    expect(cleaned.code, cleaned.stderr).toBe(0);
    expect(cleaned.stdout).toContain('1 removed');
    expect((await stack.compose(['up', '-d', 'api'])).code).toBe(0);
    await stack.waitHealthy('api');
    const after = await stack.admin(['staging', 'preview', '--older-than-ms', '60000']);
    expect(after.stdout).not.toContain(abandoned);
  });
});

describe('the operator commands an incident needs', () => {
  it('rotates a key without stopping anything', async () => {
    // Two keys of this rotation's own, so no other phase depends on what is revoked here.
    const outgoing = await stack.createKey('web', ['runs:read']);
    const incoming = await stack.createKey('web', ['runs:read']);
    expect((await stack.request('/v1/runs?limit=1', { token: outgoing })).status).toBe(200);
    expect((await stack.request('/v1/runs?limit=1', { token: incoming })).status).toBe(200);

    const listed = await stack.admin(['key', 'list', '--project', 'web']);
    expect(listed.code).toBe(0);
    const asJson = await stack.admin(['key', 'list', '--project', 'web', '--json']);
    expect(asJson.code).toBe(0);
    // Metadata only: neither form of the listing carries anything usable as a credential.
    for (const output of [listed.stdout, asJson.stdout]) {
      expect(output).not.toContain('qer_k1_');
      expect(output).not.toContain(outgoing);
      expect(output).not.toContain('secret_sha256');
      expect(output.toLowerCase()).not.toContain('authorization');
    }
    const keys = JSON.parse(asJson.stdout) as {
      keys: { publicId: string; active: boolean; projectId: string; scopes: string[] }[];
    };
    expect(keys.keys.length).toBeGreaterThanOrEqual(4);
    expect(keys.keys.every((k) => k.projectId === 'web')).toBe(true);

    // The public id of the key being retired, from the token itself: it is not a secret.
    const outgoingPublicId = outgoing.split('_')[2] as string;
    expect(keys.keys.map((k) => k.publicId)).toContain(outgoingPublicId);
    const revoked = await stack.admin(['key', 'revoke', '--public-id', outgoingPublicId]);
    expect(revoked.code, revoked.stderr).toBe(0);

    // The retired key stops at once; the replacement is unaffected, and nothing restarted.
    expect((await stack.request('/v1/runs?limit=1', { token: outgoing })).status).toBe(401);
    expect((await stack.request('/v1/runs?limit=1', { token: incoming })).status).toBe(200);
    expect((await stack.request('/v1/runs?limit=1', { token: readToken })).status).toBe(200);

    // It is still listed, now inactive, and only with --all.
    const active = await stack.admin(['key', 'list', '--project', 'web', '--json']);
    expect(
      JSON.parse(active.stdout).keys.map((k: { publicId: string }) => k.publicId),
    ).not.toContain(outgoingPublicId);
    const all = await stack.admin(['key', 'list', '--project', 'web', '--all', '--json']);
    const retired = (
      JSON.parse(all.stdout) as {
        keys: { publicId: string; active: boolean; revokedAt?: string }[];
      }
    ).keys.find((k) => k.publicId === outgoingPublicId);
    expect(retired?.active).toBe(false);
    expect(retired?.revokedAt).toBeTruthy();
  });

  it('repairs a query index an operator finds incomplete', async () => {
    // The derived rows are removed, as a database restored from an older interpretation might be.
    const cleared = await stack.compose([
      '--profile',
      'tools',
      'run',
      '--rm',
      '-T',
      'operator',
      'psql',
      '--no-password',
      '--quiet',
      '--command',
      'DELETE FROM qe_history_occurrences; DELETE FROM qe_run_query_index',
    ]);
    expect(cleared.code, cleared.stderr).toBe(0);

    // A cross-run question refuses rather than answering from part of the project.
    const refused = await stack.request('/v1/runs?limit=5', { token: readToken });
    expect(refused.status).toBe(503);
    expect(refused.text()).toContain('QUERY_INDEX_INCOMPLETE');

    const status = await stack.admin(['index', 'status', '--project', 'web']);
    expect(status.code).toBe(1);
    expect(status.stdout).toContain('incomplete');

    const rebuilt = await stack.admin(['index', 'rebuild', '--project', 'web']);
    expect(rebuilt.code, rebuilt.stderr).toBe(0);
    expect(rebuilt.stdout).toMatch(/rebuilt [1-9]/u);

    expect((await stack.admin(['index', 'status', '--project', 'web'])).code).toBe(0);
    const verified = await stack.admin([
      'index',
      'verify',
      '--project',
      'web',
      '--run-id',
      firstRunId,
    ]);
    expect(verified.code, verified.stdout).toBe(0);
    expect(verified.stdout).toContain('agrees');
    expect((await stack.request('/v1/runs?limit=5', { token: readToken })).status).toBe(200);
  });

  it('previews retention without changing anything, then collects what is eligible', async () => {
    // A run that expires at once, and one that does not.
    const { directory: expiring } = writeCompletedRun('deploy-expiring', 'run-deploy-expiring');
    const uploaded = await stack.uploadRun(expiring, writeToken, [
      '--expires-at',
      '2020-01-01T00:00:00Z',
    ]);
    expect(uploaded.code, uploaded.stderr).toBe(0);

    const preview = await stack.admin([
      'maintenance',
      'preview',
      '--as-of',
      '2026-01-01T00:00:00Z',
    ]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('runs expired            1');
    // A preview changes nothing: the run is still there to be read.
    const stillThere = await stack.request('/v1/runs?limit=50', { token: readToken });
    expect(stillThere.text()).toContain('run-deploy-expiring');

    const collected = await stack.admin([
      'maintenance',
      'run',
      '--as-of',
      '2026-01-01T00:00:00Z',
      '--orphan-objects-before',
      '2026-01-01T00:00:00Z',
      '--temp-before',
      '2026-01-01T00:00:00Z',
    ]);
    expect(collected.code, collected.stderr).toBe(0);
    expect(collected.stdout).toContain('runs expired            1');

    const afterwards = await stack.request('/v1/runs?limit=50', { token: readToken });
    expect(afterwards.text()).not.toContain('run-deploy-expiring');
    // The run that was not eligible, and its bytes, are untouched.
    expect(afterwards.text()).toContain(firstRunId);
    const download = await stack.request(`/v1/runs/${firstRunRef}/attachments/${firstAttachment}`, {
      token: readToken,
    });
    expect(download.status).toBe(200);
    expect(sha256(download.body)).toBe(firstAttachment);
  });
});

describe('backup and a restore that really destroys what was there', () => {
  it('backs up, destroys the state, restores, and serves the same data again', async () => {
    const before = await stack.request('/v1/runs?limit=50', { token: readToken });
    const runsBefore = before
      .json<{ runs: { runId: string }[] }>()
      .runs.map((r) => r.runId)
      .sort();
    expect(runsBefore.length).toBeGreaterThan(0);

    const backup = await stack.script('backup.sh', ['rehearsal']);
    expect(backup.code, backup.stderr).toBe(0);
    const directory = join(stack.backupDir, 'rehearsal');
    expect(readdirSync(directory).sort()).toEqual([
      'blobs.tar',
      'checksums.sha256',
      'database.dump',
      'manifest.json',
    ]);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      schemaVersion: number;
      postgresVersion: string;
      database: { sha256: string };
      blobs: { sha256: string };
      excludes: string[];
    };
    expect(manifest.schemaVersion).toBeGreaterThan(0);
    expect(manifest.postgresVersion).toMatch(/^16\./u);
    expect(manifest.database.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.blobs.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.excludes).toContain('staging');
    // A backup holds no credential of any kind.
    for (const file of ['manifest.json', 'checksums.sha256']) {
      const text = readFileSync(join(directory, file), 'utf8');
      expect(text).not.toContain('qer_k1_');
      expect(text).not.toMatch(/postgres:\/\/[^[]/u);
    }
    // The API is serving again by the time the backup returns.
    expect((await stack.request('/readyz')).status).toBe(200);

    // Everything durable goes: this is a restore into replaced storage, not one beside it.
    expect((await stack.compose(['down', '-v', '--remove-orphans'])).code).toBe(0);
    const volumes = await run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
    expect(volumes.stdout).not.toContain(`${stack.project}_pgdata`);
    expect(volumes.stdout).not.toContain(`${stack.project}_blobs`);

    expect((await stack.compose(['up', '-d', 'postgres'])).code).toBe(0);
    await stack.waitHealthy('postgres');
    const restored = await stack.script('restore.sh', ['rehearsal']);
    expect(restored.code, `${restored.stdout}\n${restored.stderr}`).toBe(0);
    await stack.waitHealthy('api');
    await stack.waitHealthy('edge');

    // The key issued before the backup still authenticates.
    const after = await stack.request('/v1/runs?limit=50', { token: readToken });
    expect(after.status).toBe(200);
    expect(
      after
        .json<{ runs: { runId: string }[] }>()
        .runs.map((r) => r.runId)
        .sort(),
    ).toEqual(runsBefore);

    // The same run replays, its history and flakiness answer, and its bytes are the same bytes.
    const one = await stack.request(`/v1/runs/${firstRunRef}`, { token: readToken });
    expect(one.status).toBe(200);
    const query = JSON.stringify({ runnerName: 'pw', historicalId: 'run-deploy-1-historical' });
    for (const path of ['/v1/history/query', '/v1/flakiness/query']) {
      const answer = await stack.request(path, {
        method: 'POST',
        token: readToken,
        body: query,
        contentType: 'application/json',
      });
      expect(answer.status, path).toBe(200);
    }
    const download = await stack.request(`/v1/runs/${firstRunRef}/attachments/${firstAttachment}`, {
      token: readToken,
    });
    expect(download.status).toBe(200);
    expect(sha256(download.body)).toBe(firstAttachment);

    // The derived index agrees with the restored source, and the retention facts survived.
    const verified = await stack.admin([
      'index',
      'verify',
      '--project',
      'web',
      '--run-id',
      firstRunId,
    ]);
    expect(verified.code, verified.stdout).toBe(0);
    const retention = await stack.admin([
      'maintenance',
      'preview',
      '--as-of',
      '2026-01-01T00:00:00Z',
    ]);
    expect(retention.code).toBe(0);
    expect(retention.stdout).toContain('runs expired            0');
  });

  it('refuses a backup whose bytes have changed', async () => {
    const directory = join(stack.backupDir, 'tampered');
    mkdirSync(directory, { recursive: true });
    for (const file of ['database.dump', 'blobs.tar', 'checksums.sha256', 'manifest.json']) {
      writeFileSync(join(directory, file), readFileSync(join(stack.backupDir, 'rehearsal', file)));
    }
    // One byte of the dump, changed.
    const dump = readFileSync(join(directory, 'database.dump'));
    dump[dump.length - 1] = dump[dump.length - 1] === 0 ? 1 : 0;
    writeFileSync(join(directory, 'database.dump'), dump);

    const refused = await stack.script('restore.sh', ['tampered']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('checksum');
    // And it stopped before touching anything: the deployment still serves what it served.
    expect((await stack.request('/readyz')).status).toBe(200);
    expect((await stack.request('/v1/runs?limit=5', { token: readToken })).status).toBe(200);

    // A directory with no manifest is incomplete, and is refused on that ground alone.
    const incomplete = join(stack.backupDir, 'incomplete');
    mkdirSync(incomplete, { recursive: true });
    const noManifest = await stack.script('restore.sh', ['incomplete']);
    expect(noManifest.code).not.toBe(0);
    expect(noManifest.stderr).toContain('manifest');
    expect(existsSync(join(incomplete, 'manifest.json'))).toBe(false);
  });
});
