#!/usr/bin/env node
/**
 * Publishes the release image, without ever moving an exact version tag.
 *
 * The order matters and is the point. The exact tag is inspected first, the decision about whether
 * to push is made from that inspection, and only then does anything happen. Pushing and then
 * comparing digests -- which is what this used to do -- reports a violation it has already
 * committed: by the time the comparison fails, the immutable tag has moved.
 *
 * Inspection has three outcomes. "Not found" and "could not ask" are different answers, and an
 * ambiguous failure aborts rather than being read as an absent tag.
 *
 * On resume, an existing exact tag whose identity is this release is canonical and is adopted. It
 * is not required to equal a fresh rebuild: BuildKit records provenance and an SBOM into the image,
 * so the same source can legitimately produce a different digest, and demanding equality would turn
 * a correct resume into a failure. The moving aliases may be repaired; the exact tag never is.
 *
 * The decisions live in release/container-tags.mjs and are tested in ordinary CI. This file gathers
 * facts and carries them out.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABSENT, PRESENT, UNKNOWN, aliasesToRepair, decideExactTag } from '../container-tags.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, container, repository } = contract;
const version = process.env.PRODUCT_VERSION ?? productVersion;
const revision = process.env.SOURCE_REVISION;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (version !== productVersion) {
  fail(`refusing to publish ${version} when the release contract says ${productVersion}`);
}
if (revision === undefined || revision === '') {
  fail('no SOURCE_REVISION: the image must record the commit it came from');
}

function run(file, args, options = {}) {
  const finished = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  const output = `${finished.stdout ?? ''}${finished.stderr ?? ''}`;
  if (finished.status !== 0) {
    throw new Error(
      `${file} ${args.slice(0, 3).join(' ')} exited ${finished.status}: ${output.slice(-800)}`,
    );
  }
  return output;
}

const exact = `${container.repository}:${version}`;
const platform = container.platforms.join(',');

/**
 * What the registry says about one reference: present with a digest, absent, or unknown.
 *
 * The distinction is drawn from what the registry actually said. A manifest-unknown error is an
 * absent tag; anything else -- authentication, the network, a rate limit, an unparsable answer --
 * is unknown, and unknown is never treated as absent.
 */
function inspect(reference) {
  const finished = spawnSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${finished.stdout ?? ''}${finished.stderr ?? ''}`;
  if (finished.error !== undefined) {
    return { state: UNKNOWN, why: `the inspection could not run: ${finished.error.message}` };
  }
  if (finished.status !== 0) {
    // Only this family of answers means "there is nothing there".
    const notFound =
      /manifest unknown|not found|MANIFEST_UNKNOWN|NAME_UNKNOWN|no such manifest/iu.test(output);
    if (notFound) return { state: ABSENT };
    return { state: UNKNOWN, why: output.trim().split('\n').slice(-3).join(' ') };
  }
  const shown = spawnSync('docker', ['buildx', 'imagetools', 'inspect', reference], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const digest = /Digest:\s+(sha256:[0-9a-f]{64})/u.exec(shown.stdout ?? '')?.[1];
  if (digest === undefined) {
    return { state: UNKNOWN, why: 'the registry answered but no digest could be read from it' };
  }
  return { state: PRESENT, digest };
}

/** What an existing image claims about itself, from its OCI labels and its platform. */
function identityOf(reference) {
  const raw = run('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference]);
  let platforms = [];
  try {
    const manifest = JSON.parse(raw);
    platforms = (manifest.manifests ?? [])
      .filter((m) => m.platform?.os !== undefined && m.platform.os !== 'unknown')
      .map((m) => `${m.platform.os}/${m.platform.architecture}`);
  } catch {
    platforms = [];
  }
  const config = JSON.parse(
    run('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Image}}']),
  );
  // A single-platform image inspects as one config; a multi-platform one as a map by platform.
  const labelsOf = (image) => image?.config?.Labels ?? image?.Config?.Labels ?? {};
  const labels =
    config.config !== undefined || config.Config !== undefined
      ? labelsOf(config)
      : labelsOf(Object.values(config)[0]);
  if (platforms.length === 0) {
    const single = config.platform ?? Object.values(config)[0]?.platform;
    if (single?.os !== undefined) platforms = [`${single.os}/${single.architecture}`];
  }
  return {
    version: labels['org.opencontainers.image.version'],
    revision: labels['org.opencontainers.image.revision'],
    source: labels['org.opencontainers.image.source'],
    platform: platforms.sort().join(','),
  };
}

const expected = {
  version,
  revision,
  source: repository.url,
  platform,
};

// 1. Ask about the exact tag, before anything is built or pushed.
const looked = inspect(exact);
process.stdout.write(
  `${exact}: ${looked.state}${looked.why === undefined ? '' : ` (${looked.why})`}\n`,
);

const existingIdentity =
  looked.state === PRESENT ? identityOf(`${container.repository}@${looked.digest}`) : undefined;

// 2. Decide. This is the whole safety property, and it is tested in ordinary CI.
const decision = decideExactTag({
  state: looked.state,
  digest: looked.digest,
  identity: existingIdentity,
  expected,
});
if (!decision.ok) fail(`${decision.refusal}: ${decision.detail}`);
process.stdout.write(`${decision.detail}\n`);

// 3. Carry it out.
let digest = decision.digest;
if (decision.push) {
  run('docker', [
    'buildx',
    'create',
    '--name',
    'qe-report-release',
    '--use',
    '--driver',
    'docker-container',
  ]);
  const metadataFile = join(ROOT, 'build', 'release', version, 'container-metadata.json');
  run('docker', [
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
    metadataFile,
    '--push',
    ROOT,
  ]);
  digest = JSON.parse(readFileSync(metadataFile, 'utf8'))['containerimage.digest'];
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    fail('the build did not report an image digest');
  }
  // What was just pushed has to claim what this release is, before any alias points at it.
  const pushedIdentity = identityOf(`${container.repository}@${digest}`);
  const wrong = Object.entries(expected).filter(([k, v]) => pushedIdentity[k] !== v);
  if (wrong.length > 0) {
    fail(
      `the image just pushed does not claim this release: ` +
        wrong
          .map(([k, v]) => `${k} is ${JSON.stringify(pushedIdentity[k])}, not ${JSON.stringify(v)}`)
          .join('; '),
    );
  }
  process.stdout.write(`pushed ${exact} at ${digest}\n`);
} else {
  process.stdout.write(`adopted the existing ${exact} at ${digest}\n`);
}

// 4. The moving aliases, repaired only where they do not already point at the canonical digest.
const resolved = {};
for (const alias of container.tags.filter((t) => t !== version)) {
  const seen = inspect(`${container.repository}:${alias}`);
  if (seen.state === UNKNOWN) {
    fail(`could not determine where ${container.repository}:${alias} points: ${seen.why}`);
  }
  resolved[alias] = seen.state === PRESENT ? seen.digest : undefined;
}
for (const alias of aliasesToRepair({ tags: container.tags, version, digest, resolved })) {
  run('docker', [
    'buildx',
    'imagetools',
    'create',
    '--tag',
    `${container.repository}:${alias}`,
    `${container.repository}@${digest}`,
  ]);
  process.stdout.write(`${container.repository}:${alias} -> ${digest}\n`);
}

// 5. Every tag resolves to the one digest. Checked, not assumed.
for (const tag of container.tags) {
  const seen = inspect(`${container.repository}:${tag}`);
  if (seen.state !== PRESENT || seen.digest !== digest) {
    fail(
      `${container.repository}:${tag} is ${seen.state}${seen.digest === undefined ? '' : ` at ${seen.digest}`}, not ${digest}`,
    );
  }
}

// Publication evidence, for the final manifest. It describes what is in the registry now.
const evidencePath = join(ROOT, 'build', 'release', version, 'container-evidence.json');
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      origin: 'published',
      repository: container.repository,
      digest,
      tags: container.tags,
      platforms: container.platforms,
      revision,
      adopted: decision.adopt === true,
    },
    null,
    2,
  )}\n`,
);
if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
}
process.stdout.write(
  `${container.tags.map((t) => `${container.repository}:${t}`).join(', ')} -> ${digest}\n`,
);
