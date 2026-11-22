const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sessionTokenFromRequest,
  currentSessionUser,
  legacyBearerEnabled,
} = require('../src/session-auth');

const reqWith = (cookie, authorization) => ({
  headers: {
    ...(cookie ? { cookie } : {}),
    ...(authorization ? { authorization } : {}),
  },
});

test('cookie token authenticates first-party requests; bearer is ignored by default', () => {
  assert.equal(legacyBearerEnabled({}), false);
  assert.equal(legacyBearerEnabled({ ALLOW_LEGACY_BEARER_SESSION: '1' }), true);

  const req = reqWith('thq_session=cookie-token; other=x', 'Bearer legacy-token');
  assert.equal(sessionTokenFromRequest(req), 'cookie-token');
  assert.equal(sessionTokenFromRequest(req, { env: { ALLOW_LEGACY_BEARER_SESSION: '1' } }), 'cookie-token');
  assert.equal(sessionTokenFromRequest(reqWith('', 'Bearer legacy-token')), '');
  assert.equal(sessionTokenFromRequest(reqWith('', 'Bearer legacy-token'), { env: { ALLOW_LEGACY_BEARER_SESSION: '1' } }), 'legacy-token');
  assert.equal(sessionTokenFromRequest(reqWith('tp_session=portal-token', ''), { cookieName: 'tp_session' }), 'portal-token');
});

test('currentSessionUser looks up the cookie token and returns nothing without a session', async () => {
  const seen = [];
  const user = { id: 'u1', name: 'A' };
  const sql = async (strings, ...values) => {
    seen.push({ text: strings.join('?'), values });
    return values[0] === 'cookie-token' ? [user] : [];
  };

  assert.deepEqual(await currentSessionUser(sql, reqWith('thq_session=cookie-token')), user);
  assert.match(seen[0].text, /s\.token = \?/);
  assert.match(seen[0].text, /s\.expires > \?/);
  assert.equal(seen[0].values[0], 'cookie-token');

  assert.equal(await currentSessionUser(sql, reqWith('')), null);
  assert.equal(seen.length, 1);
});
