/**
 * How the release authenticates to npm.
 *
 * The documentation has always described two eras: a first publication that may need a bootstrap
 * credential, and trusted publishing as the steady state once the package exists and a publisher is
 * configured. The workflow required a token on every release, so the steady state it described
 * could never actually be reached.
 *
 * Both are supported here, and the choice is made from the environment rather than guessed:
 *
 *   BOOTSTRAP           a token is present, and is used for this publication only.
 *   TRUSTED_PUBLISHING  no token, and the workflow has an OIDC identity npm can verify.
 *
 * There is deliberately no third option. A release with neither fails closed rather than falling
 * back to an anonymous attempt or to whatever credential happens to be lying around on the runner,
 * because a publication that succeeds for a reason nobody chose is worse than one that stops.
 *
 * Trusted publishing needs an npm new enough to perform it, so the required minimum is stated and
 * checked rather than inherited from whatever the Node image ships.
 *
 * Pure, so the decision is tested in ordinary CI without contacting npm.
 */

export const BOOTSTRAP = 'bootstrap';
export const TRUSTED_PUBLISHING = 'trusted-publishing';

/** The npm that first supported trusted publishing from a workflow. */
export const MINIMUM_NPM_FOR_TRUSTED_PUBLISHING = '11.5.1';

export const REFUSALS = {
  NO_CREDENTIAL: 'neither a token nor a usable OIDC identity is available',
  NPM_TOO_OLD: 'this npm cannot perform trusted publishing',
  NO_NPM: 'no npm version was established',
};

/** Compares dotted versions without pulling in a dependency to do it. */
export function atLeast(version, minimum) {
  if (typeof version !== 'string') return false;
  const parse = (v) => v.split('.').map((part) => Number.parseInt(part, 10));
  const actual = parse(version);
  const wanted = parse(minimum);
  if (actual.some(Number.isNaN)) return false;
  for (let i = 0; i < wanted.length; i += 1) {
    const a = actual[i] ?? 0;
    const w = wanted[i] ?? 0;
    if (a > w) return true;
    if (a < w) return false;
  }
  return true;
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string|undefined} npmVersion  the npm this job will actually run
 */
export function decideNpmAuth(env, npmVersion) {
  const token = env.NODE_AUTH_TOKEN ?? env.NPM_TOKEN;
  if (typeof token === 'string' && token !== '') {
    // Bootstrap. The token is used as narrowly as npm allows, and the documentation says to remove
    // it once trusted publishing is configured; this path existing is what makes that possible.
    return {
      ok: true,
      mode: BOOTSTRAP,
      detail:
        'publishing with a bootstrap token. Once the packages exist and a trusted publisher is ' +
        'configured, remove it: the next release will authenticate without one.',
    };
  }

  // No token. Trusted publishing needs an OIDC identity the workflow can exchange, and GitHub only
  // provides one when the job asked for `id-token: write`.
  const hasOidc =
    typeof env.ACTIONS_ID_TOKEN_REQUEST_URL === 'string' &&
    env.ACTIONS_ID_TOKEN_REQUEST_URL !== '' &&
    typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' &&
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== '';
  if (!hasOidc) {
    return {
      ok: false,
      refusal: 'NO_CREDENTIAL',
      detail:
        'no npm token, and no OIDC identity to publish with. Either configure a trusted publisher ' +
        'for these packages and grant the job `id-token: write`, or supply a bootstrap token. This ' +
        'release is not guessing at a credential.',
    };
  }
  if (npmVersion === undefined || npmVersion === '') {
    return { ok: false, refusal: 'NO_NPM', detail: 'the npm version could not be established' };
  }
  if (!atLeast(npmVersion, MINIMUM_NPM_FOR_TRUSTED_PUBLISHING)) {
    return {
      ok: false,
      refusal: 'NPM_TOO_OLD',
      detail:
        `npm ${npmVersion} cannot perform trusted publishing; ` +
        `${MINIMUM_NPM_FOR_TRUSTED_PUBLISHING} or newer is required. The release job pins this ` +
        'rather than inheriting whatever the Node image ships.',
    };
  }
  return {
    ok: true,
    mode: TRUSTED_PUBLISHING,
    detail: `publishing through trusted publishing with npm ${npmVersion}; no long-lived token`,
  };
}
