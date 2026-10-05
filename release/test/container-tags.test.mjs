import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ABSENT, PRESENT, UNKNOWN, aliasesToRepair, decideExactTag } from '../container-tags.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const expected = {
  version: '1.0.0',
  revision: 'c'.repeat(40),
  source: 'https://github.com/yannisyoussef/qe-report',
  platform: 'linux/amd64',
};

describe('what a release does about the exact container version tag', () => {
  it('pushes once when the exact tag does not exist', () => {
    const decision = decideExactTag({ state: ABSENT, expected });
    assert.equal(decision.ok, true);
    assert.equal(decision.push, true);
    assert.equal(decision.adopt, false);
  });

  it('adopts an existing tag whose identity is this release, and pushes nothing', () => {
    const decision = decideExactTag({
      state: PRESENT,
      digest,
      identity: { ...expected },
      expected,
    });
    assert.equal(decision.ok, true);
    assert.equal(decision.push, false, 'an existing exact tag must never be pushed over');
    assert.equal(decision.adopt, true);
    assert.equal(decision.digest, digest);
  });

  it('refuses an existing tag built from another revision, and pushes nothing', () => {
    const decision = decideExactTag({
      state: PRESENT,
      digest,
      identity: { ...expected, revision: 'd'.repeat(40) },
      expected,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.refusal, 'IDENTITY_MISMATCH');
    assert.equal(decision.push, false);
    assert.match(decision.detail, /never moved/u);
  });

  it('refuses an existing tag that disagrees on version, source or platform', () => {
    for (const field of ['version', 'source', 'platform']) {
      const decision = decideExactTag({
        state: PRESENT,
        digest,
        identity: { ...expected, [field]: 'something else' },
        expected,
      });
      assert.equal(decision.ok, false, field);
      assert.equal(decision.refusal, 'IDENTITY_MISMATCH', field);
      assert.equal(decision.push, false, field);
    }
  });

  it('aborts when the registry could not be asked, and never treats that as absent', () => {
    const decision = decideExactTag({ state: UNKNOWN, expected });
    assert.equal(decision.ok, false);
    assert.equal(decision.refusal, 'INSPECTION_FAILED');
    assert.equal(decision.push, false, 'an unanswered question must not lead to a push');
  });

  it('refuses a present tag whose digest cannot be read', () => {
    for (const bad of [undefined, '', 'sha256:short', 'not-a-digest']) {
      const decision = decideExactTag({
        state: PRESENT,
        digest: bad,
        identity: expected,
        expected,
      });
      assert.equal(decision.ok, false);
      assert.equal(decision.refusal, 'NO_DIGEST');
      assert.equal(decision.push, false);
    }
  });

  it('never pushes the exact tag in any outcome except a genuinely absent one', () => {
    const outcomes = [
      decideExactTag({ state: PRESENT, digest, identity: expected, expected }),
      decideExactTag({ state: PRESENT, digest, identity: { ...expected, version: '2' }, expected }),
      decideExactTag({ state: UNKNOWN, expected }),
      decideExactTag({ state: PRESENT, digest: undefined, identity: expected, expected }),
    ];
    for (const outcome of outcomes) assert.equal(outcome.push, false);
    assert.equal(decideExactTag({ state: ABSENT, expected }).push, true);
  });
});

describe('which aliases need repairing', () => {
  it('repairs only the moving aliases that do not already point at the canonical digest', () => {
    const toRepair = aliasesToRepair({
      tags: ['1.0.0', '1.0', '1'],
      version: '1.0.0',
      digest,
      resolved: { '1.0': digest, 1: `sha256:${'b'.repeat(64)}` },
    });
    assert.deepEqual(toRepair, ['1']);
  });

  it('never includes the exact version tag, which is not an alias', () => {
    const toRepair = aliasesToRepair({
      tags: ['1.0.0', '1.0', '1'],
      version: '1.0.0',
      digest,
      resolved: {},
    });
    assert.ok(!toRepair.includes('1.0.0'));
    assert.deepEqual(toRepair, ['1.0', '1']);
  });
});
