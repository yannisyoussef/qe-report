/**
 * PGP signing and verification, always in a keyring of its own.
 *
 * Two things this exists to get right.
 *
 * A production key usually has a passphrase, so the passphrase has to reach the signer unchanged.
 * Hard-coding an empty one makes every protected key unusable, which is a defect that only shows up
 * during a real release, when it is most expensive.
 *
 * And verification needs the public half of whichever key did the signing. Falling back to the
 * machine's default keyring verifies nothing in a release: the runner has never seen that key, so
 * `gpg --verify` would fail on a correctly signed artifact, or -- worse, if some other key happened
 * to be present -- succeed for the wrong reason. Every operation here gets a temporary GNUPGHOME,
 * the key is imported there, and the directory is removed afterwards.
 *
 * No passphrase is ever passed in argv, which every user on the machine can read; it goes through a
 * file inside the temporary home, which dies with it. Nothing here writes key material into a
 * release artifact: the only thing that leaves is a fingerprint, which is public by design.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SUPPLIED = 'supplied';
export const EPHEMERAL = 'ephemeral';
export const NONE = 'none';

/**
 * Which signing mode applies, from the environment alone.
 *
 * A supplied key is the release path: it comes from the protected environment with its own
 * passphrase, which is used exactly as given. An ephemeral key is the rehearsal path, which proves
 * the signing machinery works without any production credential existing. Neither is possible
 * without GPG, and that is reported rather than silently skipped.
 *
 * Pure, so the choice is tested rather than inferred from a successful release.
 */
export function decideSigningMode(env, gpgAvailable) {
  const key = env.QE_REPORT_SIGNING_KEY;
  const password = env.QE_REPORT_SIGNING_PASSWORD;
  if (typeof key === 'string' && key !== '') {
    if (!gpgAvailable) {
      return {
        mode: NONE,
        ok: false,
        detail: 'a signing key was supplied but GPG is not available to verify what it signs',
      };
    }
    return {
      mode: SUPPLIED,
      ok: true,
      key,
      // Unchanged, including when it is absent: an absent passphrase and an empty one are the same
      // thing to GPG, and a wrong one must fail rather than be guessed at.
      password: password ?? '',
      detail: 'the release key from the environment',
    };
  }
  if (!gpgAvailable) {
    return { mode: NONE, ok: true, detail: 'no signing key and no GPG: signatures not exercised' };
  }
  return { mode: EPHEMERAL, ok: true, detail: 'an ephemeral key generated for this run' };
}

function gpg(home, args, options = {}) {
  const finished = spawnSync('gpg', ['--batch', '--yes', '--homedir', home, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  const output = `${finished.stdout ?? ''}${finished.stderr ?? ''}`;
  return { status: finished.status, stdout: finished.stdout ?? '', output };
}

/** A keyring of its own, with the passphrase on disk inside it rather than in any argument list. */
export function openKeyring(passphrase = '') {
  const home = mkdtempSync(join(tmpdir(), 'qe-gnupg-'));
  chmodSync(home, 0o700);
  const passphraseFile = join(home, 'passphrase');
  writeFileSync(passphraseFile, passphrase, { mode: 0o600 });
  return {
    home,
    passphraseFile,
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** A key that exists only for this run, with whatever passphrase the caller asked for. */
export function generateKey(keyring, identity) {
  const generated = gpg(keyring.home, [
    '--pinentry-mode',
    'loopback',
    '--passphrase-file',
    keyring.passphraseFile,
    '--quick-generate-key',
    identity,
    'rsa3072',
    'sign',
    '1d',
  ]);
  if (generated.status !== 0) {
    throw new Error(`a throwaway key could not be generated: ${generated.output.slice(-400)}`);
  }
  const fingerprint = fingerprints(keyring).at(0);
  if (fingerprint === undefined) throw new Error('the generated key has no fingerprint');
  const exported = gpg(keyring.home, [
    '--pinentry-mode',
    'loopback',
    '--passphrase-file',
    keyring.passphraseFile,
    '--armor',
    '--export-secret-keys',
    fingerprint,
  ]);
  if (exported.status !== 0 || !exported.stdout.includes('BEGIN PGP PRIVATE KEY BLOCK')) {
    throw new Error('the generated key could not be exported');
  }
  return { fingerprint, armoured: exported.stdout };
}

/** Every secret key the keyring holds, by fingerprint. */
export function fingerprints(keyring) {
  const listed = gpg(keyring.home, ['--with-colons', '--list-secret-keys']);
  return listed.stdout
    .split('\n')
    .filter((l) => l.startsWith('fpr:'))
    .map((l) => l.split(':')[9])
    .filter((f) => typeof f === 'string' && f.length === 40);
}

/**
 * Imports a key for verification into this keyring and nothing else.
 *
 * Importing a secret key brings its public half with it, which is what verification needs. The
 * passphrase is not required to import, so none is given here.
 */
export function importKey(keyring, armoured) {
  const imported = gpg(keyring.home, ['--import'], { input: armoured });
  if (imported.status !== 0) {
    throw new Error(
      `the signing key could not be imported for verification: ${imported.output.slice(-300)}`,
    );
  }
  const found = fingerprints(keyring);
  // A public-only key does not appear in --list-secret-keys, so fall back to the public listing.
  if (found.length > 0) return found;
  const listed = gpg(keyring.home, ['--with-colons', '--list-keys']);
  return listed.stdout
    .split('\n')
    .filter((l) => l.startsWith('fpr:'))
    .map((l) => l.split(':')[9])
    .filter((f) => typeof f === 'string' && f.length === 40);
}

/**
 * Verifies one detached signature and reports who made it.
 *
 * The signer comes from GPG's own status output rather than from a human-readable message, and a
 * caller that cares which key signed compares that fingerprint itself. Returning "it verified"
 * without saying by whom is how a correctly signed artifact signed by the wrong key passes.
 */
export function verifyDetached(keyring, signaturePath, signedPath) {
  const verified = gpg(keyring.home, ['--status-fd', '1', '--verify', signaturePath, signedPath]);
  const validsig = /\[GNUPG:\] VALIDSIG ([0-9A-F]{40})/u.exec(verified.stdout);
  if (verified.status !== 0 || validsig === null) {
    return {
      ok: false,
      detail: verified.output
        .split('\n')
        .filter((l) => !l.startsWith('[GNUPG:]'))
        .slice(-3)
        .join(' ')
        .trim(),
    };
  }
  return { ok: true, fingerprint: validsig[1] };
}

/**
 * Whether a set of verified signatures was all made by the expected key.
 *
 * Separated from the verification itself so the comparison is tested without GPG: an artifact whose
 * bytes are right and whose signature verifies against some other key must fail, and that is a
 * decision rather than a cryptographic operation.
 */
export function signaturesMatchKey(verifications, expectedFingerprint) {
  const problems = [];
  const checked = [];
  if (typeof expectedFingerprint !== 'string' || expectedFingerprint.length !== 40) {
    return {
      ok: false,
      problems: [{ what: 'the release', detail: 'no expected signing fingerprint is known' }],
      checked,
    };
  }
  for (const [what, verification] of Object.entries(verifications)) {
    if (verification.ok !== true) {
      problems.push({ what, detail: `the signature did not verify: ${verification.detail ?? ''}` });
      continue;
    }
    if (verification.fingerprint !== expectedFingerprint) {
      problems.push({
        what,
        detail:
          `signed by ${verification.fingerprint}, not the release key ${expectedFingerprint}. ` +
          'Correct bytes signed by another key is not this release.',
      });
      continue;
    }
    checked.push(what);
  }
  return { ok: problems.length === 0, problems, checked };
}

/** Whether GPG is usable at all. */
export function gpgAvailable() {
  const finished = spawnSync('gpg', ['--version'], { encoding: 'utf8' });
  return finished.error === undefined && finished.status === 0;
}
