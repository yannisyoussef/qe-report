#!/usr/bin/env node
/**
 * Builds the release image and checks what it claims to be, without pushing it anywhere.
 *
 * What a registry would receive has to say which release it is and where it came from, and it has
 * to keep the properties the reference deployment relies on. So this reads the image's own labels
 * and configuration, and runs the two operator commands inside it to see what they report. Nothing
 * is tagged for a registry and nothing is pushed: the release workflow does that, from a tag.
 *
 * The deployment itself is rehearsed elsewhere, against PostgreSQL, an attachment volume and a TLS
 * edge. This is about release identity, not about whether the service works.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, container, repository } = contract;

/** The tag this rehearsal builds. Deliberately not a registry name: nothing here may be pushed. */
export const REHEARSAL_TAG = `qe-report-release-rehearsal:${productVersion}`;

function run(file, args, options = {}) {
  const finished = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  const output = `${finished.stdout ?? ''}${finished.stderr ?? ''}`;
  if (finished.status !== 0)
    throw new Error(`${file} exited ${finished.status}: ${output.slice(-800)}`);
  return output;
}

export function verifyContainer({ commit } = {}) {
  const problems = [];
  const revision = commit ?? run('git', ['-C', ROOT, 'rev-parse', 'HEAD']).trim();

  run('docker', [
    'build',
    '--tag',
    REHEARSAL_TAG,
    '--file',
    join(ROOT, 'deploy', 'reference', 'Dockerfile'),
    '--build-arg',
    `PRODUCT_VERSION=${productVersion}`,
    '--build-arg',
    `SOURCE_REVISION=${revision}`,
    ROOT,
  ]);

  const inspected = JSON.parse(run('docker', ['image', 'inspect', REHEARSAL_TAG]))[0];
  const labels = inspected.Config?.Labels ?? {};
  const expectedLabels = {
    'org.opencontainers.image.version': productVersion,
    'org.opencontainers.image.revision': revision,
    'org.opencontainers.image.source': repository.url,
    'org.opencontainers.image.licenses': repository.license,
  };
  for (const [label, wanted] of Object.entries(expectedLabels)) {
    if (labels[label] !== wanted) {
      problems.push(`${label} is ${JSON.stringify(labels[label])}, not ${JSON.stringify(wanted)}`);
    }
  }
  // The hardening the reference deployment depends on, still there in the release image.
  if (inspected.Config?.User !== '10001:10001') {
    problems.push(`the image runs as ${JSON.stringify(inspected.Config?.User)}, not 10001:10001`);
  }
  const architecture = `${inspected.Os}/${inspected.Architecture}`;
  // One architecture is claimed, and only where it was built; a rehearsal on another machine
  // reports what it actually produced rather than asserting the release platform.
  const claimed = container.platforms.includes(architecture);

  // Nothing secret or machine-specific in what the image carries.
  const configured = JSON.stringify({
    labels,
    env: inspected.Config?.Env ?? [],
  });
  for (const leak of [
    /\/Users\/[a-z]/iu,
    /\/home\/runner\//u,
    /qer_k1_[A-Za-z0-9]/u,
    /postgres:\/\/[^[\s]/u,
    /npm_[A-Za-z0-9]{20}/u,
  ]) {
    const found = leak.exec(configured);
    if (found !== null) problems.push(`the image configuration contains ${found[0]}`);
  }

  // What the running container says it is. Neither command needs a database to answer this.
  const reported = {};
  for (const command of ['qe-report-server', 'qe-report-admin']) {
    const said = run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      command,
      REHEARSAL_TAG,
      '--version',
    ]).trim();
    reported[command] = said;
    if (said !== productVersion) {
      problems.push(`${command} --version reported ${JSON.stringify(said)}`);
    }
  }

  return {
    problems,
    tag: REHEARSAL_TAG,
    architecture,
    architectureIsReleasePlatform: claimed,
    releasePlatforms: container.platforms,
    imageId: inspected.Id,
    reported,
    // What the release would be called. Recorded, never created here.
    releaseTags: container.tags.map((t) => `${container.repository}:${t}`),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = verifyContainer();
  process.stdout.write(
    `release image built for ${result.architecture}: ${Object.entries(result.reported)
      .map(([c, v]) => `${c} ${v}`)
      .join(', ')}\n`,
  );
  if (!result.architectureIsReleasePlatform) {
    process.stdout.write(
      `note: built on ${result.architecture}; the release platform is ${result.releasePlatforms.join(', ')}, ` +
        'which is what CI builds and what the release claims\n',
    );
  }
  process.stdout.write(`would publish as: ${result.releaseTags.join(', ')}\n`);
  if (result.problems.length > 0) {
    process.stderr.write('\nthe release image is not ready:\n');
    for (const problem of result.problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
}
