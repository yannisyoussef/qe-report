#!/usr/bin/env node
/**
 * Runs the packed Playwright reporter under a real Playwright, from a clean install.
 *
 * The reporter's own tests run against the workspace. This runs the tarball a consumer would
 * install, under a Playwright version chosen on the command line, so the published peer range is
 * backed by the artifact rather than by the source it was built from.
 *
 *   node release/consume-playwright.mjs 1.57.0
 *
 * The specs deliberately never open a page. What is being tested is the reporter, and needing a
 * browser download would make this slow and flaky for no added evidence.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, npm, runtimes } = contract;
const NPM_OUT = join(ROOT, 'build', 'release', productVersion, 'npm');
const playwrightVersion = process.argv[2];

if (playwrightVersion === undefined) {
  process.stderr.write(
    `usage: node release/consume-playwright.mjs <playwright version>\n` +
      `the published peer range is ${runtimes.playwrightPeer}\n`,
  );
  process.exit(2);
}

function run(file, args, options = {}) {
  const finished = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  const output = `${finished.stdout ?? ''}${finished.stderr ?? ''}`;
  if (finished.status !== 0)
    throw new Error(`${file} exited ${finished.status}:\n${output.slice(-1500)}`);
  return output;
}

const tarballs = [
  'qe-report-playwright',
  'qe-report-http-client',
  'qe-report-sdk',
  'qe-report-protocol',
  'qe-report-validator',
]
  .filter((name) => npm.public.includes(name))
  .map((name) => {
    const path = join(NPM_OUT, `${name}-${productVersion}.tgz`);
    if (!existsSync(path)) throw new Error(`${path} is missing; run release/audit-npm.mjs first`);
    return path;
  });

const consumer = mkdtempSync(join(tmpdir(), 'qe-consumer-playwright-'));
const problems = [];
try {
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'qe-report-playwright-consumer', private: true, version: '0.0.0' }, null, 2)}\n`,
  );
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(consumer, '.npm-cache'),
      `@playwright/test@${playwrightVersion}`,
      ...tarballs,
    ],
    { cwd: consumer },
  );

  const installed = JSON.parse(
    readFileSync(join(consumer, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8'),
  ).version;
  if (installed !== playwrightVersion) {
    problems.push(`asked for Playwright ${playwrightVersion} and got ${installed}`);
  }

  const runRoot = join(consumer, 'qe-report');
  writeFileSync(
    join(consumer, 'playwright.config.js'),
    `module.exports = {
  testDir: './tests',
  reporter: [['qe-report-playwright', { dir: ${JSON.stringify(runRoot)}, runId: 'run-packed-consumer' }]],
};
`,
  );
  mkdirSync(join(consumer, 'tests'), { recursive: true });
  writeFileSync(
    join(consumer, 'tests', 'a.spec.js'),
    `const { test, expect } = require('@playwright/test');
test('passes', async () => { expect(1).toBe(1); });
test('fails on purpose', async () => { expect(1).toBe(2); });
test.skip('is skipped', async () => {});
`,
  );

  // Playwright exits non-zero because one test fails on purpose, which is the point: the reporter
  // has to record a failure as a failure.
  const finished = spawnSync('npx', ['playwright', 'test'], {
    cwd: consumer,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${finished.stdout ?? ''}${finished.stderr ?? ''}`;
  if (!existsSync(runRoot)) {
    throw new Error(`the reporter wrote nothing to ${runRoot}:\n${output.slice(-1500)}`);
  }

  const runs = join(runRoot, 'runs');
  const produced = readdirSync(runs);
  if (produced.length !== 1) problems.push(`the reporter wrote ${produced.length} run directories`);
  const runDirectory = join(runs, produced[0] ?? '');

  // The packed validator on the packed reporter's output: two published artifacts, checking each
  // other, with nothing from this workspace involved.
  const validated = run(
    join(consumer, 'node_modules', '.bin', 'qe-report-validate'),
    [runDirectory, '--require-complete'],
    { cwd: consumer },
  );
  if (!/\bvalid\b/u.test(validated) || /invalid/u.test(validated)) {
    problems.push(`the validator did not accept the reporter's run: ${validated.trim()}`);
  }
  // The reporter identifies itself as the release, not as whatever it was during development.
  const events = readdirSync(join(runDirectory, 'events'))
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => readFileSync(join(runDirectory, 'events', f), 'utf8'))
    .join('');
  if (!events.includes(`"version":"${productVersion}"`)) {
    problems.push(`no producer version ${productVersion} appears in the events it wrote`);
  }
  if (!events.includes('"status":"failed"')) {
    problems.push('the run records no failed attempt, though one test fails on purpose');
  }

  process.stdout.write(
    `packed reporter under Playwright ${installed}: ${validated.trim().split('\n').pop()}\n`,
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

if (problems.length > 0) {
  process.stderr.write(
    `\nthe packed reporter does not work under Playwright ${playwrightVersion}:\n`,
  );
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}
