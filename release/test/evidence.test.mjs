import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  PUBLISHED,
  REHEARSAL,
  acceptCentralState,
  acceptPublishedEvidence,
  compareCentralArtifacts,
  compareNpmIntegrity,
} from '../evidence.mjs';

const integrity = (c) => `sha512-${c.repeat(10)}`;

describe('what the registry serves against what the release built, for npm', () => {
  const recorded = [
    { name: 'qe-report-protocol', version: '1.0.0', integrity: integrity('a') },
    { name: 'qe-report-sdk', version: '1.0.0', integrity: integrity('b') },
  ];

  it('accepts packages whose integrity matches and which carry provenance', () => {
    const result = compareNpmIntegrity(recorded, {
      'qe-report-protocol@1.0.0': { integrity: integrity('a'), hasProvenance: true },
      'qe-report-sdk@1.0.0': { integrity: integrity('b'), hasProvenance: true },
    });
    assert.equal(result.ok, true);
    assert.equal(result.checked.length, 2);
  });

  it('refuses a package whose integrity differs, even though the version exists', () => {
    // Presence is not proof: this is a different tarball wearing the same name and number.
    const result = compareNpmIntegrity(recorded, {
      'qe-report-protocol@1.0.0': { integrity: integrity('z'), hasProvenance: true },
      'qe-report-sdk@1.0.0': { integrity: integrity('b'), hasProvenance: true },
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].refusal, 'INTEGRITY_MISMATCH');
    assert.match(result.problems[0].detail, /do not replace it, and do not accept it/u);
  });

  it('refuses a package that exists and matches but has no provenance', () => {
    const result = compareNpmIntegrity(recorded, {
      'qe-report-protocol@1.0.0': { integrity: integrity('a'), hasProvenance: false },
      'qe-report-sdk@1.0.0': { integrity: integrity('b'), hasProvenance: true },
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].refusal, 'NO_SIGNATURE');
  });

  it('refuses a missing package, and a release that recorded no integrity to compare', () => {
    assert.equal(compareNpmIntegrity(recorded, {}).problems[0].refusal, 'MISSING_ARTIFACT');
    const unrecorded = [{ name: 'qe-report-protocol', version: '1.0.0', integrity: null }];
    assert.equal(compareNpmIntegrity(unrecorded, {}).problems[0].refusal, 'MISSING_INTEGRITY');
  });
});

describe('what Central serves against what the release built', () => {
  const built = [
    {
      gav: 'io.github.yannisyoussef:qe-report-protocol:1.0.0',
      classifiers: { pom: 'p1', jar: 'j1', 'sources.jar': 's1', 'javadoc.jar': 'd1' },
    },
  ];
  const deterministic = ['pom', 'jar', 'sources.jar'];
  const signatures = ['pom', 'jar', 'sources.jar', 'javadoc.jar'];

  it('accepts artifacts whose deterministic content matches and which are signed', () => {
    const result = compareCentralArtifacts(
      built,
      {
        'io.github.yannisyoussef:qe-report-protocol:1.0.0': {
          classifiers: { pom: 'p1', jar: 'j1', 'sources.jar': 's1', 'javadoc.jar': 'anything' },
          signatures,
        },
      },
      deterministic,
    );
    assert.equal(result.ok, true);
    // Javadoc is not compared by content, so a difference there is not a failure.
    assert.ok(!result.checked.some((c) => c.includes('javadoc')));
  });

  it('refuses when the GAV exists but its content differs', () => {
    const result = compareCentralArtifacts(
      built,
      {
        'io.github.yannisyoussef:qe-report-protocol:1.0.0': {
          classifiers: { pom: 'p1', jar: 'DIFFERENT', 'sources.jar': 's1' },
          signatures,
        },
      },
      deterministic,
    );
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].refusal, 'CONTENT_MISMATCH');
  });

  it('refuses an artifact with no signature beside it', () => {
    const result = compareCentralArtifacts(
      built,
      {
        'io.github.yannisyoussef:qe-report-protocol:1.0.0': {
          classifiers: { pom: 'p1', jar: 'j1', 'sources.jar': 's1' },
          signatures: ['pom'],
        },
      },
      deterministic,
    );
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.refusal === 'NO_SIGNATURE'));
  });

  it('treats a present GAV with nothing else known as insufficient', () => {
    const result = compareCentralArtifacts(
      built,
      { 'io.github.yannisyoussef:qe-report-protocol:1.0.0': {} },
      deterministic,
    );
    assert.equal(result.ok, false);
  });
});

describe('which evidence may enter the final manifest', () => {
  it('accepts evidence produced by a publication', () => {
    const accepted = acceptPublishedEvidence({ origin: PUBLISHED, digest: 'x' }, 'maven');
    assert.equal(accepted.ok, true);
  });

  it('refuses rehearsal evidence, which is the trap this exists for', () => {
    // The rehearsal signs a bundle with an ephemeral key. It looks exactly like the real one.
    const refused = acceptPublishedEvidence({ origin: REHEARSAL, digest: 'x' }, 'maven');
    assert.equal(refused.ok, false);
    assert.equal(refused.refusal, 'NOT_PUBLISHED_EVIDENCE');
    assert.match(refused.detail, /however alike they look/u);
  });

  it('refuses absent or untagged evidence rather than assuming it is published', () => {
    assert.equal(acceptPublishedEvidence(undefined, 'maven').ok, false);
    assert.equal(acceptPublishedEvidence({ digest: 'x' }, 'maven').ok, false);
  });

  it('accepts only PUBLISHED from Central, not an accepted upload', () => {
    assert.equal(acceptCentralState('PUBLISHED').ok, true);
    for (const state of ['PENDING', 'VALIDATING', 'VALIDATED', 'FAILED', undefined]) {
      assert.equal(acceptCentralState(state).ok, false, String(state));
    }
  });
});
