#!/usr/bin/env node
/**
 * Publishes to Maven Central and emits evidence of what was actually published.
 *
 * Two things this is careful about.
 *
 * The bundle it submits is built here, in this job, signed with the production key. The rehearsal
 * built and signed a different one with an ephemeral key. They look identical and they are not the
 * same object, so the rehearsal's bundle digest is never carried into a field that implies
 * publication; the evidence this emits is tagged with where it came from and the final manifest
 * accepts only the published kind.
 *
 * And an accepted upload is not a publication. Central validates afterwards, so this polls until the
 * deployment is PUBLISHED, fails on FAILED, and then reads back what Central actually serves and
 * compares it with what was built from the tag. "The same GAV exists" is not proof that the right
 * bytes are there.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISHED, acceptCentralState, compareCentralArtifacts } from '../evidence.mjs';
import {
  gpgAvailable,
  importKey,
  openKeyring,
  signaturesMatchKey,
  verifyDetached,
} from '../signing.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, maven } = contract;
const PORTAL = 'https://central.sonatype.com';
const CENTRAL = 'https://repo1.maven.org/maven2';
const STAGING = join(ROOT, 'java', 'build', 'release-staging');
const OUT = join(ROOT, 'build', 'release', productVersion, 'maven');

/**
 * Which classifiers are compared by content. The archives are configured for reproducible order and
 * no build timestamps, so these are deterministic from the same source. Javadoc is excluded: it
 * embeds generation details that are not worth constraining, so its presence and signature are
 * checked but its bytes are not.
 */
const DETERMINISTIC = ['pom', 'jar', 'sources.jar'];
const ALL_CLASSIFIERS = [...DETERMINISTIC, 'javadoc.jar'];

const token = process.env.CENTRAL_TOKEN;
if (token === undefined || token === '') {
  process.stderr.write('no Central token: refusing to continue rather than skipping Central\n');
  process.exit(1);
}
const authorization = `Bearer ${token}`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const groupPath = maven.groupId.replaceAll('.', '/');
const fileName = (artifactId, classifier) =>
  classifier === 'pom'
    ? `${artifactId}-${productVersion}.pom`
    : `${artifactId}-${productVersion}-${classifier}`.replace('-jar', '.jar').replace('..', '.');

/** The file names Central serves for one artifact, by classifier. */
function servedNames(artifactId) {
  return {
    pom: `${artifactId}-${productVersion}.pom`,
    jar: `${artifactId}-${productVersion}.jar`,
    'sources.jar': `${artifactId}-${productVersion}-sources.jar`,
    'javadoc.jar': `${artifactId}-${productVersion}-javadoc.jar`,
  };
}
void fileName;

/** What this release built, from the staging repository the bundle was assembled from. */
function builtArtifacts() {
  return maven.public.map((artifactId) => {
    const directory = join(STAGING, ...maven.groupId.split('.'), artifactId, productVersion);
    const classifiers = {};
    for (const [classifier, name] of Object.entries(servedNames(artifactId))) {
      const path = join(directory, name);
      if (!existsSync(path))
        fail(`${name} was not staged; the bundle step should have produced it`);
      classifiers[classifier] = sha256(readFileSync(path));
    }
    return { gav: `${maven.groupId}:${artifactId}:${productVersion}`, artifactId, classifiers };
  });
}

/**
 * What Central serves right now, by GAV: the artifact bytes, and the signature bytes beside them.
 *
 * The signatures are downloaded rather than merely probed with HEAD, because the question is not
 * whether a `.asc` exists but whether it was made by the release key. Correct bytes signed by
 * somebody else is exactly the case a presence check cannot see.
 */
async function servedByCentral({ withBodies = false } = {}) {
  const served = {};
  for (const artifactId of maven.public) {
    const base = `${CENTRAL}/${groupPath}/${artifactId}/${productVersion}`;
    const classifiers = {};
    const signatures = [];
    const bodies = {};
    const signatureBodies = {};
    for (const [classifier, name] of Object.entries(servedNames(artifactId))) {
      const response = await fetch(`${base}/${name}`);
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        classifiers[classifier] = sha256(bytes);
        if (withBodies) bodies[classifier] = bytes;
      }
      const signature = await fetch(`${base}/${name}.asc`);
      if (signature.ok) {
        signatures.push(classifier);
        if (withBodies) signatureBodies[classifier] = Buffer.from(await signature.arrayBuffer());
      }
    }
    served[`${maven.groupId}:${artifactId}:${productVersion}`] = {
      classifiers,
      signatures,
      bodies,
      signatureBodies,
    };
  }
  return served;
}

/**
 * Verifies the signatures Central serves against the release key, in a keyring of its own.
 *
 * This is what binds the published artifacts to the key. Not that a `.asc` is present, and not a
 * fingerprint recorded alongside from the environment: that each published signature verifies, and
 * that the signer is the release key. Every classifier is checked, Javadoc included -- its bytes
 * are not constrained, but its signature is.
 *
 * The keyring holds the key only for the length of this function and is then removed. Only the
 * fingerprint, which is public, ever leaves.
 */
function verifyCentralSignatures(served) {
  const key = process.env.QE_REPORT_SIGNING_KEY;
  const refuse = (what, detail) => ({
    ok: false,
    problems: [{ what, detail }],
    checked: [],
    fingerprint: undefined,
  });
  if (key === undefined || key === '')
    return refuse('the release', 'no signing key to verify against');
  if (!gpgAvailable()) return refuse('the runner', 'no GPG to verify signatures with');

  const keyring = openKeyring();
  try {
    const expected = importKey(keyring, key).at(0);
    if (expected === undefined) return refuse('the release key', 'it has no fingerprint');
    const verifications = {};
    for (const [gav, artifact] of Object.entries(served)) {
      for (const classifier of ALL_CLASSIFIERS) {
        const body = artifact.bodies?.[classifier];
        const signature = artifact.signatureBodies?.[classifier];
        const what = `${gav} ${classifier}`;
        if (body === undefined || signature === undefined) {
          verifications[what] = {
            ok: false,
            detail: 'the artifact or its signature was not served',
          };
          continue;
        }
        const artifactPath = join(keyring.home, 'artifact');
        const signaturePath = join(keyring.home, 'artifact.asc');
        writeFileSync(artifactPath, body);
        writeFileSync(signaturePath, signature);
        verifications[what] = verifyDetached(keyring, signaturePath, artifactPath);
      }
    }
    return { ...signaturesMatchKey(verifications, expected), fingerprint: expected };
  } finally {
    keyring.close();
  }
}

const built = builtArtifacts();

// Already on Central? Then this is a resume, and the work is to verify rather than to upload.
const before = await servedByCentral();
const presentGavs = Object.entries(before).filter(([, a]) => a.classifiers.pom !== undefined);

let deployment;
if (presentGavs.length === maven.public.length) {
  process.stdout.write(
    `all ${maven.public.length} artifacts are already on Central at ${productVersion}\n`,
  );
} else if (presentGavs.length > 0) {
  // Central publishes a deployment as a unit, so a partial state is not something to guess at.
  fail(
    `Central has ${presentGavs.map(([gav]) => gav).join(', ')} but not the rest of this release. ` +
      'A deployment publishes as a unit; check the Publisher Portal before re-running.',
  );
} else {
  const bundle = join(OUT, `qe-report-${productVersion}-central-bundle.zip`);
  if (!existsSync(bundle)) fail(`${bundle} is missing; the bundle step should have produced it`);
  const bundleSha = sha256(readFileSync(bundle));

  const form = new FormData();
  form.append('bundle', new Blob([readFileSync(bundle)]), `qe-report-${productVersion}.zip`);
  const uploaded = await fetch(
    `${PORTAL}/api/v1/publisher/upload?name=qe-report-${productVersion}&publishingType=AUTOMATIC`,
    { method: 'POST', headers: { authorization }, body: form },
  );
  if (!uploaded.ok) fail(`Central refused the bundle: ${uploaded.status} ${await uploaded.text()}`);
  deployment = { id: (await uploaded.text()).trim(), bundleSha256: bundleSha };
  process.stdout.write(`Central accepted the bundle as deployment ${deployment.id}\n`);

  // An acceptance is the start of the work. Central validates afterwards.
  const deadline = Date.now() + 30 * 60 * 1000;
  let state = 'PENDING';
  while (Date.now() < deadline) {
    const status = await fetch(`${PORTAL}/api/v1/publisher/status?id=${deployment.id}`, {
      method: 'POST',
      headers: { authorization },
    });
    if (!status.ok) fail(`could not read the deployment state: ${status.status}`);
    const body = await status.json();
    state = body.deploymentState ?? 'UNKNOWN';
    if (state === 'PUBLISHED') break;
    if (state === 'FAILED') {
      fail(
        `deployment ${deployment.id} FAILED:\n${JSON.stringify(body.errors ?? body, null, 2)}\n` +
          'Repair the release configuration and resume from the same tag. Do not change the version.',
      );
    }
    process.stdout.write(`  ${state}\n`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  const accepted = acceptCentralState(state);
  if (!accepted.ok) fail(`${accepted.refusal}: ${accepted.detail}`);
  deployment.state = state;
  process.stdout.write(`deployment ${deployment.id} is PUBLISHED\n`);
}

// Whether this was an upload or a resume, the proof is the same: what Central serves has to be what
// this release built. Central's index can lag a successful publication, so give it a little time.
let served = await servedByCentral();
for (let attempt = 0; attempt < 20; attempt += 1) {
  const check = compareCentralArtifacts(built, served, DETERMINISTIC);
  if (check.ok) break;
  const onlyMissing = check.problems.every((p) => p.refusal === 'MISSING_ARTIFACT');
  if (!onlyMissing) break;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  served = await servedByCentral();
}
const verified = compareCentralArtifacts(built, served, DETERMINISTIC);
if (!verified.ok) {
  process.stderr.write('what Central serves is not what this release built:\n');
  for (const problem of verified.problems) {
    process.stderr.write(`  - ${problem.refusal}: ${problem.detail}\n`);
  }
  process.exit(1);
}
process.stdout.write(
  `${verified.checked.length} published artifacts match what this release built\n`,
);

// And every published signature was made by the release key. Bytes alone are not enough: correct
// artifacts signed by somebody else are not this release, and the same check runs on a resume.
const withBodies = await servedByCentral({ withBodies: true });
const signed = verifyCentralSignatures(withBodies);
if (!signed.ok) {
  process.stderr.write("the signatures Central serves are not the release key's:\n");
  for (const problem of signed.problems) {
    process.stderr.write(`  - ${problem.what}: ${problem.detail}\n`);
  }
  process.exit(1);
}
process.stdout.write(
  `${signed.checked.length} published signatures verify as ${signed.fingerprint.slice(-16)}\n`,
);

// The evidence the final manifest may use. It describes public artifacts, by their published
// digests, not the transport object they arrived in.
const evidence = {
  origin: PUBLISHED,
  repository: CENTRAL,
  state: 'PUBLISHED',
  artifacts: built.map((artifact) => ({
    gav: artifact.gav,
    published: Object.fromEntries(
      ALL_CLASSIFIERS.map((classifier) => [
        classifier,
        served[artifact.gav]?.classifiers?.[classifier] ?? null,
      ]),
    ),
    signatures: served[artifact.gav]?.signatures ?? [],
  })),
  // The public fingerprint only. No private material ever reaches an artifact.
  signingKey: { fingerprint: signed.fingerprint, verifiedSignatures: signed.checked.length },
  // Recorded only when this job actually submitted one, and named for what it is: the transport
  // object, not the published artifacts.
  uploadBundle:
    deployment === undefined
      ? null
      : { sha256: deployment.bundleSha256, deployment: deployment.id },
};
writeFileSync(
  join(ROOT, 'build', 'release', productVersion, 'maven-evidence.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
process.stdout.write('maven-evidence.json written\n');
