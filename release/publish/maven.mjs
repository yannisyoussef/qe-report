#!/usr/bin/env node
/**
 * Uploads the validated bundle to the Maven Central Publisher Portal and waits for it to publish.
 *
 * The bundle was assembled and checked before this ran, so nothing here inspects artifacts: this is
 * transport. It targets the current Publisher Portal rather than the retired OSSRH staging API, and
 * it treats the upload's own 201 as the start of the work rather than the end of it: a deployment
 * that Central later marks FAILED is a failed release.
 *
 * Resuming: if a deployment for this version is already PUBLISHED, there is nothing to do.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, maven } = contract;
const PORTAL = 'https://central.sonatype.com';
const token = process.env.CENTRAL_TOKEN;

if (token === undefined || token === '') {
  process.stderr.write('no Central token: refusing to continue rather than skipping Central\n');
  process.exit(1);
}
const authorization = `Bearer ${token}`;

/** Whether Central already serves this coordinate, which is what "published" means to a consumer. */
async function alreadyOnCentral(artifactId) {
  const path = `${maven.groupId.replaceAll('.', '/')}/${artifactId}/${productVersion}/${artifactId}-${productVersion}.pom`;
  const response = await fetch(`https://repo1.maven.org/maven2/${path}`, { method: 'HEAD' });
  return response.ok;
}

const present = [];
for (const artifactId of maven.public) {
  if (await alreadyOnCentral(artifactId)) present.push(artifactId);
}
if (present.length === maven.public.length) {
  process.stdout.write(
    `all ${maven.public.length} artifacts are already on Central at ${productVersion}\n`,
  );
  process.exit(0);
}
if (present.length > 0) {
  // Central publishes a deployment as a unit, so a partial state means a deployment is mid-flight
  // or something went wrong. Either way it is not this script's to guess at.
  process.stderr.write(
    `Central already has ${present.join(', ')} but not the rest of this release.\n` +
      'A deployment publishes as a unit; check the Publisher Portal before re-running.\n',
  );
  process.exit(1);
}

const bundle = join(
  ROOT,
  'build',
  'release',
  productVersion,
  'maven',
  `qe-report-${productVersion}-central-bundle.zip`,
);
if (!existsSync(bundle)) {
  process.stderr.write(`${bundle} is missing; the bundle step should have produced it\n`);
  process.exit(1);
}

const form = new FormData();
form.append('bundle', new Blob([readFileSync(bundle)]), `qe-report-${productVersion}.zip`);
const uploaded = await fetch(
  // AUTOMATIC: a person has already approved this environment, and every local validation passed.
  `${PORTAL}/api/v1/publisher/upload?name=qe-report-${productVersion}&publishingType=AUTOMATIC`,
  { method: 'POST', headers: { authorization }, body: form },
);
if (!uploaded.ok) {
  process.stderr.write(`Central refused the bundle: ${uploaded.status} ${await uploaded.text()}\n`);
  process.exit(1);
}
const deployment = (await uploaded.text()).trim();
process.stdout.write(`Central accepted the bundle as deployment ${deployment}\n`);

// A 201 means Central has the bundle, not that it published it. Validation happens afterwards.
const deadline = Date.now() + 30 * 60 * 1000;
let state = 'PENDING';
while (Date.now() < deadline) {
  const status = await fetch(`${PORTAL}/api/v1/publisher/status?id=${deployment}`, {
    method: 'POST',
    headers: { authorization },
  });
  if (!status.ok) {
    process.stderr.write(`could not read the deployment state: ${status.status}\n`);
    process.exit(1);
  }
  const body = await status.json();
  state = body.deploymentState ?? 'UNKNOWN';
  if (state === 'PUBLISHED') {
    process.stdout.write(`deployment ${deployment} is PUBLISHED\n`);
    process.exit(0);
  }
  if (state === 'FAILED') {
    // The errors, not the credential. Central's validation messages are safe to show; the token is
    // never echoed anywhere in this script.
    process.stderr.write(
      `deployment ${deployment} FAILED:\n${JSON.stringify(body.errors ?? body, null, 2)}\n` +
        'Repair the release configuration and resume from the same tag. Do not change the version.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`  ${state}\n`);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
process.stderr.write(
  `deployment ${deployment} was still ${state} after 30 minutes; check the Portal\n`,
);
process.exit(1);
