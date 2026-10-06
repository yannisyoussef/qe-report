#!/usr/bin/env node
/**
 * Exercises the branch a real release takes: a supplied, passphrase-protected signing key.
 *
 * The rehearsal's own mode generates a key internally, which is useful but is not the code path a
 * release uses. This one generates a throwaway key with a non-empty passphrase, exports it, and
 * hands it to the bundle exactly as the protected release environment would -- so the production
 * branch runs in ordinary CI, with no production credential in existence.
 *
 * It then mutates the bundle to drop the passphrase and requires that to fail, because the defect
 * being guarded against was precisely a hard-coded empty one: everything passed until a real
 * protected key arrived.
 *
 * Needs GPG. Without it the signing branches cannot run at all, and that is reported rather than
 * quietly passed over.
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // The release branch: a supplied key, with its own passphrase. Signing is forced to re-run in
  // both calls below, because otherwise Gradle reuses signatures it already made and neither the
  // real run nor the mutant would be exercising the signing path at all. That is exactly how the
  // first version of this proof passed while checking nothing.
  const supplied = {
    QE_REPORT_SIGNING_KEY: key.armoured,
    QE_REPORT_SIGNING_PASSWORD: PASSPHRASE,
    QE_REPORT_RESIGN_FROM_SCRATCH: '1',
  };
  const { bundleMaven } = await import('./bundle-maven.mjs');
  const before = { ...process.env };
  Object.assign(process.env, supplied);
  let result;
  try {
    result = bundleMaven();
  } finally {
    for (const name of Object.keys(supplied)) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }

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
    `${result.signaturesVerified} signatures verified against ${result.signingFingerprint?.slice(-16)} ` +
      "in a keyring of this run's own\n",
  );

  // The mutation: hard-code the passphrase away, as it was, and require that to fail.
  mutant = join(RELEASE, 'bundle-maven.passphrase-mutant.mjs');
  const source = readFileSync(join(RELEASE, 'bundle-maven.mjs'), 'utf8');
  const target = 'QE_REPORT_SIGNING_PASSWORD: signingPassword,';
  if (source.split(target).length - 1 !== 1) {
    problems.push('the passphrase is no longer passed where this proof expects it');
  } else {
    writeFileSync(mutant, source.replace(target, "QE_REPORT_SIGNING_PASSWORD: '',"));
    Object.assign(process.env, supplied);
    let mutantFailed = false;
    let mutantResult;
    try {
      const loaded = await import(pathToFileURL(mutant).href);
      mutantResult = loaded.bundleMaven();
    } catch {
      mutantFailed = true;
    } finally {
      for (const name of Object.keys(supplied)) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
    const mutantRefused = mutantFailed || (mutantResult?.problems.length ?? 0) > 0;
    if (!mutantRefused) {
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
void copyFileSync;
