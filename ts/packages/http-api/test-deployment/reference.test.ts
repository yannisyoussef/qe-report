import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { ReferenceStack, eventually, multipartBody, sleep, type UploadPart } from './stack.js';

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

/** What the API's staging root holds right now, by name, read from inside the container. */
async function stagingNames(): Promise<string[]> {
  const listed = await stack.compose([
    'exec',
    '-T',
    'api',
    'sh',
    '-c',
    'ls -1 /var/lib/qe-report/staging 2>/dev/null || true',
  ]);
  return listed.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/**
 * The request directory the server has staged for an upload that is still open. The upload has to
 * be one that will not finish on its own: `docker compose exec` takes about a second, and an
 * upload that completes by itself is gone before the first look.
 */
async function stagedRequest(): Promise<string> {
  let name = '';
  await eventually(
    'the server staged the request',
    async () => {
      name = (await stagedRequests())[0] ?? '';
      return name !== '';
    },
    60,
  );
  return name;
}

/** The staging entries that are request directories, ignoring anything else in the root. */
async function stagedRequests(): Promise<string[]> {
  return (await stagingNames()).filter((n) => /^[0-9a-f-]{36}$/u.test(n));
}

/** Whether the API's staging root holds a directory of this name. */
async function stackHolds(name: string): Promise<boolean> {
  return (await stagingNames()).includes(name);
}

/** A run directory as the parts of an upload: its expiry, its event streams, its attachments. */
function partsFor(directory: string, retentionMs = 86_400_000): UploadPart[] {
  const parts: UploadPart[] = [
    { name: 'expiresAt', text: new Date(Date.now() + retentionMs).toISOString() },
  ];
  for (const name of readdirSync(join(directory, 'events')).sort()) {
    if (!name.endsWith('.ndjson')) continue;
    parts.push({
      name: 'events',
      bytes: readFileSync(join(directory, 'events', name)),
      filename: name,
    });
  }
  let attachments: string[] = [];
  try {
    attachments = readdirSync(join(directory, 'attachments')).sort();
  } catch {
    attachments = [];
  }
  for (const name of attachments) {
    parts.push({
      name: 'attachment',
      bytes: readFileSync(join(directory, 'attachments', name)),
      filename: name,
    });
  }
  return parts;
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

  it('passes its own smoke script, which is what an operator runs after a restore', async () => {
    // The committed script, against the running deployment, doing everything through the public
    // interfaces: health, readiness, a key it issues and revokes, a real upload by the producer
    // command, every read, and an attachment verified byte for byte. The README tells an operator
    // to run this after a restore and after an upgrade, so it is run here too.
    const { directory } = writeCompletedRun('deploy-smoke', 'run-deploy-smoke');
    const smoked = await stack.script('smoke.sh', [directory]);
    expect(smoked.code, `${smoked.stdout}\n${smoked.stderr}`).toBe(0);
    expect(smoked.stderr).toContain('verifying the edge against the authority');
    expect(smoked.stderr).toContain('issuing a short-lived key');
    // Every numbered step ran; none was skipped for want of something to prove.
    for (const step of ['1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.']) {
      expect(smoked.stderr, step).toContain(`\n${step} `);
    }
    expect(smoked.stderr).toContain('verified byte for byte');
    expect(smoked.stderr).toContain('serves run-deploy-smoke over HTTPS');
    // The token it used is nowhere in its output.
    expect(smoked.stdout).not.toContain('qer_k1_');
    expect(smoked.stderr).not.toContain('qer_k1_');

    // And it left no credential behind: the key it issued is revoked on the way out.
    const listed = await stack.admin(['key', 'list', '--project', 'smoke', '--all', '--json']);
    expect(listed.code, listed.stderr).toBe(0);
    const keys = JSON.parse(listed.stdout) as { keys: { active: boolean }[] };
    expect(keys.keys.length).toBeGreaterThan(0);
    expect(keys.keys.every((k) => !k.active)).toBe(true);
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

      // And it tells the client how long to wait, rather than leaving it to guess: the producer
      // treats 429 as retryable and honours this header.
      const refused = await stack.request('/v1/runs?limit=1', { token: readToken });
      expect(refused.status).toBe(429);
      expect(refused.headers['retry-after']).toBe('2');

      // Health and readiness have their own budget, so a probe is not refused because a client
      // spent the API's, and a probe cannot spend a client's either.
      expect((await stack.request('/healthz')).status).toBe(200);
      expect((await stack.request('/readyz')).status).toBe(200);
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

  it('refuses a second simultaneous connection from one address when it is allowed one', async () => {
    // One connection per address, applied to this test only. The limit is the edge's, so what is
    // proven is that the edge refuses it: an application that never sees the request cannot.
    const single = { QE_REPORT_EDGE_CONNECTIONS: '1' };
    expect((await stack.compose(['up', '-d', '--force-recreate', 'edge'], single)).code).toBe(0);
    await stack.waitHealthy('edge');
    try {
      // A request that is deliberately unfinished, so its connection is genuinely held open while
      // the second one is made. Its body is announced and never completely sent.
      const { directory } = writeCompletedRun('deploy-conn', 'run-deploy-conn');
      const { boundary, body } = multipartBody(partsFor(directory));
      const held = stack.beginUpload(writeToken, body, boundary);
      held.answered.catch(() => undefined);
      await held.onTheWire;

      // Polled rather than asserted on the first try: the bytes have left this process, and the
      // edge counting the connection is a moment later. What is being tested is that a second
      // connection is refused while the first is open, not how quickly nginx notices.
      let second = await stack.request('/v1/runs?limit=1', { token: readToken });
      for (let i = 0; i < 20 && second.status !== 429; i += 1) {
        await sleep(500);
        second = await stack.request('/v1/runs?limit=1', { token: readToken });
      }
      expect(second.status, second.text()).toBe(429);
      // NGINX answered it; the application was never asked.
      expect(second.text()).not.toContain('urn:qe-report:problem');

      held.abandon();
      // With the connection let go, the next request is served again: the limit counts
      // connections that are open, not requests that were once made.
      await eventually(
        'the held connection was released',
        async () => (await stack.request('/v1/runs?limit=1', { token: readToken })).status === 200,
        30,
      );

      // What an abandoned upload leaves behind is worth knowing here rather than discovering it
      // as someone else's failure: a request that merely died is the running server's to tidy up,
      // and only a server that was killed leaves a staged request behind.
      await eventually(
        'the abandoned upload left no staged request behind',
        async () => (await stagedRequests()).length === 0,
        30,
      );
    } finally {
      expect((await stack.compose(['up', '-d', '--force-recreate', 'edge'])).code).toBe(0);
      await stack.waitHealthy('edge');
    }
  });

  it('follows the application to a new container without being reloaded', async () => {
    // What an upgrade does: a new image means a new container, on a new address. An edge that
    // resolved the name once at start-up would answer 502 from here until someone reloaded it,
    // and the documented upgrade does not reload it.
    const before = await stack.compose(['ps', '--quiet', 'api']);
    expect((await stack.compose(['up', '-d', '--force-recreate', 'api'])).code).toBe(0);
    await stack.waitHealthy('api');
    const after = await stack.compose(['ps', '--quiet', 'api']);
    expect(after.stdout.trim()).not.toBe(before.stdout.trim());

    // The edge was not touched, and the deployment answers through it.
    const served = await stack.request('/v1/runs?limit=1', { token: readToken });
    expect(served.status).toBe(200);
    expect((await stack.request('/healthz')).status).toBe(200);
  });
});

describe('the lifecycle of the process', () => {
  // These phases stop and kill the API on purpose. If one of them fails partway, the next should
  // fail on its own merits rather than on a deployment the previous one left down.
  beforeEach(async () => {
    if ((await stack.health('api')) !== 'healthy') {
      await stack.compose(['up', '-d', 'api']);
      await stack.waitHealthy('api');
    }
  }, 300_000);

  it('finishes an upload that is already running, then stops, and comes back', async () => {
    const { directory } = writeCompletedRun('deploy-restart', 'run-deploy-restart');
    const { boundary, body } = multipartBody(partsFor(directory));
    // Almost all of the body, then nothing: the request is open and staged, and stays that way
    // until this test finishes it. The producer command is exercised elsewhere; what is needed
    // here is a request whose lifetime the test decides, so the drain has something to drain.
    const upload = stack.beginUpload(writeToken, body, boundary);
    await upload.onTheWire;
    const staged = await stagedRequest();

    // Not awaited: `docker compose stop` does not return until the container has exited, and the
    // container cannot exit until this request finishes, so awaiting it here would deadlock the
    // pair and spend the whole grace doing it.
    const stopping = stack.compose(['stop', 'api']);
    await eventually(
      'the api began draining',
      async () =>
        (await stack.compose(['logs', '--no-log-prefix', '--tail', '20', 'api'])).stdout.includes(
          'shutdown requested',
        ),
      60,
    );

    // The rest of the body, after the signal: this is the request the drain is waiting for.
    upload.finish();
    const answer = await upload.answered;
    expect(answer.status, answer.text()).toBe(201);
    expect(answer.json<{ outcome: string; runId: string }>()).toMatchObject({
      outcome: 'inserted',
      runId: 'run-deploy-restart',
    });

    const logs = await stack.compose(['logs', '--no-log-prefix', 'api']);
    expect(logs.stdout).toContain('shutdown requested');
    // It drained rather than being given up on: the grace was not what ended it.
    expect(logs.stdout).toContain('shutdown completed');
    expect(logs.stdout).not.toContain('shutdown grace exceeded');
    // Nothing that could be replayed is in those lines, and no path either: the request id is
    // logged on purpose, as the correlation id a caller can quote, but the staging root it names a
    // directory under is redacted wherever it appears.
    expect(logs.stdout).not.toContain('qer_k1_');
    expect(logs.stdout).not.toContain('/var/lib/qe-report/staging');
    expect(staged).toMatch(/^[0-9a-f-]{36}$/u);

    // It stopped of its own accord, cleanly, once that request was done.
    expect((await stopping).code).toBe(0);
    expect((await stack.compose(['up', '-d', 'api'])).code).toBe(0);
    await stack.waitHealthy('api');

    // The run it finished during the drain is archived, exactly once, and the request directory
    // it was using went with the request.
    const listed = await stack.request('/v1/runs?limit=50', { token: readToken });
    expect(listed.status).toBe(200);
    expect(
      listed
        .json<{ runs: { runId: string }[] }>()
        .runs.filter((r) => r.runId === 'run-deploy-restart'),
    ).toHaveLength(1);
    expect(await stackHolds(staged)).toBe(false);

    // And the producer may repeat it: the same run is one archive.
    const again = await stack.uploadRun(directory, writeToken);
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ outcome: 'already_present' });
  });

  it('leaves a staged request behind when it is killed during an upload, and cleans it up offline', async () => {
    const { directory } = writeCompletedRun('deploy-killed', 'run-deploy-killed');
    const { boundary, body } = multipartBody(partsFor(directory));
    const upload = stack.beginUpload(writeToken, body, boundary);
    await upload.onTheWire;
    // A real request, staged by the server, killed before it could finish. Nothing is planted
    // here: what is being tested is what a killed server leaves, not what a test can create.
    const abandoned = await stagedRequest();
    upload.answered.catch(() => undefined);

    expect((await stack.compose(['kill', '--signal', 'SIGKILL', 'api'])).code).toBe(0);
    upload.abandon();

    expect((await stack.compose(['up', '-d', 'api'])).code).toBe(0);
    await stack.waitHealthy('api');

    // The archive committed nothing: a run becomes archived in one transaction, so a killed
    // ingestion leaves no half-run and no attachment row pointing at nothing.
    const listed = await stack.request('/v1/runs?limit=50', { token: readToken });
    expect(listed.status).toBe(200);
    expect(
      listed
        .json<{ runs: { runId: string }[] }>()
        .runs.filter((r) => r.runId === 'run-deploy-killed'),
    ).toHaveLength(0);

    // The request's directory is what did survive, which is the one known cost of being killed,
    // and start-up did not quietly delete it: nothing can tell an abandoned request from a live
    // one, and start-up is exactly when no operator is watching.
    expect(await stackHolds(abandoned)).toBe(true);
    const preview = await stack.admin(['staging', 'preview', '--older-than-ms', '1']);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain(abandoned);

    // Cleanup is offline, and says so while the instance that owns the root is still running.
    const refused = await stack.admin(['staging', 'clean', '--older-than-ms', '1']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--execute');

    expect((await stack.compose(['stop', 'api'])).code).toBe(0);
    try {
      const cleaned = await stack.admin([
        'staging',
        'clean',
        '--older-than-ms',
        '1',
        '--execute',
        '--json',
      ]);
      expect(cleaned.code, cleaned.stderr).toBe(0);
      // By name, from the report itself: a count would depend on what every earlier phase
      // happened to leave, and this phase is about this request directory.
      const report = JSON.parse(cleaned.stdout) as {
        dryRun: boolean;
        removed: number;
        entries: { requestId: string }[];
      };
      expect(report.dryRun).toBe(false);
      expect(report.entries.map((e) => e.requestId)).toContain(abandoned);
      expect(report.removed).toBe(report.entries.length);
    } finally {
      // Whatever the assertions above decide, the deployment is handed back running: an API left
      // stopped here would fail every phase after it for a reason that is not theirs.
      expect((await stack.compose(['up', '-d', 'api'])).code).toBe(0);
      await stack.waitHealthy('api');
    }
    expect(await stackHolds(abandoned)).toBe(false);

    // And the run the killed upload was carrying can simply be uploaded again.
    const again = await stack.uploadRun(directory, writeToken);
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ outcome: 'inserted' });
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
    const restored = await stack.script('restore.sh', ['rehearsal', '--yes']);
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

    const refused = await stack.script('restore.sh', ['tampered', '--yes']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('checksum');
    // And it stopped before touching anything: the deployment still serves what it served.
    expect((await stack.request('/readyz')).status).toBe(200);
    expect((await stack.request('/v1/runs?limit=5', { token: readToken })).status).toBe(200);

    // A directory with no manifest is incomplete, and is refused on that ground alone.
    const incomplete = join(stack.backupDir, 'incomplete');
    mkdirSync(incomplete, { recursive: true });
    const noManifest = await stack.script('restore.sh', ['incomplete', '--yes']);
    expect(noManifest.code).not.toBe(0);
    expect(noManifest.stderr).toContain('manifest');
    expect(existsSync(join(incomplete, 'manifest.json'))).toBe(false);

    // And a restore is destructive enough that it will not run on a positional argument alone.
    const unconfirmed = await stack.script('restore.sh', ['rehearsal']);
    expect(unconfirmed.code).not.toBe(0);
    expect(unconfirmed.stderr).toContain('--yes');
  });

  it('refuses a manifest whose digests disagree with the files, even when the file list does not', async () => {
    // The manifest and checksums.sha256 are written by separate steps and both are inside the
    // integrity envelope, so this is a backup rewritten by someone who recomputed one and not the
    // other. It must not be a backup this deployment will restore.
    const directory = join(stack.backupDir, 'mismatched');
    mkdirSync(directory, { recursive: true });
    for (const file of ['database.dump', 'blobs.tar', 'checksums.sha256', 'manifest.json']) {
      writeFileSync(join(directory, file), readFileSync(join(stack.backupDir, 'rehearsal', file)));
    }
    const manifest = readFileSync(join(directory, 'manifest.json'), 'utf8');
    const digest = /"database": \{[^}]*"sha256": "([0-9a-f]{64})"/u.exec(manifest)?.[1] as string;
    const swapped = manifest.replace(digest, `${'0'.repeat(63)}1`);
    writeFileSync(join(directory, 'manifest.json'), swapped);
    // Rewritten consistently, so the checksum file itself still verifies.
    const checksums = readFileSync(join(directory, 'checksums.sha256'), 'utf8')
      .split('\n')
      .filter((line) => !line.endsWith('manifest.json'))
      .join('\n');
    const { createHash } = await import('node:crypto');
    const manifestDigest = createHash('sha256').update(swapped).digest('hex');
    writeFileSync(
      join(directory, 'checksums.sha256'),
      `${checksums.trimEnd()}\n${manifestDigest}  manifest.json\n`,
    );

    const refused = await stack.script('restore.sh', ['mismatched', '--yes']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("manifest's digest");
    expect((await stack.request('/readyz')).status).toBe(200);
  });

  it('fails a backup loudly, writes no manifest, and hands the deployment back', async () => {
    // A name that already exists. The check is there so that a backup never writes into a
    // directory whose other half belongs to a different moment.
    const existing = await stack.script('backup.sh', ['rehearsal']);
    expect(existing.code).not.toBe(0);
    expect(existing.stderr).toContain('already exists');

    // And a name that is not a path component, because the name becomes a directory that is
    // bind-mounted into a container running as root.
    for (const name of ['../escape', '.hidden', 'has space']) {
      const refused = await stack.script('backup.sh', [name]);
      expect(refused.code, name).not.toBe(0);
      expect(refused.stderr).toContain('a backup name may hold');
    }

    // A backup that cannot take the maintenance lock: retention could otherwise delete bytes the
    // dump still references, between the dump and the copy. Held here by another session, which is
    // what an operator running `maintenance run` would be.
    const holder = await stack.compose([
      '--profile',
      'tools',
      'run',
      '--detach',
      '--name',
      `${stack.project}-other-holder`,
      '-T',
      '--entrypoint',
      'psql',
      'operator',
      '--no-password',
      '--no-psqlrc',
      '--quiet',
      '-c',
      'SET statement_timeout = 0',
      '-c',
      'SELECT pg_advisory_lock(7248134620002)',
      '-c',
      'SELECT pg_sleep(180)',
    ]);
    expect(holder.code, holder.stderr).toBe(0);
    try {
      await eventually(
        'another session took the maintenance lock',
        async () => {
          const held = await stack.compose([
            '--profile',
            'tools',
            'run',
            '--rm',
            '-T',
            '--entrypoint',
            'psql',
            'operator',
            '--no-password',
            '--no-psqlrc',
            '--quiet',
            '--tuples-only',
            '--no-align',
            '-c',
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted",
          ]);
          return held.stdout.trim() === '1';
        },
        30,
      );

      const blocked = await stack.script('backup.sh', ['contended']);
      expect(blocked.code).not.toBe(0);
      expect(blocked.stderr).toContain('could not take the maintenance lock');
      // No manifest, so nothing will ever restore it.
      expect(existsSync(join(stack.backupDir, 'contended', 'manifest.json'))).toBe(false);
    } finally {
      // The container goes, and so does its database session: PostgreSQL does not notice a dead
      // client while it is sleeping, so a lock released only by removing the container would go on
      // being held for the rest of its ceiling.
      await run('docker', ['rm', '--force', `${stack.project}-other-holder`]).catch(
        () => undefined,
      );
      await stack.compose([
        '--profile',
        'tools',
        'run',
        '--rm',
        '-T',
        '--entrypoint',
        'psql',
        'operator',
        '--no-password',
        '--no-psqlrc',
        '--quiet',
        '-c',
        "SELECT count(pg_terminate_backend(pid)) FROM pg_locks WHERE locktype = 'advisory'",
      ]);
    }

    // A failed backup stops the API and must not leave it stopped: that would turn a backup
    // failure at three in the morning into an outage.
    await eventually(
      'the deployment is serving again after the failed backup',
      async () => (await stack.request('/readyz')).status === 200,
      60,
    );
    expect((await stack.request('/v1/runs?limit=5', { token: readToken })).status).toBe(200);
  });
});
