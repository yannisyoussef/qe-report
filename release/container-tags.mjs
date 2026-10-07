/**
 * What to do about the container tags of a release, decided before anything is pushed.
 *
 * An exact version tag is immutable once it exists. The dangerous shape is to push it and then
 * compare digests, because by the time the comparison fails the tag has already moved: the check
 * would report a violation it had itself committed. So the exact tag is inspected first, and the
 * decision about whether to push is made from that inspection alone.
 *
 * Inspection has three outcomes, not two. A registry that says "not found" is different from a
 * registry that could not be reached, and treating the second as the first is how an immutable tag
 * gets overwritten during an outage. An ambiguous failure aborts.
 *
 * On resume, an existing exact tag is canonical once its release identity has been verified. It is
 * deliberately not required to be byte-identical to a fresh rebuild: BuildKit records provenance
 * and an SBOM into the image, so rebuilding the same source can legitimately produce a different
 * digest, and demanding equality would turn a correct resume into a failure. What must match is the
 * identity the image claims: the product version, the commit, the source repository, the platform.
 *
 * Pure functions of facts a caller gathers, so the algorithm is tested in ordinary CI rather than
 * only during an irreversible release.
 */

/** How an inspection of a tag turned out. Three outcomes, because two would be a bug. */
export const PRESENT = 'present';
export const ABSENT = 'absent';
export const UNKNOWN = 'unknown';

export const REFUSALS = {
  INSPECTION_FAILED: 'the registry could not be asked whether the exact tag exists',
  IDENTITY_MISMATCH: 'the exact tag exists but is not this release',
  NO_DIGEST: 'the exact tag exists but its digest could not be read',
};

/**
 * What the release should do about the exact version tag.
 *
 * @param {object} facts
 * @param {string} facts.state   PRESENT, ABSENT or UNKNOWN
 * @param {string|undefined} facts.digest    the digest the exact tag resolves to, when present
 * @param {object|undefined} facts.identity  what the existing image claims about itself
 * @param {object} facts.expected            what this release requires it to claim
 */
export function decideExactTag(facts) {
  const { state, digest, identity, expected } = facts;

  if (state === UNKNOWN) {
    // Never "probably absent". An outage must not be able to move an immutable tag.
    return {
      ok: false,
      refusal: 'INSPECTION_FAILED',
      push: false,
      detail:
        'the registry did not answer whether the exact version tag exists. Refusing to build or ' +
        'push: an unanswered question is not an absent tag, and an exact version tag is immutable.',
    };
  }

  if (state === ABSENT) {
    return { ok: true, push: true, adopt: false, detail: 'the exact tag does not exist yet' };
  }

  // Present. Nothing is pushed to the exact tag from here on, whatever else is decided.
  if (digest === undefined || digest === '' || !/^sha256:[0-9a-f]{64}$/u.test(digest ?? '')) {
    return {
      ok: false,
      refusal: 'NO_DIGEST',
      push: false,
      detail: 'the exact tag exists but no digest could be read for it',
    };
  }

  const mismatches = [];
  for (const [field, wanted] of Object.entries(expected)) {
    const claimed = identity?.[field];
    if (claimed !== wanted) {
      mismatches.push(`${field} is ${JSON.stringify(claimed)}, not ${JSON.stringify(wanted)}`);
    }
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      refusal: 'IDENTITY_MISMATCH',
      push: false,
      detail:
        `the exact tag already exists at ${digest} but is not this release: ${mismatches.join('; ')}. ` +
        'An exact version tag is never moved. Release the correction as a new version.',
    };
  }

  return {
    ok: true,
    push: false,
    adopt: true,
    digest,
    detail: `the exact tag already exists at ${digest} and is this release; adopting it`,
  };
}

/**
 * Which moving aliases need pointing at the canonical digest. Aliases may be repaired; the exact
 * version tag is never in this list, because it is not an alias.
 */
export function aliasesToRepair({ tags, version, digest, resolved }) {
  const aliases = tags.filter((tag) => tag !== version);
  return aliases.filter((alias) => resolved[alias] !== digest);
}
