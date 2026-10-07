import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Properties of the publishing scripts that are about order, not about values.
 *
 * "Inspect the registry before pushing" cannot be checked by calling a function: it is a claim about
 * the shape of the program. So it is checked by reading the program. These are crude assertions, and
 * they are still worth more than the comment that used to carry the same claim, because the defect
 * they guard against was exactly an ordering mistake that every unit test passed around.
 */
const PUBLISH = join(dirname(fileURLToPath(import.meta.url)), '..', 'publish');
const read = (file) => readFileSync(join(PUBLISH, file), 'utf8');

describe('the container publisher', () => {
  const source = read('container.mjs');

  it('decides from an inspection before anything can be pushed', () => {
    const decision = source.indexOf('decideExactTag({');
    const push = source.indexOf("'--push'");
    assert.notEqual(decision, -1, 'it must use the tested decision');
    assert.notEqual(push, -1);
    assert.ok(decision < push, 'the decision must come before any push in the program');
  });

  it('pushes only inside the branch the decision permits', () => {
    // The one `--push` in the file, and it is inside `if (decision.push)`.
    assert.equal(source.split("'--push'").length - 1, 1, 'there must be exactly one push');
    const branch = source.indexOf('if (decision.push) {');
    assert.notEqual(branch, -1, 'the push must be guarded by the decision');
    assert.ok(branch < source.indexOf("'--push'"));
  });

  it('never tags the exact version except in that one push', () => {
    // `imagetools create` writes a tag. Every one of them must be an alias, never the exact tag.
    const creates = [...source.matchAll(/imagetools',\s*\n\s*'create'/gu)];
    assert.ok(creates.length >= 1);
    for (const create of creates) {
      const after = source.slice(create.index, create.index + 400);
      assert.match(after, /\$\{alias\}/u, 'imagetools create must only ever write an alias tag');
    }
  });

  it('treats an unknown inspection as fatal rather than as absent', () => {
    assert.match(source, /state === UNKNOWN/u);
    assert.match(source, /fail\(/u);
  });
});

describe('the npm publisher', () => {
  const source = read('npm.mjs');

  it('compares the registry integrity against the built tarball before publishing', () => {
    const compare = source.indexOf('integrity');
    const publish = source.indexOf("'publish'");
    assert.notEqual(compare, -1);
    assert.notEqual(publish, -1);
    assert.ok(compare < publish, 'the integrity comparison must precede the publish');
  });

  it('refuses rather than republishing when an existing version differs', () => {
    assert.match(source, /immutable/u);
    assert.match(source, /process\.exit\(1\)/u);
  });
});

describe('the release reference check', () => {
  const source = readFileSync(join(PUBLISH, '..', 'check-release-ref.mjs'), 'utf8');

  it('stops when master could not be fetched, rather than trusting a stale ref', () => {
    // The fetch used to go through a helper whose result was discarded, so a failed refresh left
    // the check validating against whatever this checkout happened to be holding while reporting
    // that the value was fresh.
    const fetched = source.indexOf("git(['fetch'");
    assert.notEqual(fetched, -1, 'it must fetch master explicitly');
    const after = source.slice(fetched, fetched + 600);
    assert.match(after, /fetched === undefined/u, 'the fetch result must be checked');
    assert.match(after, /process\.exit\(1\)/u, 'a failed fetch must stop the check');
    assert.ok(
      source.indexOf('decideReleaseRef({') > fetched,
      'the decision must come after the fetch is known to have succeeded',
    );
  });

  it('hands the decision to the tested module rather than deciding in shell', () => {
    assert.match(source, /import \{ decideReleaseRef \} from '\.\/release-ref\.mjs'/u);
  });
});

describe('the bundle builder', () => {
  const source = readFileSync(join(PUBLISH, '..', 'bundle-maven.mjs'), 'utf8');

  it('passes the supplied passphrase through to the signer unchanged', () => {
    // The defect this guards: a hard-coded empty passphrase, which makes every protected
    // production key unusable and which nothing noticed until a real release.
    assert.match(source, /QE_REPORT_SIGNING_PASSWORD: signingPassword/u);
    assert.ok(
      !/QE_REPORT_SIGNING_PASSWORD: ''/u.test(source),
      'the passphrase must never be replaced with an empty one',
    );
  });

  it('verifies in a keyring of its own in both modes, never the machine default', () => {
    assert.match(source, /openKeyring\(/u);
    assert.ok(!/GNUPGHOME/u.test(source), 'it must not reach for an inherited GPG home');
    assert.match(source, /keyring\?\.close\(\)/u, 'the keyring must be closed in a finally');
  });

  it('requires signatures to have been made by the expected key', () => {
    assert.match(source, /signaturesMatchKey/u);
    assert.match(source, /signingFingerprint/u);
  });
});

describe('the Maven publisher', () => {
  const source = read('maven.mjs');

  it('does not accept an upload acceptance as publication', () => {
    assert.match(source, /PUBLISHED/u);
    assert.match(source, /FAILED/u);
  });

  it('emits publication evidence rather than reusing the rehearsal bundle', () => {
    // Tagged with the shared constant, so the final manifest's check and this producer cannot
    // drift apart on what "published" means.
    assert.match(source, /import \{[^}]*PUBLISHED[^}]*\} from '\.\.\/evidence\.mjs'/su);
    assert.match(source, /origin: PUBLISHED/u);
  });

  it('reads back what Central serves and compares it, rather than trusting the GAV exists', () => {
    assert.match(source, /compareCentralArtifacts/u);
    const upload = source.indexOf('publisher/upload');
    const compare = source.lastIndexOf('compareCentralArtifacts');
    assert.ok(compare > upload, 'the comparison must come after the upload');
  });

  it('records an upload bundle digest only when this job submitted one', () => {
    assert.match(source, /uploadBundle/u);
    // Formatting-independent: the field is conditional on this job having submitted a bundle,
    // however the line happens to be wrapped.
    const condition = source.slice(source.indexOf('uploadBundle'));
    assert.match(condition, /deployment === undefined/u);
    assert.match(condition.replace(/\s+/gu, ' '), /deployment === undefined \? null/u);
  });
});
