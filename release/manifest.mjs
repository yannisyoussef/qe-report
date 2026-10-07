#!/usr/bin/env node
/**
 * Generates the release-time artefacts that describe a release: a dependency SBOM, a manifest of
 * what this release is made of, and checksums over the downloadable assets.
 *
 * The committed `release/release.json` says what a release *should* be. These say what one *is*:
 * the commit it came from, the exact packages and their integrities, the resolved third-party
 * dependencies, and the digests of everything published alongside. Facts that only exist once a
 * registry has accepted something -- a container digest, a Central deployment state -- are left as
 * null here and filled in by the release workflow. Nothing is invented: a field this machine cannot
 * know says so.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptCentralState, acceptPublishedEvidence } from './evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, gitTag, compatibility, runtimes, npm, maven, container, repository } =
  contract;
const OUT = join(ROOT, 'build', 'release', productVersion);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256File = (path) => sha256(readFileSync(path));

function capture(file, args, options = {}) {
  const finished = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (finished.status !== 0) return undefined;
  return finished.stdout;
}

/** The commit this release is built from, or nothing if this is not a git checkout. */
function gitCommit() {
  return capture('git', ['-C', ROOT, 'rev-parse', 'HEAD'])?.trim();
}

/**
 * Every production dependency of the public npm packages, flattened. Read from pnpm's own
 * resolution rather than from a lockfile this script would have to interpret.
 */
/** What an installed npm package says its licence is. */
function declaredNpmLicense(path) {
  if (typeof path !== 'string') return 'NOASSERTION';
  try {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (typeof manifest.license === 'string') return manifest.license;
    if (typeof manifest.license?.type === 'string') return manifest.license.type;
    if (Array.isArray(manifest.licenses)) {
      return manifest.licenses.map((l) => l.type ?? 'NOASSERTION').join(' OR ');
    }
  } catch {
    return 'NOASSERTION';
  }
  return 'NOASSERTION';
}

/** What a resolved Maven dependency's own POM says its licence is, from Gradle's module cache. */
function declaredMavenLicense(group, name, version) {
  const cache = join(
    homedir(),
    '.gradle',
    'caches',
    'modules-2',
    'files-2.1',
    group,
    name,
    version,
  );
  if (!existsSync(cache)) return 'NOASSERTION';
  for (const entry of readdirSync(cache)) {
    const pom = join(cache, entry, `${name}-${version}.pom`);
    if (!existsSync(pom)) continue;
    const text = readFileSync(pom, 'utf8');
    const named = /<licenses>[\s\S]*?<name>([^<]+)<\/name>/u.exec(text)?.[1];
    if (named !== undefined) return named.trim();
    if (/<parent>/u.test(text)) return 'NOASSERTION (declared by a parent POM)';
  }
  return 'NOASSERTION';
}

function npmDependencies() {
  const found = new Map();
  const listed = capture(
    'pnpm',
    [
      'list',
      '--prod',
      '--depth',
      'Infinity',
      '--json',
      ...npm.public.flatMap((p) => ['--filter', p]),
    ],
    { cwd: join(ROOT, 'ts') },
  );
  // Loudly, not quietly. This used to return an empty map when pnpm could not run, which produced
  // a release SBOM that silently omitted every npm dependency and still looked like a valid one.
  if (listed === undefined) {
    throw new Error(
      'pnpm could not list the production dependencies, so the SBOM would describe only part of ' +
        'the release. Install dependencies first, and make sure pnpm is on PATH.',
    );
  }
  const walk = (dependencies) => {
    for (const [name, entry] of Object.entries(dependencies ?? {})) {
      // A workspace sibling is part of this release, not a third-party dependency of it.
      if (npm.public.includes(name) || npm.internal.includes(name)) {
        walk(entry.dependencies);
        continue;
      }
      found.set(`${name}@${entry.version}`, {
        name,
        version: entry.version,
        resolved: entry.resolved,
        ecosystem: 'npm',
        // The dependency's own statement about itself, read from the installed package.
        license: declaredNpmLicense(entry.path),
      });
      walk(entry.dependencies);
    }
  };
  for (const project of JSON.parse(listed)) walk(project.dependencies);
  return found;
}

/** Every runtime dependency of the published Maven artifacts, as the Gradle build resolved them. */
function javaDependencies() {
  const found = new Map();
  for (const artifactId of maven.public) {
    const module = artifactId.replace(/^qe-report-/u, '');
    const path = join(ROOT, 'java', module, 'build', 'release-dependencies.txt');
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const coordinates = line.split('\t')[1]?.trim();
      if (coordinates === undefined || coordinates === '') continue;
      const [group, name, version] = coordinates.split(':');
      if (version === undefined) continue;
      found.set(coordinates, {
        name: `${group}:${name}`,
        version,
        ecosystem: 'maven',
        license: declaredMavenLicense(group, name, version),
      });
    }
  }
  return found;
}

/** An SPDX 2.3 document. One SBOM for the release's own dependencies, in both ecosystems. */
function spdx(dependencies, commit) {
  const packages = [
    {
      SPDXID: 'SPDXRef-Package-qe-report',
      name: 'qe-report',
      versionInfo: productVersion,
      downloadLocation: `${repository.url}/releases/tag/${gitTag}`,
      filesAnalyzed: false,
      licenseConcluded: repository.license,
      licenseDeclared: repository.license,
      copyrightText: 'NOASSERTION',
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: `pkg:github/yannisyoussef/qe-report@${commit ?? gitTag}`,
        },
      ],
    },
  ];
  const relationships = [
    {
      spdxElementId: 'SPDXRef-DOCUMENT',
      relatedSpdxElement: 'SPDXRef-Package-qe-report',
      relationshipType: 'DESCRIBES',
    },
  ];
  let n = 0;
  for (const dependency of [...dependencies.values()].sort((a, b) =>
    `${a.ecosystem}${a.name}${a.version}`.localeCompare(`${b.ecosystem}${b.name}${b.version}`),
  )) {
    n += 1;
    const id = `SPDXRef-Package-${n}`;
    const purl =
      dependency.ecosystem === 'npm'
        ? `pkg:npm/${dependency.name.replace('@', '%40')}@${dependency.version}`
        : `pkg:maven/${dependency.name.replace(':', '/')}@${dependency.version}`;
    packages.push({
      SPDXID: id,
      name: dependency.name,
      versionInfo: dependency.version,
      downloadLocation: dependency.resolved ?? 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: dependency.license ?? 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: purl,
        },
      ],
    });
    relationships.push({
      spdxElementId: 'SPDXRef-Package-qe-report',
      relatedSpdxElement: id,
      relationshipType: 'DEPENDS_ON',
    });
  }
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `qe-report-${productVersion}`,
    documentNamespace: `${repository.url}/spdx/${productVersion}/${commit ?? 'unknown'}`,
    creationInfo: {
      // No timestamp from this machine's clock: the same source should describe itself the same way.
      created: '1970-01-01T00:00:00Z',
      creators: ['Tool: qe-report-release-manifest', `Organization: ${repository.url}`],
      comment:
        'Dependency SBOM for the qe-report release, from pnpm production resolution and the Gradle runtime classpath of each published module. The container image has its own SBOM, attested against its digest.',
    },
    packages,
    relationships,
  };
}

/**
 * With `--published`, the manifest must be complete: every field a registry decides has to have
 * arrived. The release workflow runs it that way after publishing, so a manifest that still says
 * null fails rather than being attached to a release as though it were finished.
 */
const requirePublished = process.argv.includes('--published');

/**
 * One piece of evidence a publishing job wrote, or nothing if that job has not run.
 *
 * Each is tagged with where it came from. That matters most for Maven: the rehearsal signs a bundle
 * with an ephemeral key and the real release signs a different one with the production key, and the
 * two are indistinguishable by shape. Recording the rehearsal's digest under a field that implies
 * publication would state something untrue that nothing downstream could detect, so the final
 * manifest refuses untagged or rehearsal evidence rather than relabelling it.
 */
function publishedEvidence(name) {
  const path = join(OUT, `${name}-evidence.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function generateManifest() {
  mkdirSync(join(OUT, 'sbom'), { recursive: true });
  mkdirSync(join(OUT, 'manifest'), { recursive: true });
  const commit = gitCommit();
  const problems = [];

  const dependencies = new Map([...npmDependencies(), ...javaDependencies()]);
  if (dependencies.size === 0) {
    problems.push('no dependencies were resolved; the SBOM would be empty');
  }
  const sbomPath = join(OUT, 'sbom', `qe-report-${productVersion}.spdx.json`);
  writeFileSync(sbomPath, `${JSON.stringify(spdx(dependencies, commit), null, 2)}\n`);

  // The npm tarballs, with the integrity a registry would record.
  const npmDir = join(OUT, 'npm');
  const packages = npm.public.map((name) => {
    const tarball = join(npmDir, `${name}-${productVersion}.tgz`);
    if (!existsSync(tarball)) {
      problems.push(`${name} has not been packed`);
      return {
        name,
        version: productVersion,
        tarball: null,
        sha256: null,
        integrity: null,
      };
    }
    const bytes = readFileSync(tarball);
    return {
      name,
      version: productVersion,
      tarball: relative(OUT, tarball),
      sha256: sha256(bytes),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
  });

  const bundle = join(OUT, 'maven', `qe-report-${productVersion}-central-bundle.zip`);
  const openapi = join(ROOT, 'openapi', 'qe-report-api-v1.json');
  const schema = join(ROOT, 'protocol', 'schema', 'event.schema.json');

  const mavenEvidence = publishedEvidence('maven');
  const containerEvidence = publishedEvidence('container');
  const npmEvidence = publishedEvidence('npm');

  const manifest = {
    $comment:
      'Generated. What this release is, as built. Fields a registry decides are null until the release workflow fills them.',
    productVersion,
    gitTag,
    gitCommit: commit ?? null,
    compatibility,
    runtimes,
    npm: {
      registry: 'https://registry.npmjs.org',
      // `integrity` is what this release built; `registryIntegrity` is what the registry serves,
      // and it appears only once the publishing job has compared the two and agreed.
      packages: packages.map((entry) => {
        const published = npmEvidence?.packages?.find((p) => p.name === entry.name);
        return {
          ...entry,
          registryIntegrity: published?.registryIntegrity ?? null,
          provenance: published?.provenance ?? null,
        };
      }),
      publishOrder: npm.public,
    },
    maven: {
      repository: 'https://central.sonatype.com',
      artifacts: maven.public.map((a) => `${maven.groupId}:${a}:${productVersion}`),
      // The bundle is a transport object, not a published artifact, and is labelled as the
      // candidate it is. What describes the release publicly is the digests of what Central
      // actually serves, which only the publishing job can know.
      candidateBundle: existsSync(bundle)
        ? { file: relative(OUT, bundle), sha256: sha256File(bundle), origin: 'rehearsal' }
        : null,
      published: mavenEvidence?.artifacts ?? null,
      signingKey: mavenEvidence?.signingKey ?? null,
      uploadBundle: mavenEvidence?.uploadBundle ?? null,
      // Only Central can say this, so it comes from the job that polled it.
      deploymentState: mavenEvidence?.state ?? null,
    },
    container: {
      repository: container.repository,
      tags: container.tags,
      platforms: container.platforms,
      // Only a registry can say this, so it comes from the job that pushed or adopted the image.
      digest: containerEvidence?.digest ?? null,
      // BuildKit attests the image's own SBOM against that digest during the push.
      sbom: containerEvidence === undefined ? null : 'attested against the digest',
      // True when a resume found the exact tag already published and adopted it rather than
      // rebuilding, which is the only correct thing to do with an immutable tag.
      adoptedExistingTag: containerEvidence?.adopted ?? null,
    },
    assets: {
      sbom: { file: relative(OUT, sbomPath), sha256: sha256File(sbomPath) },
      openapi: {
        file: 'openapi/qe-report-api-v1.json',
        sha256: sha256File(openapi),
      },
      protocolSchema: {
        file: 'protocol/schema/event.schema.json',
        sha256: sha256File(schema),
      },
    },
    dependencies: {
      count: dependencies.size,
      npm: [...dependencies.values()].filter((d) => d.ecosystem === 'npm').length,
      maven: [...dependencies.values()].filter((d) => d.ecosystem === 'maven').length,
    },
    build: {
      // Present in Actions, absent on a developer machine, and never guessed.
      workflow: process.env.GITHUB_WORKFLOW ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      repository: process.env.GITHUB_REPOSITORY ?? null,
    },
  };
  const manifestPath = join(OUT, 'manifest', 'release-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Checksums over what a person can download, and nothing else. Not signatures, and not claimed
  // to be: they detect a truncated or corrupted download.
  const assets = [
    manifestPath,
    sbomPath,
    openapi,
    schema,
    ...(existsSync(bundle) ? [bundle] : []),
    ...npm.public
      .map((name) => join(npmDir, `${name}-${productVersion}.tgz`))
      .filter((p) => existsSync(p)),
  ];
  const sums = assets
    .map(
      (path) =>
        `${sha256File(path)}  ${path.startsWith(OUT) ? relative(OUT, path) : relative(ROOT, path)}`,
    )
    .sort();
  // A licence inventory a person can read, beside the SBOM a tool can. Neither is legal advice;
  // both say what each dependency declares about itself.
  const licences = [...dependencies.values()]
    .map((d) => `${d.ecosystem}\t${d.name}\t${d.version}\t${d.license ?? 'NOASSERTION'}`)
    .sort();
  writeFileSync(
    join(OUT, 'manifest', 'dependency-licenses.tsv'),
    `ecosystem\tdependency\tversion\tdeclared license\n${licences.join('\n')}\n`,
  );

  const sumsPath = join(OUT, 'SHA256SUMS');
  writeFileSync(sumsPath, `${sums.join('\n')}\n`);

  if (requirePublished) {
    // Every registry fact has to have come from a publication and be tagged as such. Rehearsal
    // evidence is refused here rather than relabelled.
    for (const [what, evidence] of [
      ['npm', npmEvidence],
      ['maven', mavenEvidence],
      ['the container', containerEvidence],
    ]) {
      const accepted = acceptPublishedEvidence(evidence, what);
      if (!accepted.ok) problems.push(`${accepted.refusal}: ${accepted.detail}`);
    }
    const central = acceptCentralState(manifest.maven.deploymentState);
    if (!central.ok) problems.push(`${central.refusal}: ${central.detail}`);
    if (manifest.container.digest === null) problems.push('no container digest was recorded');
    if (manifest.gitCommit === null) problems.push('no commit was recorded');

    // What the registry serves, compared with what this release built. Presence is not proof.
    for (const entry of manifest.npm.packages) {
      if (entry.integrity === null) {
        problems.push(`${entry.name} has no integrity for the tarball this release built`);
      } else if (entry.registryIntegrity === null) {
        problems.push(`${entry.name} has no registry integrity, so nothing was compared`);
      } else if (entry.registryIntegrity !== entry.integrity) {
        problems.push(
          `${entry.name} is served as ${entry.registryIntegrity} but this release built ` +
            `${entry.integrity}`,
        );
      }
      if (entry.provenance !== true) problems.push(`${entry.name} has no provenance`);
    }
    if (manifest.maven.published === null) {
      problems.push('no published Maven artifact digests were recorded');
    }
    // A candidate bundle is rehearsal evidence. It may sit in the manifest as the candidate it is,
    // but it must never be the only thing describing a publication.
    if (manifest.maven.candidateBundle !== null && manifest.maven.uploadBundle === null) {
      problems.push(
        'the manifest records a candidate bundle but no submitted one; a rehearsal bundle is not ' +
          'evidence of publication',
      );
    }
  }

  return {
    problems,
    manifest: relative(ROOT, manifestPath),
    sbom: relative(ROOT, sbomPath),
    checksums: relative(ROOT, sumsPath),
    dependencies: dependencies.size,
    assets: assets.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = generateManifest();
  process.stdout.write(
    `release manifest, SBOM (${result.dependencies} dependencies) and checksums over ${result.assets} assets\n`,
  );
  for (const path of [result.manifest, result.sbom, result.checksums]) {
    process.stdout.write(`  ${path}\n`);
  }
  if (result.problems.length > 0) {
    process.stderr.write('\nthe release metadata is incomplete:\n');
    for (const problem of result.problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
}
