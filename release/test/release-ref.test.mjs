import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { decideReleaseRef } from '../release-ref.mjs';

/** The shape of a correct release: the contract's version, tagged at the head of master. */
const good = {
  tag: 'v1.0.0',
  contractVersion: '1.0.0',
  tagCommit: 'a'.repeat(40),
  masterCommit: 'a'.repeat(40),
  tagIsAncestorOfMaster: true,
};

describe('which commit a release may be cut from', () => {
  it('accepts the contract version tagged at the head of master', () => {
    const decision = decideReleaseRef(good);
    assert.deepEqual(decision, { ok: true, version: '1.0.0', commit: 'a'.repeat(40) });
  });

  it('refuses a tag that does not name the contract version', () => {
    for (const tag of ['v1.0.1', 'v0.9.0', '1.0.0', 'v1.0', 'release-1.0.0']) {
      const decision = decideReleaseRef({ ...good, tag });
      assert.equal(decision.ok, false, tag);
      assert.equal(decision.refusal, 'TAG_VERSION_MISMATCH', tag);
    }
  });

  it('refuses a commit that is not on master at all, such as one on develop or a feature branch', () => {
    const decision = decideReleaseRef({
      ...good,
      tagCommit: 'b'.repeat(40),
      masterCommit: 'a'.repeat(40),
      tagIsAncestorOfMaster: false,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.refusal, 'NOT_MASTER_HEAD');
    assert.match(decision.detail, /never published from develop/u);
  });

  it('refuses an older ancestor of master, which ancestry alone would have accepted', () => {
    // The gap this closes. The commit is genuinely on master and genuinely reachable from it; it is
    // simply not master's head any more, and a release built from it would not be what master says.
    const decision = decideReleaseRef({
      ...good,
      tagCommit: 'c'.repeat(40),
      masterCommit: 'd'.repeat(40),
      tagIsAncestorOfMaster: true,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.refusal, 'NOT_MASTER_HEAD');
    assert.match(decision.detail, /older commit on master/u);
    // And it says what that means for a resume, because that is the operational consequence.
    assert.match(decision.detail, /resume is no longer valid/u);
  });

  it('refuses a tag or a master that does not resolve', () => {
    assert.equal(decideReleaseRef({ ...good, tagCommit: undefined }).refusal, 'TAG_NOT_FOUND');
    assert.equal(decideReleaseRef({ ...good, tagCommit: '' }).refusal, 'TAG_NOT_FOUND');
    assert.equal(
      decideReleaseRef({ ...good, masterCommit: undefined }).refusal,
      'MASTER_NOT_FOUND',
    );
  });

  it('checks the version before anything about commits, so a wrong tag says so plainly', () => {
    const decision = decideReleaseRef({
      ...good,
      tag: 'v2.0.0',
      tagCommit: undefined,
      masterCommit: undefined,
    });
    assert.equal(decision.refusal, 'TAG_VERSION_MISMATCH');
  });
});
