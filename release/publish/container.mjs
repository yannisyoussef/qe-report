#!/usr/bin/env node
/**
 * Builds the release image once, pushes it, and points every release tag at that one digest.
 *
 * One build, one digest. The alias tags are references to it rather than separate builds, because
 * `1.0.0`, `1.0` and `1` naming different bytes would make the aliases meaningless. An exact version
 * tag that already exists with different bytes is a hard failure: it is never overwritten.
 *
 * BuildKit generates the SBOM and provenance attestations during the push, so the image's own
 * contents are described by the tool that assembled them rather than by something guessing afterwards.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, container } = contract;
const version = process.env.PRODUCT_VERSION ?? productVersion;
const revision = process.env.SOURCE_REVISION;

if (version !== productVersion) {
  process.stderr.write(`refusing to publish ${version} when the contract says ${productVersion}\n`);
  process.exit(1);
}
if (revision === undefined || revision === '') {
  process.stderr.write('no SOURCE_REVISION: the image must record the commit it came from\n');
  process.exit(1);
}

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

const exact = `${container.repository}:${version}`;

/** The digest a tag currently resolves to on the registry, or nothing if it is not there. */
function publishedDigest(reference) {
  const finished = spawnSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference], {
    encoding: 'utf8',
  });
  if (finished.status !== 0) return undefined;
  const shown = spawnSync('docker', ['buildx', 'imagetools', 'inspect', reference], {
    encoding: 'utf8',
  });
  return /Digest:\s+(sha256:[0-9a-f]{64})/u.exec(shown.stdout ?? '')?.[1];
}

const existing = publishedDigest(exact);

// One builder that can produce attestations, and one platform: the one this release claims.
run('docker', [
  'buildx',
  'create',
  '--name',
  'qe-report-release',
  '--use',
  '--driver',
  'docker-container',
]);
const platform = container.platforms.join(',');
const built = run('docker', [
  'buildx',
  'build',
  '--file',
  join(ROOT, 'deploy', 'reference', 'Dockerfile'),
  '--platform',
  platform,
  '--build-arg',
  `PRODUCT_VERSION=${version}`,
  '--build-arg',
  `SOURCE_REVISION=${revision}`,
  '--provenance=mode=max',
  '--sbom=true',
  '--tag',
  exact,
  '--metadata-file',
  '/tmp/qe-report-image.json',
  '--push',
  ROOT,
]);
void built;

const metadata = JSON.parse(readFileSync('/tmp/qe-report-image.json', 'utf8'));
const digest = metadata['containerimage.digest'];
if (typeof digest !== 'string' || !digest.startsWith('sha256:')) {
  process.stderr.write('the build did not report an image digest\n');
  process.exit(1);
}

if (existing !== undefined && existing !== digest) {
  process.stderr.write(
    `${exact} already exists as ${existing} and this build produced ${digest}.\n` +
      'An exact version tag is never overwritten with different bytes. Release a new version.\n',
  );
  process.exit(1);
}

// The aliases point at the same manifest. No rebuild: the digest is the release.
for (const tag of container.tags.filter((t) => t !== version)) {
  run('docker', [
    'buildx',
    'imagetools',
    'create',
    '--tag',
    `${container.repository}:${tag}`,
    `${container.repository}@${digest}`,
  ]);
  process.stdout.write(`${container.repository}:${tag} -> ${digest}\n`);
}

// Every tag resolves to the one digest, checked rather than assumed.
for (const tag of container.tags) {
  const resolved = publishedDigest(`${container.repository}:${tag}`);
  if (resolved !== digest) {
    process.stderr.write(`${container.repository}:${tag} resolves to ${resolved}, not ${digest}\n`);
    process.exit(1);
  }
}

if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
}
process.stdout.write(`published ${exact} at ${digest} for ${platform}\n`);
