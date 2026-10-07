#!/usr/bin/env node
/**
 * Exercises the branch a real release takes: a supplied, passphrase-protected signing key.
 *
 * The rehearsal's own mode generates a key internally, which is useful but is not the code path a
 * release uses. This one generates a throwaway key with a non-empty passphrase and hands it to the
 * bundle exactly as the protected release environment would, so the production branch runs in
 * ordinary CI with no production credential in existence.
 *
 * It runs the bundle twice. First with the passphrase removed, which must fail, because the defect
 * being guarded against was a hard-coded empty one: everything passed until a real protected key
 * arrived. Then with the passphrase, which must succeed.
 *
 * That order is deliberate. Each run empties the staging repository before rebuilding it, so a
 * failing run leaves no staged artifacts behind; doing the mutation last would hand the next
 * rehearsal step an empty directory. The successful run goes last so the state it leaves is the
 * state everything after it expects.
 *
 * Needs GPG. Without it neither signing branch can run, and that is reported as not exercised
 * rather than quietly passed over.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKey, gpgAvailable, openKeyring } from './signing.mjs';

const RELEASE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(RELEASE, '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'release', 'release.json'), 'utf8'));
/** One signature per published file: three artifacts, five files each. */
const EXPECTED_SIGNATURES = contract.maven.public.length * 5;
const PASSPHRASE = 'a passphrase a production key would have';
/** Exit code for "this could not be exercised here", which the rehearsal renders as skipped. */
const NOT_EXERCISED = 3;

if (!gpgAvailable()) {
  process.stdout.write('no GPG on this machine, so neither signing branch can run. CI has one.\n');
  process.exit(NOT_EXERCISED);
}

const problems = [];
const keyring = openKeyring(PASSPHRASE);
let mutant;
try {
  const key = generateKey(keyring, 'qe-report signing regression <regression@qe-report.invalid>');
  process.stdout.write(
    `generated a throwaway key ${key.fingerprint.slice(-16)} with a passphrase\n`,
  );

  // Signing is forced to re-run in both calls. Emptying the staging repository makes Gradle
  // re-publish but not re-sign, so without this the mutant would reuse signatures made moments
  // earlier with the correct passphrase and prove nothing. That is how the first version of this
  // proof passed while checking nothing.
  const environment = {
    QE_REPORT_SIGNING_KEY: key.armoured,
    QE_REPORT_SIGNING_PASSWORD: PASSPHRASE,
    QE_REPORT_RESIGN_FROM_SCRATCH: '1',
  };
  const before = { ...process.env };
  const withEnvironment = (work) => {
    Object.assign(process.env, environment);
    try {
      return work();
    } finally {
      for (const name of Object.keys(environment)) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
  };

  // 1. The mutation: hard-code the passphrase away, as it was, and require that to fail.
  mutant = join(RELEASE, 'bundle-maven.passphrase-mutant.mjs');
  const source = readFileSync(join(RELEASE, 'bundle-maven.mjs'), 'utf8');
  const target = 'QE_REPORT_SIGNING_PASSWORD: signingPassword,';
  if (source.split(target).length - 1 !== 1) {
    problems.push('the passphrase is no longer passed where this proof expects it');
  } else {
    writeFileSync(mutant, source.replace(target, "QE_REPORT_SIGNING_PASSWORD: '',"));
    let refused = false;
    let mutantResult;
    try {
      const loaded = await import(pathToFileURL(mutant).href);
      mutantResult = withEnvironment(() => loaded.bundleMaven());
    } catch {
      refused = true;
    }
    if (!refused && (mutantResult?.problems.length ?? 0) > 0) refused = true;
    if (!refused) {
      problems.push(
        'dropping the passphrase still produced a valid signed bundle, so passing it through is ' +
          'not what makes a protected key work and this proof is checking nothing',
      );
    } else {
      process.stdout.write(
        'dropping the passphrase breaks signing, as it must: the passthrough is load-bearing\n',
      );
    }
  }

  // 2. The release branch, last, so the staging repository and bundle it leaves behind are the
  //    valid ones every later step reads.
  const { bundleMaven } = await import('./bundle-maven.mjs');
  const result = withEnvironment(() => bundleMaven());

  if (result.problems.length > 0) {
    problems.push(`the bundle reported problems: ${result.problems.join('; ')}`);
  }
  if (!/the release key/u.test(result.signatureMode)) {
    problems.push(`the supplied-key branch did not run: mode was ${result.signatureMode}`);
  }
  if (result.signingFingerprint !== key.fingerprint) {
    problems.push(
      `the signer was ${result.signingFingerprint}, not the generated key ${key.fingerprint}`,
    );
  }
  if (result.signaturesVerified !== EXPECTED_SIGNATURES) {
    problems.push(
      `${result.signaturesVerified} signatures verified, expected ${EXPECTED_SIGNATURES}`,
    );
  }
  process.stdout.write(
    `${result.signaturesVerified} signatures verified against ` +
      `${result.signingFingerprint?.slice(-16)} in a keyring of this run's own\n`,
  );
} finally {
  keyring.close();
  if (mutant !== undefined) rmSync(mutant, { force: true });
}

if (problems.length > 0) {
  process.stderr.write('\nthe production signing branch is not sound:\n');
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}
process.stdout.write('the supplied passphrase-protected key signs, verifies, and is required\n');
