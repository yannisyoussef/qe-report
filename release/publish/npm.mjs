#!/usr/bin/env node
/**
 * Publishes the packed tarballs to npm, in dependency order, resuming safely.
 *
 * Run only by the release workflow, from the release environment. It is in this directory, rather
 * than beside the rehearsal, because the rehearsal asserts that nothing it runs can publish and
 * that boundary is a directory a person can see.
 *
 * Registry publication is not atomic and a run may be a resume, so for each package: if the version
 * is absent, publish it; if it is present and its integrity matches the tarball built here, it was
 * already done; if it is present and differs, stop. A published version is never replaced.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISHED, compareNpmIntegrity } from '../evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, npm } = contract;
const NPM_OUT = join(ROOT, 'build', 'release', productVersion, 'npm');

if (process.env.NODE_AUTH_TOKEN === undefined || process.env.NODE_AUTH_TOKEN === '') {
  process.stderr.write('no npm credential: refusing to continue rather than skipping npm\n');
  process.exit(1);
}

const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
/** What the registry serves, gathered as packages go out, for the comparison at the end. */
const registryView = {};

for (const name of npm.public) {
  const tarball = join(NPM_OUT, `${name}-${productVersion}.tgz`);
  if (!existsSync(tarball)) {
    process.stderr.write(`${name} was not packed; the preflight should have produced it\n`);
    process.exit(1);
  }
  const bytes = readFileSync(tarball);
  const local = integrityOf(bytes);

  const response = await fetch(`https://registry.npmjs.org/${name}/${productVersion}`, {
    headers: { accept: 'application/json' },
  });
  if (response.ok) {
    const published = await response.json();
    const registry = published.dist?.integrity;
    if (registry === local) {
      process.stdout.write(`${name}@${productVersion} is already published and matches\n`);
      continue;
    }
    process.stderr.write(
      `${name}@${productVersion} is already published and does NOT match what this release built.\n` +
        `  registry: ${registry}\n  here:     ${local}\n` +
        'A published version is immutable. Do not replace it: release the fix as a new version.\n',
    );
    process.exit(1);
  }
  if (response.status !== 404) {
    process.stderr.write(`the registry answered ${response.status} for ${name}; stopping\n`);
    process.exit(1);
  }

  process.stdout.write(`publishing ${name}@${productVersion}\n`);
  const published = spawnSync('npm', ['publish', tarball, '--provenance', '--access', 'public'], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (published.status !== 0) {
    process.stderr.write(`${name} did not publish; later packages were not attempted\n`);
    process.exit(1);
  }
}
// What the registry serves now, compared with what this release built, for every package. This is
// the evidence the final manifest uses; presence and provenance alone would not establish that the
// tarball a consumer installs is the one this release produced.
const evidence = { origin: PUBLISHED, registry: 'https://registry.npmjs.org', packages: [] };
const recorded = [];
for (const name of npm.public) {
  const tarball = join(NPM_OUT, `${name}-${productVersion}.tgz`);
  const built = integrityOf(readFileSync(tarball));
  const response = await fetch(`https://registry.npmjs.org/${name}/${productVersion}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    process.stderr.write(`${name}@${productVersion} is not served after publishing it\n`);
    process.exit(1);
  }
  const published = await response.json();
  const registryIntegrity = published.dist?.integrity;
  const provenance = published.dist?.attestations !== undefined;
  evidence.packages.push({ name, version: productVersion, registryIntegrity, provenance });
  recorded.push({ name, version: productVersion, integrity: built });
  registryView[`${name}@${productVersion}`] = {
    integrity: registryIntegrity,
    hasProvenance: provenance,
  };
}

const compared = compareNpmIntegrity(recorded, registryView);
if (!compared.ok) {
  process.stderr.write('what npm serves is not what this release built:\n');
  for (const problem of compared.problems) {
    process.stderr.write(`  - ${problem.refusal}: ${problem.detail}\n`);
  }
  process.exit(1);
}

writeFileSync(
  join(ROOT, 'build', 'release', productVersion, 'npm-evidence.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
process.stdout.write(
  `all ${npm.public.length} packages are published at ${productVersion}, ` +
    `and ${compared.checked.length} match what this release built\n`,
);
