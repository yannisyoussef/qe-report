import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  BOOTSTRAP,
  MINIMUM_NPM_FOR_TRUSTED_PUBLISHING,
  TRUSTED_PUBLISHING,
  atLeast,
  decideNpmAuth,
} from '../npm-auth.mjs';

const oidc = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/...',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'an-oidc-request-token',
};
const SECRET = 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('how the release authenticates to npm', () => {
  it('uses a bootstrap token when one is supplied', () => {
    const decided = decideNpmAuth({ NODE_AUTH_TOKEN: SECRET }, '12.1.0');
    assert.equal(decided.ok, true);
    assert.equal(decided.mode, BOOTSTRAP);
    // And says what to do with it afterwards, because the documentation promises that.
    assert.match(decided.detail, /remove it/u);
  });

  it('uses trusted publishing when there is no token but there is an OIDC identity', () => {
    const decided = decideNpmAuth({ ...oidc }, '12.1.0');
    assert.equal(decided.ok, true);
    assert.equal(decided.mode, TRUSTED_PUBLISHING);
    assert.match(decided.detail, /no long-lived token/u);
  });

  it('fails closed with neither a token nor an OIDC identity', () => {
    const decided = decideNpmAuth({}, '12.1.0');
    assert.equal(decided.ok, false);
    assert.equal(decided.refusal, 'NO_CREDENTIAL');
    assert.match(decided.detail, /not guessing/u);
  });

  it('fails closed on a half-present OIDC environment rather than trying anyway', () => {
    for (const partial of [
      { ACTIONS_ID_TOKEN_REQUEST_URL: oidc.ACTIONS_ID_TOKEN_REQUEST_URL },
      { ACTIONS_ID_TOKEN_REQUEST_TOKEN: oidc.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
      { ...oidc, ACTIONS_ID_TOKEN_REQUEST_URL: '' },
    ]) {
      const decided = decideNpmAuth(partial, '12.1.0');
      assert.equal(decided.ok, false, JSON.stringify(Object.keys(partial)));
      assert.equal(decided.refusal, 'NO_CREDENTIAL');
    }
  });

  it('refuses trusted publishing on an npm that cannot do it', () => {
    const decided = decideNpmAuth({ ...oidc }, '10.9.8');
    assert.equal(decided.ok, false);
    assert.equal(decided.refusal, 'NPM_TOO_OLD');
    assert.match(
      decided.detail,
      new RegExp(MINIMUM_NPM_FOR_TRUSTED_PUBLISHING.replace(/\./gu, '\\.'), 'u'),
    );
  });

  it('refuses when the npm version is unknown, rather than hoping', () => {
    assert.equal(decideNpmAuth({ ...oidc }, undefined).refusal, 'NO_NPM');
    assert.equal(decideNpmAuth({ ...oidc }, '').refusal, 'NO_NPM');
  });

  it('never puts the token in anything it returns', () => {
    // A decision is logged; a credential must not travel inside one.
    const decided = decideNpmAuth({ NODE_AUTH_TOKEN: SECRET, NPM_TOKEN: SECRET }, '12.1.0');
    assert.ok(!JSON.stringify(decided).includes(SECRET));
    const refused = decideNpmAuth({}, '12.1.0');
    assert.ok(!JSON.stringify(refused).includes(SECRET));
  });

  it('does not treat an old npm as a reason to fall back to a token that is not there', () => {
    const decided = decideNpmAuth({ ...oidc }, '9.0.0');
    assert.notEqual(decided.mode, BOOTSTRAP);
    assert.equal(decided.ok, false);
  });
});

describe('comparing npm versions', () => {
  it('orders versions without a dependency to do it', () => {
    assert.equal(atLeast('11.5.1', '11.5.1'), true);
    assert.equal(atLeast('12.0.0', '11.5.1'), true);
    assert.equal(atLeast('11.6.0', '11.5.1'), true);
    assert.equal(atLeast('11.5.0', '11.5.1'), false);
    assert.equal(atLeast('10.9.8', '11.5.1'), false);
    assert.equal(atLeast('11.5', '11.5.1'), false);
    assert.equal(atLeast('not a version', '11.5.1'), false);
    assert.equal(atLeast(undefined, '11.5.1'), false);
  });
});
