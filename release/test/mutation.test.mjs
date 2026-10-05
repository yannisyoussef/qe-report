import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Proof that the guards are load-bearing.
 *
 * A test that passes tells you the code does something. It does not tell you the code would have
 * failed had the guard been removed, and a guard nothing depends on is a comment. So each case here
 * takes the real module, removes exactly one guard, loads the result, and asserts the mutant now
 * does the forbidden thing. If a mutation stops changing the outcome, the guard it targets has
 * become unreachable or the condition has moved, and this fails.
 *
 * The modules under test import nothing, so a mutated copy in a temporary directory is the same
 * code with one line altered and nothing else.
 */
const RELEASE = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'qe-mutation-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let serial = 0;
/** The module with one substitution applied, loaded as its own module. */
async function mutate(file, from, to) {
  const source = readFileSync(join(RELEASE, file), 'utf8');
  const occurrences = source.split(from).length - 1;
  assert.equal(
    occurrences,
    1,
    `the mutation target ${JSON.stringify(from)} appears ${occurrences} times in ${file}; ` +
      'the guard has moved and this proof no longer targets it',
  );
  serial += 1;
  const path = join(scratch, `${serial}-${file}`);
  writeFileSync(path, source.replace(from, to));
  return import(pathToFileURL(path).href);
}

describe('removing the master-head guard', () => {
  const olderAncestor = {
    tag: 'v1.0.0',
    contractVersion: '1.0.0',
    tagCommit: 'c'.repeat(40),
    masterCommit: 'd'.repeat(40),
    tagIsAncestorOfMaster: true,
  };

  it('is what makes an older ancestor of master releasable again', async () => {
    const { decideReleaseRef } = await import('../release-ref.mjs');
    assert.equal(decideReleaseRef(olderAncestor).ok, false, 'the real module must refuse this');

    // The exact mistake the gate had: accept anything reachable from master.
    const mutant = await mutate(
      'release-ref.mjs',
      'if (tagCommit !== masterCommit) {',
      'if (tagCommit !== masterCommit && tagIsAncestorOfMaster !== true) {',
    );
    assert.equal(
      mutant.decideReleaseRef(olderAncestor).ok,
      true,
      'the mutant should accept it, which is what the real guard is preventing',
    );
  });
});

describe('removing the inspect-before-push guard', () => {
  const expected = { version: '1.0.0', revision: 'c'.repeat(40), source: 's', platform: 'p' };

  it('is what lets a release push over an existing exact tag', async () => {
    const real = await import('../container-tags.mjs');
    const present = {
      state: real.PRESENT,
      digest: `sha256:${'a'.repeat(64)}`,
      identity: { ...expected },
      expected,
    };
    assert.equal(real.decideExactTag(present).push, false, 'the real module must not push');

    const mutant = await mutate(
      'container-tags.mjs',
      'if (state === ABSENT) {',
      'if (state === ABSENT || state === PRESENT) {',
    );
    assert.equal(
      mutant.decideExactTag(present).push,
      true,
      'the mutant should push over an existing tag, which the real guard prevents',
    );
  });

  it('is what makes an unanswered registry look absent', async () => {
    const real = await import('../container-tags.mjs');
    assert.equal(real.decideExactTag({ state: real.UNKNOWN, expected }).push, false);

    // The original defect, modelled exactly: the inspection returned one value for "not found" and
    // for "could not ask", so a registry failure read as an absent tag and the release pushed.
    const mutant = await mutate(
      'container-tags.mjs',
      '  const { state, digest, identity, expected } = facts;',
      '  const { digest, identity, expected } = facts;\n' +
        '  const state = facts.state === UNKNOWN ? ABSENT : facts.state;',
    );
    assert.equal(
      mutant.decideExactTag({ state: 'unknown', expected }).push,
      true,
      'collapsing unknown into absent should make the release push, which the real guard prevents',
    );
  });
});

describe('removing the npm integrity comparison', () => {
  const recorded = [{ name: 'qe-report-protocol', version: '1.0.0', integrity: 'sha512-built' }];
  const registry = {
    'qe-report-protocol@1.0.0': { integrity: 'sha512-SOMETHINGELSE', hasProvenance: true },
  };

  it('is what lets a different tarball pass as the release', async () => {
    const { compareNpmIntegrity } = await import('../evidence.mjs');
    assert.equal(compareNpmIntegrity(recorded, registry).ok, false, 'the real module must refuse');

    const mutant = await mutate(
      'evidence.mjs',
      'if (served.integrity !== entry.integrity) {',
      'if (false) {',
    );
    assert.equal(
      mutant.compareNpmIntegrity(recorded, registry).ok,
      true,
      'the mutant should accept a mismatching package, which the real comparison prevents',
    );
  });
});

describe('removing the published-evidence guard', () => {
  it('is what lets rehearsal evidence into the final manifest', async () => {
    const real = await import('../evidence.mjs');
    const rehearsal = { origin: real.REHEARSAL, digest: 'from the ephemeral key' };
    assert.equal(real.acceptPublishedEvidence(rehearsal, 'maven').ok, false);

    const mutant = await mutate(
      'evidence.mjs',
      'if (evidence.origin !== PUBLISHED) {',
      'if (false) {',
    );
    assert.equal(
      mutant.acceptPublishedEvidence(rehearsal, 'maven').ok,
      true,
      'the mutant should accept a rehearsal bundle as published, which the real guard prevents',
    );
  });
});

describe('removing the Central content comparison', () => {
  it('is what makes "the GAV exists" look like proof', async () => {
    const built = [{ gav: 'g:a:1.0.0', classifiers: { pom: 'built' } }];
    const central = { 'g:a:1.0.0': { classifiers: { pom: 'DIFFERENT' }, signatures: ['pom'] } };
    const { compareCentralArtifacts } = await import('../evidence.mjs');
    assert.equal(compareCentralArtifacts(built, central, ['pom']).ok, false);

    const mutant = await mutate('evidence.mjs', 'if (servedSha !== sha256) {', 'if (false) {');
    assert.equal(
      mutant.compareCentralArtifacts(built, central, ['pom']).ok,
      true,
      'the mutant should accept differing content, which the real comparison prevents',
    );
  });
});
