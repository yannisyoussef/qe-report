#!/usr/bin/env node
/**
 * Builds and validates the Maven Central bundle, without contacting Central.
 *
 * Central takes one zip in repository layout. Everything that can be wrong with it is cheaper to
 * find here than after an upload: a missing classifier, an unsigned file, a signature that does not
 * verify, a POM without the metadata Central requires, a snapshot version, a local path, or a
 * dependency on something that is not being published. A malformed bundle fails before any network
 * call, which is the whole point of assembling it separately rather than publishing from Gradle.
 *
 * Signing material never comes from the repository. A real release passes an armoured key through
 * the environment from the protected release environment. A rehearsal generates an ephemeral key in
 * a throwaway keyring, uses it, and throws it away, which proves the signing path works without any
 * production credential existing. Where no GPG is available at all the bundle's shape is still
 * validated and the signature checks are reported as not exercised, rather than quietly passing.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EPHEMERAL,
  SUPPLIED,
  decideSigningMode,
  generateKey,
  gpgAvailable,
  importKey,
  openKeyring,
  signaturesMatchKey,
  verifyDetached,
} from './signing.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
const { productVersion, maven, repository } = contract;
const JAVA = join(ROOT, 'java');
const STAGING = join(JAVA, 'build', 'release-staging');
const OUT = join(ROOT, 'build', 'release', productVersion, 'maven');

/** What Central needs for every artifact, beside the artifact itself. */
const REQUIRED_SUFFIXES = ['.asc', '.md5', '.sha1'];

function run(file, args, options = {}) {
  const finished = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  const output = `${finished.stdout ?? ''}${finished.stderr ?? ''}`;
  if (finished.error !== undefined) throw finished.error;
  if (finished.status !== 0) {
    const failure = new Error(`${file} exited ${finished.status}: ${output.slice(-600)}`);
    throw failure;
  }
  return output;
}

export function bundleMaven() {
  const problems = [];
  const decided = decideSigningMode(process.env, gpgAvailable());
  if (!decided.ok) throw new Error(decided.detail);

  // One keyring for the whole run, whichever mode this is. The release path used to verify against
  // the machine's default keyring, which has never seen the release key: a correctly signed
  // artifact would have failed there, or something else present would have passed for the wrong
  // reason.
  let keyring;
  let signingKey;
  let signingPassword = '';
  let expectedFingerprint;
  let signatureMode = decided.detail;

  if (decided.mode === SUPPLIED) {
    // The passphrase reaches the signer exactly as the release environment gave it. A protected key
    // is unusable otherwise, and that is a defect that only appears during a real release.
    signingPassword = decided.password;
    signingKey = decided.key;
    keyring = openKeyring(signingPassword);
    expectedFingerprint = importKey(keyring, signingKey).at(0);
    if (expectedFingerprint === undefined) {
      throw new Error('the supplied signing key has no fingerprint');
    }
    signatureMode = `the release key ${expectedFingerprint.slice(-16)}`;
  } else if (decided.mode === EPHEMERAL) {
    // A non-empty passphrase here too, so a rehearsal exercises the same path a protected
    // production key takes rather than an easier one.
    signingPassword = 'qe-report-rehearsal-passphrase';
    keyring = openKeyring(signingPassword);
    const generated = generateKey(
      keyring,
      'qe-report release rehearsal <rehearsal@qe-report.invalid>',
    );
    signingKey = generated.armoured;
    expectedFingerprint = generated.fingerprint;
    signatureMode = `an ephemeral key ${expectedFingerprint.slice(-16)}`;
  }

  try {
    // Restaged from scratch, with signing on if a key is available, so the tree matches the key.
    rmSync(STAGING, { recursive: true, force: true });
    run(join(JAVA, 'gradlew'), ['-p', JAVA, '--quiet', 'publishToReleaseStaging'], {
      env: {
        ...process.env,
        ...(signingKey === undefined ? {} : { QE_REPORT_SIGNING_KEY: signingKey }),
        // The real passphrase, unchanged. Never logged, and never an argument.
        QE_REPORT_SIGNING_PASSWORD: signingPassword,
      },
    });

    const groupPath = join(...maven.groupId.split('.'));
    const files = [];
    for (const artifactId of maven.public) {
      const directory = join(STAGING, groupPath, artifactId, productVersion);
      if (!existsSync(directory)) {
        problems.push(`${artifactId} was not staged`);
        continue;
      }
      const present = readdirSync(directory);
      // Central takes the main jar, the POM, sources and Javadoc; the Gradle module metadata comes
      // with them because a Gradle consumer resolves better with it.
      const expected = [
        `${artifactId}-${productVersion}.pom`,
        `${artifactId}-${productVersion}.jar`,
        `${artifactId}-${productVersion}-sources.jar`,
        `${artifactId}-${productVersion}-javadoc.jar`,
        `${artifactId}-${productVersion}.module`,
      ];
      for (const name of expected) {
        if (!present.includes(name)) {
          problems.push(`${artifactId} is missing ${name}`);
          continue;
        }
        files.push(join(groupPath, artifactId, productVersion, name));
        for (const suffix of REQUIRED_SUFFIXES) {
          if (suffix === '.asc' && keyring === undefined) continue;
          if (!present.includes(`${name}${suffix}`)) {
            problems.push(`${artifactId}/${name} has no ${suffix}`);
          } else {
            files.push(join(groupPath, artifactId, productVersion, `${name}${suffix}`));
          }
        }
      }
      // Nothing unpublishable, and nothing from a build machine.
      for (const name of present) {
        if (name.includes('-test-fixtures')) problems.push(`${artifactId} still publishes ${name}`);
        if (name.startsWith('maven-metadata')) {
          // Present in a staging repository, deliberately left out of the bundle.
          continue;
        }
      }

      const pom = readFileSync(join(directory, `${artifactId}-${productVersion}.pom`), 'utf8');
      for (const element of [
        '<name>',
        '<description>',
        '<url>',
        '<licenses>',
        '<developers>',
        '<scm>',
      ]) {
        if (!pom.includes(element)) problems.push(`${artifactId}'s POM has no ${element}`);
      }
      if (pom.includes('SNAPSHOT')) problems.push(`${artifactId}'s POM names a snapshot version`);
      if (!pom.includes(`<version>${productVersion}</version>`)) {
        problems.push(`${artifactId}'s POM is not version ${productVersion}`);
      }
      if (!pom.includes(repository.url))
        problems.push(`${artifactId}'s POM does not name the repository`);
      for (const leak of [
        /\/Users\/[a-z]/iu,
        /\/home\/runner\//u,
        /file:\/\//u,
        /\/private\/tmp\//u,
      ]) {
        const found = leak.exec(pom);
        if (found !== null) problems.push(`${artifactId}'s POM contains ${found[0]}`);
      }
      // Every qe-report dependency a POM declares must itself be part of this release.
      for (const [, id] of pom.matchAll(/<artifactId>(qe-report-[a-z-]+)<\/artifactId>/gu)) {
        if (id !== artifactId && !maven.public.includes(id)) {
          problems.push(`${artifactId} depends on ${id}, which this release does not publish`);
        }
      }
    }

    // Every signature, verified against the key that made it, in this run's own keyring, and
    // checked to have been made by that key rather than merely by something.
    let verified = 0;
    if (keyring !== undefined) {
      const verifications = {};
      for (const file of files.filter((f) => f.endsWith('.asc'))) {
        const signature = join(STAGING, file);
        verifications[file] = verifyDetached(keyring, signature, signature.replace(/\.asc$/u, ''));
      }
      const byTheRightKey = signaturesMatchKey(verifications, expectedFingerprint);
      verified = byTheRightKey.checked.length;
      for (const problem of byTheRightKey.problems) {
        problems.push(`${problem.what}: ${problem.detail}`);
      }
    }

    // The bundle itself: one zip, repository layout, nothing else in it.
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    const bundle = join(OUT, `qe-report-${productVersion}-central-bundle.zip`);
    // Built from the explicit file list rather than by adding the tree recursively, so what Central
    // receives is exactly what was checked above and nothing a staging repository happens to hold.
    writeFileSync(join(OUT, 'bundle-files.txt'), `${files.join('\n')}\n`);
    run('zip', ['-q', '-X', bundle, '-@'], {
      cwd: STAGING,
      input: files.join('\n'),
    });

    const zipped = run('unzip', ['-Z1', bundle])
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (zipped.length !== files.length) {
      problems.push(`the bundle holds ${zipped.length} files, not the ${files.length} expected`);
    }
    for (const entry of zipped) {
      if (entry.startsWith('maven-metadata') || entry.includes('/maven-metadata')) {
        problems.push(`the bundle contains ${entry}, which Central does not take`);
      }
    }

    return {
      problems,
      signatureMode,
      signingFingerprint: expectedFingerprint,
      signaturesVerified: verified,
      files: files.length,
      bundle: relative(ROOT, bundle),
      bytes: statSync(bundle).size,
      artifacts: maven.public.map((a) => `${maven.groupId}:${a}:${productVersion}`),
    };
  } finally {
    // The keyring, the key inside it and the passphrase file all go, whatever happened, in both
    // modes. Nothing of the signing key survives this function.
    keyring?.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = bundleMaven();
  process.stdout.write(
    `Central bundle: ${result.files} files, ${result.bytes} bytes, signing by ${result.signatureMode}` +
      `${result.signaturesVerified > 0 ? `, ${result.signaturesVerified} signatures verified` : ''}\n`,
  );
  for (const gav of result.artifacts) process.stdout.write(`  ${gav}\n`);
  if (result.signingFingerprint === undefined) {
    process.stdout.write(
      'no GPG on this machine: the bundle shape was validated and signatures were not exercised\n',
    );
  }
  if (result.problems.length > 0) {
    process.stderr.write('\nthe Central bundle is not ready:\n');
    for (const problem of result.problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`${result.bundle}\n`);
}
