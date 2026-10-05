/**
 * Which commit a release may be cut from.
 *
 * The rule is exact: the tagged commit must be the current head of `master`. Not reachable from it,
 * not an ancestor of it, not a commit master later merged. Anything looser means a release could be
 * built from source that master has since moved past, and then two different trees would both claim
 * to be the release.
 *
 * It follows that a partially published release has to be finished before master advances to
 * another release commit. Resuming the same tag is how a partial release completes, and a resume
 * only works while that tag is still master's head.
 *
 * This is a pure function of facts a caller gathers from git, so that the decision is tested in
 * ordinary CI rather than only exercised during an irreversible release.
 */

/** Why a release reference was refused. One of these, never a free-text message. */
export const REFUSALS = {
  TAG_VERSION_MISMATCH: 'the tag does not name the version the release contract does',
  TAG_NOT_FOUND: 'the tag does not resolve to a commit',
  MASTER_NOT_FOUND: 'master could not be resolved',
  NOT_MASTER_HEAD: 'the tagged commit is not the current head of master',
};

/**
 * @param {object} facts
 * @param {string} facts.tag               the tag being released, for example `v1.0.0`
 * @param {string} facts.contractVersion   `productVersion` from release/release.json
 * @param {string|undefined} facts.tagCommit     what the tag resolves to
 * @param {string|undefined} facts.masterCommit  what `origin/master` resolves to
 * @param {boolean|undefined} facts.tagIsAncestorOfMaster
 *   whether the tagged commit is reachable from master. Not part of the decision: it is carried so
 *   a refusal can say which kind of wrong reference this is, which is the difference between "you
 *   tagged a feature branch" and "master has moved on since you tagged".
 */
export function decideReleaseRef(facts) {
  const { tag, contractVersion, tagCommit, masterCommit, tagIsAncestorOfMaster } = facts;

  const expectedTag = `v${contractVersion}`;
  if (tag !== expectedTag) {
    return {
      ok: false,
      refusal: 'TAG_VERSION_MISMATCH',
      detail: `the tag ${tag} does not match the release contract, which says ${expectedTag}`,
    };
  }
  if (tagCommit === undefined || tagCommit === '') {
    return { ok: false, refusal: 'TAG_NOT_FOUND', detail: `${tag} does not resolve to a commit` };
  }
  if (masterCommit === undefined || masterCommit === '') {
    return { ok: false, refusal: 'MASTER_NOT_FOUND', detail: 'master could not be resolved' };
  }
  if (tagCommit !== masterCommit) {
    // The two ways this happens read very differently to whoever has to fix it.
    const because =
      tagIsAncestorOfMaster === true
        ? `${tagCommit} is an older commit on master, whose head is now ${masterCommit}. ` +
          'A release is cut from the head of master. If this is a partial release being resumed, ' +
          'master has already advanced past it and the resume is no longer valid.'
        : `${tagCommit} is not on master, whose head is ${masterCommit}. ` +
          'A release is never published from develop, a feature branch, or an unreviewed commit.';
    return { ok: false, refusal: 'NOT_MASTER_HEAD', detail: because };
  }
  return { ok: true, version: contractVersion, commit: tagCommit };
}
