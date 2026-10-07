#!/usr/bin/env node
/**
 * Checks the five public names against the real npm registry.
 *
 * A name that has been taken since this release was prepared is a naming decision, not something to
 * work around: the release stops and a person decides. Nothing here renames a package, appends a
 * suffix, or picks a scope.
 *
 * This reads the registry and writes nothing to it. A name that is already ours, published at an
 * earlier version, is fine; a name owned by somebody else is not.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, npm } = contract;

/** Who may publish this project's packages. A maintainer outside this set is somebody else. */
const OURS = new Set(['yannisyoussef']);

const problems = [];
const report = [];

for (const name of npm.public) {
  const response = await fetch(`https://registry.npmjs.org/${name}`, {
    headers: { accept: 'application/json' },
  });
  if (response.status === 404) {
    report.push(`${name}: available`);
    continue;
  }
  if (!response.ok) {
    problems.push(`${name}: the registry answered ${response.status}, so ownership is unknown`);
    continue;
  }
  const metadata = await response.json();
  const maintainers = (metadata.maintainers ?? []).map((m) => m.name);
  const foreign = maintainers.filter((m) => !OURS.has(m));
  if (maintainers.length === 0 || foreign.length > 0) {
    problems.push(
      `${name} is published by ${maintainers.join(', ') || 'an unknown maintainer'}. ` +
        'This is a naming decision and needs a person: do not rename, scope or suffix around it.',
    );
    continue;
  }
  const versions = Object.keys(metadata.versions ?? {});
  if (versions.includes(productVersion)) {
    report.push(`${name}: ours, and ${productVersion} is already published`);
  } else {
    report.push(`${name}: ours, ${versions.length} versions, ${productVersion} not yet published`);
  }
}

for (const line of report) process.stdout.write(`${line}\n`);
if (problems.length > 0) {
  process.stderr.write('\nthe release cannot use these names:\n');
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}
process.stdout.write(`all ${npm.public.length} names are available or already ours\n`);
