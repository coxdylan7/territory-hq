const test = require('node:test');
const assert = require('node:assert/strict');
const {
  allowedOrigins, hasSessionCookie, isAllowedMutation, requestOrigin, csrfMiddleware,
} = require('../src/csrf');

const env = {
  PUBLIC_ORIGIN: 'https://hq.example.com',
  FIRST_PARTY_ORIGINS: 'https://portal.example.com',
  ALLOWED_ORIGINS: 'https://third-party-consumer.example',
};

function req(method, origin, extra = {}) {
  const { headers: extraHeaders = {}, ...rest } = extra;
  const headers = {
    host: 'hq.example.com',
    ...(origin === undefined ? {} : { origin }),
    ...extraHeaders,
  };
  return { method, protocol: 'https', headers, ...rest };
}

const withCookie = (request, name = 'thq_session', value = 'session-token') => ({
  ...request,
  headers: { ...request.headers, cookie: `${name}=${value}` },
});

test('credentialed mutations fail closed for missing, null and cross-origin Origin', () => {
  const cookie = (origin) => withCookie(req('POST', origin));
  assert.equal(isAllowedMutation(cookie(undefined), env), false, 'missing Origin with a session cookie');
  assert.equal(isAllowedMutation(cookie(''), env), false, 'empty Origin with a session cookie');
  assert.equal(isAllowedMutation(cookie('null'), env), false, 'null Origin with a session cookie');
  assert.equal(isAllowedMutation(cookie('https://evil.example'), env), false);
  assert.equal(isAllowedMutation(cookie('https://hq.example.com'), env), true);
  assert.equal(isAllowedMutation(cookie('https://portal.example.com'), env), true);
  assert.equal(isAllowedMutation(withCookie(req('PUT', 'https://hq.example.com')), env), true);
  assert.equal(isAllowedMutation(withCookie(req('PATCH', 'https://portal.example.com')), env), true);
  assert.equal(isAllowedMutation(withCookie(req('DELETE', 'https://hq.example.com')), env), true);
});

test('missing Origin is allowed only for non-browser requests or the tested legacy bearer path', () => {
  assert.equal(isAllowedMutation(req('POST', undefined), env), true, 'no cookie, no browser metadata');
  assert.equal(isAllowedMutation(req('POST', undefined, {
    headers: { 'sec-fetch-site': 'same-origin' },
  }), env), false, 'browser fetch without Origin is not a non-browser request');
  assert.equal(isAllowedMutation(withCookie(req('POST', undefined), 'tp_session'), env), false);
  assert.equal(isAllowedMutation(withCookie(req('POST', undefined, {
    headers: { authorization: 'Bearer legacy-session' },
  })), env), false, 'a bearer header cannot bypass a session cookie without the opt-in');
  assert.equal(isAllowedMutation(withCookie(req('POST', undefined, {
    headers: { authorization: 'Bearer legacy-session' },
  })), { ...env, ALLOW_LEGACY_BEARER_SESSION: '1' }), true, 'explicit legacy bearer path is tested');
});

test('Sec-Fetch-Site cross-site is rejected even when Origin is otherwise allowed', () => {
  const crossSite = req('POST', 'https://hq.example.com', {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(isAllowedMutation(crossSite, env), false);
  assert.equal(isAllowedMutation(withCookie(crossSite), env), false);
  assert.equal(isAllowedMutation(req('GET', 'https://evil.example', {
    headers: { 'sec-fetch-site': 'cross-site' },
  }), env), true, 'cross-app GET remains bearer scoped');
});

test('forwarded headers are never trusted for same-origin fallback', () => {
  const spoofed = req('POST', 'https://hq.example.com', {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' },
  });
  spoofed.protocol = 'http';
  const sameOriginOnly = { PUBLIC_ORIGIN: '', FIRST_PARTY_ORIGINS: '' };
  assert.equal(requestOrigin(spoofed), 'http://hq.example.com');
  assert.equal(isAllowedMutation(spoofed, sameOriginOnly), false);

  const trustedProxyProtocol = req('POST', 'https://hq.example.com');
  trustedProxyProtocol.protocol = 'https';
  assert.equal(isAllowedMutation(trustedProxyProtocol, sameOriginOnly), true);
});

test('configured origins are exact: no wildcard, suffix, userinfo, path or null', () => {
  assert.deepEqual(allowedOrigins(env), [
    'https://hq.example.com',
    'https://portal.example.com',
  ]);
  assert.deepEqual(allowedOrigins({ PUBLIC_ORIGIN: '*', FIRST_PARTY_ORIGINS: '* , null' }), []);
  assert.equal(isAllowedMutation(req('POST', 'https://hq.example.com.evil.example'), env), false);
  assert.equal(isAllowedMutation(req('POST', 'https://evil.example/hq.example.com'), env), false);
  assert.equal(isAllowedMutation(req('POST', 'https://user@hq.example.com'), env), false);
  assert.equal(isAllowedMutation(req('POST', 'https://hq.example.com/report'), env), false);
  assert.equal(isAllowedMutation(req('POST', 'null'), env), false);

  const explicitUnusable = { PUBLIC_ORIGIN: '', FIRST_PARTY_ORIGINS: '*' };
  assert.equal(isAllowedMutation(req('POST', 'https://hq.example.com'), explicitUnusable), false);
});

test('hasSessionCookie detects either first-party cookie even when empty', () => {
  assert.equal(hasSessionCookie(req('POST', undefined)), false);
  assert.equal(hasSessionCookie(withCookie(req('POST', undefined))), true);
  assert.equal(hasSessionCookie(withCookie(req('POST', undefined), 'tp_session')), true);
  assert.equal(hasSessionCookie(withCookie(req('POST', undefined), 'other', '')), false);
});

test('csrfMiddleware returns 403 without calling the next handler for a blocked mutation', () => {
  const calls = [];
  const res = {
    status(code) { calls.push(['status', code]); return this; },
    json(body) { calls.push(['json', body]); return this; },
  };
  let nextCalled = false;

  csrfMiddleware(env)(withCookie(req('POST', 'https://evil.example')), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.deepEqual(calls, [['status', 403], ['json', { error: 'cross-origin request blocked' }]]);

  csrfMiddleware(env)(withCookie(req('POST', undefined)), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'credentialed request without Origin must be blocked');
});
