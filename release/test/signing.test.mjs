import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  EPHEMERAL,
  NONE,
  SUPPLIED,
  decideSigningMode,
  fingerprints,
  generateKey,
  gpgAvailable,
  importKey,
  openKeyring,
  signaturesMatchKey,
  verifyDetached,
} from '../signing.mjs';

const haveGpg = gpgAvailable();
/** The crypto cases need GPG. Where there is none they are skipped by name, never passed over. */
const crypto = haveGpg ? it : it.skip;

describe('which signing mode applies', () => {
  it('uses a supplied key when the environment has one, with its passphrase unchanged', () => {
    const decided = decideSigningMode(
      { QE_REPORT_SIGNING_KEY: 'ARMOURED', QE_REPORT_SIGNING_PASSWORD: 'a real passphrase' },
      true,
    );
    assert.equal(decided.mode, SUPPLIED);
    assert.equal(decided.ok, true);
    // The whole point: the passphrase is carried through, not replaced with an empty one.
    assert.equal(decided.password, 'a real passphrase');
  });

  it('carries an absent passphrase as empty rather than inventing one', () => {
    const decided = decideSigningMode({ QE_REPORT_SIGNING_KEY: 'ARMOURED' }, true);
    assert.equal(decided.mode, SUPPLIED);
    assert.equal(decided.password, '');
  });

  it('generates an ephemeral key when no key is supplied', () => {
    assert.equal(decideSigningMode({}, true).mode, EPHEMERAL);
    assert.equal(decideSigningMode({ QE_REPORT_SIGNING_KEY: '' }, true).mode, EPHEMERAL);
  });

  it('fails closed when a key is supplied but nothing could verify what it signs', () => {
    const decided = decideSigningMode({ QE_REPORT_SIGNING_KEY: 'ARMOURED' }, false);
    assert.equal(decided.ok, false);
    assert.equal(decided.mode, NONE);
  });

  it('reports, rather than fails, when there is neither a key nor GPG', () => {
    const decided = decideSigningMode({}, false);
    assert.equal(decided.mode, NONE);
    assert.equal(decided.ok, true);
  });
});

describe('whether signatures were made by the release key', () => {
  const key = 'A'.repeat(40);
  const other = 'B'.repeat(40);

  it('accepts signatures made by the expected key', () => {
    const result = signaturesMatchKey(
      { 'a.jar.asc': { ok: true, fingerprint: key }, 'a.pom.asc': { ok: true, fingerprint: key } },
      key,
    );
    assert.equal(result.ok, true);
    assert.equal(result.checked.length, 2);
  });

  it('refuses a signature that verifies but was made by another key', () => {
    // Correct bytes signed by the wrong key is the case a presence check cannot see.
    const result = signaturesMatchKey({ 'a.jar.asc': { ok: true, fingerprint: other } }, key);
    assert.equal(result.ok, false);
    assert.match(result.problems[0].detail, /not this release/u);
  });

  it('refuses a signature that did not verify at all', () => {
    const result = signaturesMatchKey({ 'a.jar.asc': { ok: false, detail: 'bad' } }, key);
    assert.equal(result.ok, false);
    assert.match(result.problems[0].detail, /did not verify/u);
  });

  it('refuses when no expected fingerprint is known, rather than accepting anything', () => {
    assert.equal(
      signaturesMatchKey({ 'a.asc': { ok: true, fingerprint: key } }, undefined).ok,
      false,
    );
    assert.equal(
      signaturesMatchKey({ 'a.asc': { ok: true, fingerprint: key } }, 'short').ok,
      false,
    );
  });
});

describe('a keyring of its own', () => {
  crypto('generates a passphrase-protected key, exports it, and reports its fingerprint', () => {
    const keyring = openKeyring('a non-empty passphrase');
    try {
      const generated = generateKey(keyring, 'qe-report test <test@qe-report.invalid>');
      assert.match(generated.fingerprint, /^[0-9A-F]{40}$/u);
      assert.match(generated.armoured, /BEGIN PGP PRIVATE KEY BLOCK/u);
      assert.deepEqual(fingerprints(keyring), [generated.fingerprint]);
    } finally {
      keyring.close();
    }
  });

  crypto('verifies a signature in a second keyring that only imported the key', () => {
    const signer = openKeyring('another non-empty passphrase');
    let verifier;
    try {
      const generated = generateKey(signer, 'qe-report test <test@qe-report.invalid>');
      const subject = join(signer.home, 'artifact.txt');
      writeFileSync(subject, 'the bytes to sign\n');
      // Signed by the first keyring, using the passphrase it was created with.
      const signed = signWith(signer, subject);

      // A fresh keyring that has never seen this key, as a release runner has not.
      verifier = openKeyring();
      const before = verifyDetached(verifier, signed, subject);
      assert.equal(before.ok, false, 'a keyring without the key must not verify its signatures');

      const imported = importKey(verifier, generated.armoured);
      assert.deepEqual(imported, [generated.fingerprint]);
      const after = verifyDetached(verifier, signed, subject);
      assert.equal(after.ok, true);
      assert.equal(after.fingerprint, generated.fingerprint);
      assert.equal(
        signaturesMatchKey({ 'artifact.txt.asc': after }, generated.fingerprint).ok,
        true,
      );
    } finally {
      signer.close();
      verifier?.close();
    }
  });

  crypto('removes the keyring and the passphrase file when it closes', () => {
    const keyring = openKeyring('a non-empty passphrase');
    generateKey(keyring, 'qe-report test <test@qe-report.invalid>');
    assert.ok(existsSync(keyring.home));
    assert.ok(existsSync(keyring.passphraseFile));
    keyring.close();
    assert.ok(!existsSync(keyring.home), 'the keyring directory must be gone');
    assert.ok(!existsSync(keyring.passphraseFile), 'the passphrase must not outlive the keyring');
  });

  crypto('keeps the passphrase out of every argument list', () => {
    // Read from the module rather than observed, because an argument list is not something a test
    // can watch: what matters is that no gpg invocation here takes --passphrase with a value.
    const source = readFileSync(new URL('../signing.mjs', import.meta.url), 'utf8');
    assert.ok(!/'--passphrase',/u.test(source), 'a passphrase must never be an argument');
    assert.match(source, /--passphrase-file/u);
  });
});

/** Signs a file with the keyring's own key, the way a signer would. */
function signWith(keyring, path) {
  const finished = spawnSync(
    'gpg',
    [
      '--batch',
      '--yes',
      '--homedir',
      keyring.home,
      '--pinentry-mode',
      'loopback',
      '--passphrase-file',
      keyring.passphraseFile,
      '--armor',
      '--detach-sign',
      path,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(finished.status, 0, `signing failed: ${finished.stderr}`);
  return `${path}.asc`;
}
