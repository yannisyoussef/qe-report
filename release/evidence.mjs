/**
 * What counts as evidence that something was published, and what does not.
 *
 * The trap this exists to avoid: a rehearsal produces artefacts that look exactly like release
 * artefacts, and it is easy to carry one of them into a final manifest and describe it as published.
 * The clearest example is the Maven bundle. The rehearsal signs one with an ephemeral key; the real
 * release signs a different one with the production key and submits that. A manifest that recorded
 * the rehearsal bundle's digest under a field implying publication would be stating something
 * untrue, and nothing downstream could tell.
 *
 * So evidence is tagged with where it came from, and the final manifest accepts only the published
 * kind. Rehearsal evidence stays rehearsal evidence.
 *
 * Pure functions, tested in ordinary CI.
 */

/** Where a piece of evidence came from. A final manifest accepts only `published`. */
export const REHEARSAL = 'rehearsal';
export const PUBLISHED = 'published';

export const REFUSALS = {
  INTEGRITY_MISMATCH: 'what the registry serves is not what this release built',
  MISSING_INTEGRITY: 'no integrity was recorded for a package',
  NOT_PUBLISHED_EVIDENCE: 'rehearsal evidence was offered where published evidence is required',
  MISSING_ARTIFACT: 'a published artifact is absent',
  CONTENT_MISMATCH: 'a published artifact differs from the one this release built',
  NO_SIGNATURE: 'a published artifact has no signature beside it',
  CENTRAL_NOT_PUBLISHED: 'Central does not report this deployment as published',
};

/**
 * Compares what a registry serves against what this release built, for every package.
 *
 * Presence is not proof. A version that exists but whose integrity differs from the tarball this
 * release produced is a different package wearing the same name and number, and that is a hard
 * failure rather than something to reconcile.
 *
 * @param {Array<{name: string, version: string, integrity: string|null}>} recorded
 * @param {Record<string, {integrity?: string, hasProvenance?: boolean}>} registry
 */
export function compareNpmIntegrity(recorded, registry) {
  const problems = [];
  const checked = [];
  for (const entry of recorded) {
    const key = `${entry.name}@${entry.version}`;
    if (entry.integrity === null || entry.integrity === undefined || entry.integrity === '') {
      problems.push({ refusal: 'MISSING_INTEGRITY', detail: `${key} has no recorded integrity` });
      continue;
    }
    const served = registry[key];
    if (served === undefined || served.integrity === undefined) {
      problems.push({
        refusal: 'MISSING_ARTIFACT',
        detail: `${key} is not served by the registry`,
      });
      continue;
    }
    if (served.integrity !== entry.integrity) {
      problems.push({
        refusal: 'INTEGRITY_MISMATCH',
        detail:
          `${key} is served as ${served.integrity} but this release built ${entry.integrity}. ` +
          'A published version is immutable: do not replace it, and do not accept it.',
      });
      continue;
    }
    if (served.hasProvenance !== true) {
      problems.push({ refusal: 'NO_SIGNATURE', detail: `${key} has no provenance attestation` });
      continue;
    }
    checked.push(key);
  }
  return { ok: problems.length === 0, problems, checked };
}

/**
 * Compares the artifacts Central serves against the ones this release built from the tag.
 *
 * Only deterministic artifacts are compared by content. A jar whose bytes depend on when it was
 * built would fail this for no reason, which is why the Gradle archives are configured to be
 * reproducible; where a classifier is not deterministic the comparison records that instead of
 * pretending.
 *
 * "The same GAV exists" is explicitly not sufficient, which is the point of taking digests.
 *
 * @param {Array<{gav: string, classifiers: Record<string, string>}>} built
 *   per artifact, the sha256 of each file this release produced
 * @param {Record<string, {classifiers?: Record<string, string>, signatures?: string[]}>} central
 *   per GAV, what Central serves
 * @param {string[]} deterministic  which classifiers are compared by content
 */
export function compareCentralArtifacts(built, central, deterministic) {
  const problems = [];
  const checked = [];
  for (const artifact of built) {
    const served = central[artifact.gav];
    if (served === undefined) {
      problems.push({ refusal: 'MISSING_ARTIFACT', detail: `${artifact.gav} is not on Central` });
      continue;
    }
    for (const [classifier, sha256] of Object.entries(artifact.classifiers)) {
      if (!deterministic.includes(classifier)) continue;
      const servedSha = served.classifiers?.[classifier];
      if (servedSha === undefined) {
        problems.push({
          refusal: 'MISSING_ARTIFACT',
          detail: `${artifact.gav} has no ${classifier} on Central`,
        });
        continue;
      }
      if (servedSha !== sha256) {
        problems.push({
          refusal: 'CONTENT_MISMATCH',
          detail: `${artifact.gav} ${classifier} is ${servedSha} on Central but this release built ${sha256}`,
        });
        continue;
      }
      checked.push(`${artifact.gav} ${classifier}`);
    }
    // Central requires a signature beside every artifact, so an unsigned one is a broken release
    // even when its bytes are right.
    const signatures = served.signatures ?? [];
    for (const classifier of Object.keys(artifact.classifiers)) {
      if (!signatures.includes(classifier)) {
        problems.push({
          refusal: 'NO_SIGNATURE',
          detail: `${artifact.gav} ${classifier} has no .asc beside it`,
        });
      }
    }
  }
  return { ok: problems.length === 0, problems, checked };
}

/**
 * Whether a piece of evidence may go into the final manifest.
 *
 * The final manifest describes immutable registry facts. Evidence produced by a rehearsal describes
 * a rehearsal, however identical it looks, and is refused here rather than relabelled.
 */
export function acceptPublishedEvidence(evidence, what) {
  if (evidence === undefined || evidence === null) {
    return {
      ok: false,
      refusal: 'NOT_PUBLISHED_EVIDENCE',
      detail: `no published evidence was supplied for ${what}`,
    };
  }
  if (evidence.origin !== PUBLISHED) {
    return {
      ok: false,
      refusal: 'NOT_PUBLISHED_EVIDENCE',
      detail:
        `the evidence offered for ${what} came from ${JSON.stringify(evidence.origin)}, not a ` +
        'publication. A rehearsal artefact is not a published one, however alike they look.',
    };
  }
  return { ok: true, evidence };
}

/** Whether Central considers the deployment published, which an upload acceptance does not mean. */
export function acceptCentralState(state) {
  if (state !== 'PUBLISHED') {
    return {
      ok: false,
      refusal: 'CENTRAL_NOT_PUBLISHED',
      detail: `Central reports the deployment as ${JSON.stringify(state)}, not PUBLISHED`,
    };
  }
  return { ok: true };
}
