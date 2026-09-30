#!/usr/bin/env node
/**
 * Checks that a released version really is published, everywhere it claims to be.
 *
 * Read-only, public endpoints, no credentials. It is what the release workflow runs before creating
 * the GitHub Release, so that the Release is an index of things that exist rather than a claim, and
 * it is also what anybody can run afterwards to check a release for themselves.
 *
 *   node release/verify-published.mjs 1.0.0
 *
 * It is release tooling and has nothing to do with the running service.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { npm, maven, container, repository } = contract;
const version = process.argv[2] ?? contract.productVersion;

const problems = [];
const found = [];

// npm: the version exists, and it was published with provenance.
for (const name of npm.public) {
  const response = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    problems.push(`${name}@${version} is not on npm (${response.status})`);
    continue;
  }
  const published = await response.json();
  const attestations = published.dist?.attestations;
  found.push(
    `npm ${name}@${version} ${published.dist?.integrity?.slice(0, 24)}…` +
      `${attestations === undefined ? ' WITHOUT provenance' : ' with provenance'}`,
  );
  if (attestations === undefined) {
    problems.push(`${name}@${version} has no provenance attestation`);
  }
}

// Maven Central: the POM and the signature beside it.
for (const artifactId of maven.public) {
  const base = `https://repo1.maven.org/maven2/${maven.groupId.replaceAll('.', '/')}/${artifactId}/${version}/${artifactId}-${version}`;
  for (const suffix of ['.pom', '.jar', '.jar.asc', '-sources.jar', '-javadoc.jar']) {
    const response = await fetch(`${base}${suffix}`, { method: 'HEAD' });
    if (!response.ok)
      problems.push(`${artifactId}${suffix} is not on Central (${response.status})`);
  }
  found.push(`maven ${maven.groupId}:${artifactId}:${version}`);
}

// The container: every tag resolves, and they all resolve to the same digest.
const digests = new Map();
for (const tag of container.tags) {
  const reference = `${container.repository}:${tag}`;
  const [, owner, name] = /^ghcr\.io\/([^/]+)\/(.+)$/u.exec(container.repository) ?? [];
  if (owner === undefined) {
    problems.push(`${container.repository} is not a GHCR reference this can check`);
    break;
  }
  // GHCR serves a token for anonymous pulls of a public package.
  const auth = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${name}:pull`,
  );
  if (!auth.ok) {
    problems.push(`could not get a pull token for ${container.repository} (${auth.status})`);
    break;
  }
  const { token } = await auth.json();
  const manifest = await fetch(`https://ghcr.io/v2/${owner}/${name}/manifests/${tag}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept:
        'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
    },
  });
  if (!manifest.ok) {
    problems.push(`${reference} is not on GHCR (${manifest.status})`);
    continue;
  }
  const digest = manifest.headers.get('docker-content-digest');
  digests.set(tag, digest);
  found.push(`container ${reference} ${digest?.slice(0, 20)}…`);
}
const distinct = new Set([...digests.values()]);
if (digests.size > 1 && distinct.size !== 1) {
  problems.push(
    `the container tags resolve to ${distinct.size} different digests: ${[...digests.entries()].map(([t, d]) => `${t}=${d?.slice(0, 16)}`).join(', ')}`,
  );
}

// The GitHub Release, and its assets.
const release = await fetch(
  `https://api.github.com/repos/${repository.url.replace('https://github.com/', '')}/releases/tags/v${version}`,
  { headers: { accept: 'application/vnd.github+json' } },
);
if (!release.ok) {
  // Before the workflow creates it this is expected, so it is reported rather than fatal.
  found.push(`github release v${version}: not created yet (${release.status})`);
} else {
  const body = await release.json();
  const assets = (body.assets ?? []).map((a) => a.name);
  found.push(`github release v${version} with ${assets.length} assets`);
  for (const wanted of ['release-manifest.json', 'SHA256SUMS']) {
    if (!assets.includes(wanted)) problems.push(`the GitHub Release has no ${wanted}`);
  }
}

for (const line of found) process.stdout.write(`${line}\n`);
if (problems.length > 0) {
  process.stderr.write(`\nqe-report ${version} is not fully published:\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}
process.stdout.write(`\nqe-report ${version} is published everywhere it claims to be\n`);
