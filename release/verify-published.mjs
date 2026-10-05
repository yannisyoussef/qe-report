#!/usr/bin/env node
/**
 * Checks that a released version really is published, and that what is published is what this
 * release built.
 *
 * Presence is not proof. A version that exists but whose bytes differ from the artefacts this
 * release produced is a different thing wearing the same name and number, so wherever the release
 * candidate is available this compares content rather than existence. Where it is not available --
 * somebody checking a published release from a fresh clone -- it says which checks it could not
 * make instead of passing quietly.
 *
 *   node release/verify-published.mjs 1.0.0
 *
 * Read-only, public endpoints, no credentials. The release workflow runs it before creating the
 * GitHub Release, so that Release is an index of things that exist rather than a claim.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCentralArtifacts, compareNpmIntegrity } from './evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { npm, maven, container, repository } = contract;
const version = process.argv[2] ?? contract.productVersion;
const OUT = join(ROOT, 'build', 'release', version);
const CENTRAL = 'https://repo1.maven.org/maven2';
const groupPath = maven.groupId.replaceAll('.', '/');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const problems = [];
const found = [];
const notChecked = [];

/** The release candidate this check compares against, when it is present. */
function candidate() {
  const manifestPath = join(OUT, 'manifest', 'release-manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}
const built = candidate();
if (built === undefined) {
  notChecked.push(
    'no release candidate is present, so npm integrity and Maven content could not be compared ' +
      'against what this release built; only presence, provenance and signatures were checked',
  );
}

// ---------------------------------------------------------------------------------------------
// npm: the versions exist, carry provenance, and are the tarballs this release built.
// ---------------------------------------------------------------------------------------------
const registryView = {};
for (const name of npm.public) {
  const response = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    problems.push(`${name}@${version} is not on npm (${response.status})`);
    continue;
  }
  const published = await response.json();
  const integrity = published.dist?.integrity;
  const hasProvenance = published.dist?.attestations !== undefined;
  registryView[`${name}@${version}`] = { integrity, hasProvenance };
  found.push(
    `npm ${name}@${version} ${integrity?.slice(0, 22)}…${hasProvenance ? ' with provenance' : ' WITHOUT provenance'}`,
  );
  if (!hasProvenance) problems.push(`${name}@${version} has no provenance attestation`);
}
if (built !== undefined) {
  const recorded = built.npm.packages.map((p) => ({
    name: p.name,
    version: p.version,
    integrity: p.integrity,
  }));
  const compared = compareNpmIntegrity(recorded, registryView);
  for (const problem of compared.problems) problems.push(`${problem.refusal}: ${problem.detail}`);
  if (compared.ok)
    found.push(`npm: ${compared.checked.length} packages match what this release built`);
}

// ---------------------------------------------------------------------------------------------
// Maven Central: every artifact and its signature, and the deterministic ones by content.
// ---------------------------------------------------------------------------------------------
const servedNames = (artifactId) => ({
  pom: `${artifactId}-${version}.pom`,
  jar: `${artifactId}-${version}.jar`,
  'sources.jar': `${artifactId}-${version}-sources.jar`,
  'javadoc.jar': `${artifactId}-${version}-javadoc.jar`,
});
const DETERMINISTIC = ['pom', 'jar', 'sources.jar'];

const central = {};
for (const artifactId of maven.public) {
  const base = `${CENTRAL}/${groupPath}/${artifactId}/${version}`;
  const gav = `${maven.groupId}:${artifactId}:${version}`;
  const classifiers = {};
  const signatures = [];
  for (const [classifier, name] of Object.entries(servedNames(artifactId))) {
    const response = await fetch(`${base}/${name}`);
    if (!response.ok) {
      problems.push(`${name} is not on Central (${response.status})`);
      continue;
    }
    classifiers[classifier] = sha256(Buffer.from(await response.arrayBuffer()));
    const signature = await fetch(`${base}/${name}.asc`, { method: 'HEAD' });
    if (signature.ok) signatures.push(classifier);
    else problems.push(`${name} has no .asc beside it`);
  }
  central[gav] = { classifiers, signatures };
  found.push(`maven ${gav} with ${signatures.length} signatures`);
}
if (built !== undefined && built.maven.published !== null) {
  // The release recorded the digests of what Central served when it published. If Central serves
  // something else now, one of the two is wrong and neither may be assumed.
  const recorded = built.maven.published.map((artifact) => ({
    gav: artifact.gav,
    classifiers: Object.fromEntries(
      Object.entries(artifact.published ?? {}).filter(([, sha]) => sha !== null),
    ),
  }));
  const compared = compareCentralArtifacts(recorded, central, DETERMINISTIC);
  for (const problem of compared.problems) problems.push(`${problem.refusal}: ${problem.detail}`);
  if (compared.ok) {
    found.push(`maven: ${compared.checked.length} artifacts match the recorded release evidence`);
  }
  const key = built.maven.signingKey;
  if (key?.fingerprint === undefined) {
    notChecked.push(
      'the release recorded no signing-key fingerprint, so signatures were not traced to a key',
    );
  } else {
    found.push(`maven signatures were made by key ${key.fingerprint.slice(-16)}`);
  }
} else if (built !== undefined) {
  notChecked.push('the release candidate records no published Maven digests to compare against');
}

// ---------------------------------------------------------------------------------------------
// GHCR: the exact tag exists, and every alias resolves to that same digest.
// ---------------------------------------------------------------------------------------------
const [, owner, name] = /^ghcr\.io\/([^/]+)\/(.+)$/u.exec(container.repository) ?? [];
if (owner === undefined) {
  problems.push(`${container.repository} is not a GHCR reference this can check`);
} else {
  const auth = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${name}:pull`,
  );
  if (!auth.ok) {
    problems.push(`could not get a pull token for ${container.repository} (${auth.status})`);
  } else {
    const { token } = await auth.json();
    const digests = new Map();
    for (const tag of container.tags) {
      const manifest = await fetch(`https://ghcr.io/v2/${owner}/${name}/manifests/${tag}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept:
            'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
        },
      });
      if (!manifest.ok) {
        problems.push(`${container.repository}:${tag} is not on GHCR (${manifest.status})`);
        continue;
      }
      const digest = manifest.headers.get('docker-content-digest');
      digests.set(tag, digest);
      found.push(`container ${container.repository}:${tag} ${digest?.slice(0, 20)}…`);
    }
    const exact = digests.get(version);
    if (exact === undefined) {
      problems.push(`the exact version tag ${version} is not published`);
    } else {
      for (const [tag, digest] of digests) {
        if (digest !== exact) {
          problems.push(
            `${container.repository}:${tag} is ${digest}, not the exact tag's ${exact}`,
          );
        }
      }
      if (built?.container?.digest !== undefined && built.container.digest !== null) {
        if (built.container.digest !== exact) {
          problems.push(
            `the release recorded the digest ${built.container.digest} but GHCR serves ${exact}`,
          );
        } else {
          found.push('container: the published digest matches the recorded release evidence');
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The GitHub Release, which does not exist yet when this runs before creating it.
// ---------------------------------------------------------------------------------------------
const slug = repository.url.replace('https://github.com/', '');
const release = await fetch(`https://api.github.com/repos/${slug}/releases/tags/v${version}`, {
  headers: { accept: 'application/vnd.github+json' },
});
if (!release.ok) {
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
for (const line of notChecked) process.stdout.write(`not checked: ${line}\n`);
if (problems.length > 0) {
  process.stderr.write(
    `\nqe-report ${version} is not fully published, or is not what this release built:\n`,
  );
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  `\nqe-report ${version} is published, and matches the evidence available here\n`,
);
