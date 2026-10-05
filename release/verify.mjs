#!/usr/bin/env node
/**
 * The release rehearsal: everything a release does, except contact a registry.
 *
 * `node release/verify.mjs` is the gate. It runs the steps in the order a release runs them, stops
 * at the first failure, and exits non-zero. If it passes, the only things left between here and a
 * published release are account state and a person's decision -- both of which live outside this
 * repository, and are listed in RELEASING.md.
 *
 * It cannot publish. There is no registry credential in any step, no publish command anywhere in
 * `release/`, and the last check in this file asserts that rather than assuming it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion } = contract;

const started = Date.now();
const results = [];

function step(name, work) {
  const at = Date.now();
  process.stdout.write(`\n=== ${name}\n`);
  try {
    const detail = work();
    results.push({ name, ok: true, ms: Date.now() - at, detail });
    return detail;
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - at, error: e.message });
    process.stderr.write(`\n${name} failed:\n${e.message}\n`);
    summarise();
    process.exit(1);
  }
}

/** Runs one of this repository's own commands, streaming its output so a failure is readable. */
function shell(file, args, options = {}) {
  const finished = spawnSync(file, args, { stdio: 'inherit', ...options });
  if (finished.status !== 0) throw new Error(`${file} ${args.join(' ')} exited ${finished.status}`);
}

function node(script, options = {}) {
  shell(process.execPath, [join(ROOT, 'release', script)], options);
}

/**
 * Nothing the rehearsal runs may publish. Checked by reading it, because "we did not call publish"
 * is a claim about code and is cheap to verify rather than trust.
 *
 * The boundary is a directory a person can see. Everything the rehearsal runs is `release/*.mjs`;
 * everything that can publish is `release/publish/*.mjs`, is reached only by the release workflow,
 * and is never called from here. Both halves are asserted: that no rehearsal script contains a
 * publish command, and that none of them reaches into the directory of the ones that do.
 */
function assertNothingPublishes() {
  const forbidden = [
    /\bnpm\s+publish\b/u,
    /\bpnpm\s+publish\b/u,
    /\bdocker\s+push\b/u,
    /\bbuildx\s+build[^\n]*--push\b/u,
    /central\.sonatype\.com\/api[^\n]*upload/u,
    /publishMavenPublicationTo(?!ReleaseStaging|BuildLocal)[A-Za-z]*Repository/u,
    /gh\s+release\s+create/u,
  ];
  const offenders = [];
  for (const entry of readdirSync(join(ROOT, 'release'))) {
    if (!entry.endsWith('.mjs')) continue;
    const text = readFileSync(join(ROOT, 'release', entry), 'utf8');
    // This file's own list of patterns is not a call to any of them.
    if (entry === 'verify.mjs') continue;
    for (const pattern of forbidden) {
      if (pattern.test(text)) offenders.push(`${entry} matches ${pattern}`);
    }
    if (/release\/publish\//u.test(text)) {
      offenders.push(`${entry} refers to release/publish, which only the release workflow may run`);
    }
  }
  // And the rehearsal's own steps run nothing from there.
  const steps = readFileSync(join(ROOT, 'release', 'verify.mjs'), 'utf8');
  const stepsBegin = steps.indexOf("step('the release contract");
  if (stepsBegin === -1) {
    offenders.push('the rehearsal steps could not be located, so the boundary was not checked');
  } else if (/publish\//u.test(steps.slice(stepsBegin))) {
    offenders.push('the rehearsal runs a script from release/publish');
  }
  if (offenders.length > 0) {
    throw new Error(`the rehearsal tooling can publish:\n  ${offenders.join('\n  ')}`);
  }
  // And no credential is needed or read. If one is present in the environment, the rehearsal still
  // must not use it, so the absence of publish commands above is the guarantee; this only reports.
  const present = ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'CENTRAL_TOKEN', 'GITHUB_TOKEN']
    .filter((name) => process.env[name] !== undefined && process.env[name] !== '')
    .join(', ');
  return present === ''
    ? 'no publishing credential in the environment'
    : `credentials present but unused: ${present}`;
}

function summarise() {
  process.stdout.write(`\n${'='.repeat(78)}\nrelease rehearsal for ${productVersion}\n`);
  for (const result of results) {
    const seconds = (result.ms / 1000).toFixed(1);
    process.stdout.write(
      `  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name.padEnd(46)} ${seconds.padStart(6)}s\n`,
    );
  }
  const total = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`${'='.repeat(78)}\n${total}s total\n`);
}

step('the release contract agrees with the code', () => node('verify-contract.mjs'));
step('the release decisions and their guards hold', () =>
  shell(process.execPath, ['--test', join(ROOT, 'release', 'test', '*.test.mjs')]),
);
step('both languages build', () => {
  shell('pnpm', ['run', 'build'], { cwd: join(ROOT, 'ts') });
  shell(join(ROOT, 'java', 'gradlew'), ['-p', join(ROOT, 'java'), '--quiet', 'assemble']);
});
step('the npm tarballs hold only what they should', () => node('audit-npm.mjs'));
step('a clean install of those tarballs works', () => node('consume-npm.mjs'));
step('the Central bundle is valid, signed where GPG exists', () => node('bundle-maven.mjs'));
step('clean Gradle and Maven consumers work on Java 17', () => node('consume-maven.mjs'));
step('the release image reports what it is', () => node('container.mjs'));
step('the manifest, SBOM and checksums generate', () => {
  shell(join(ROOT, 'java', 'gradlew'), [
    '-p',
    join(ROOT, 'java'),
    '--quiet',
    'releaseDependencies',
  ]);
  node('manifest.mjs');
});
const credentials = step('the rehearsal cannot publish', assertNothingPublishes);

summarise();
process.stdout.write(`${credentials}\n`);
process.stdout.write(
  `\nrelease software readiness: VERIFIED\n` +
    `registry and account readiness: see the preconditions in RELEASING.md\n` +
    `published: nothing\n`,
);
