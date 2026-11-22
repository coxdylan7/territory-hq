const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sessionCookieHeader,
  clearSessionCookieHeader,
  setSessionCookie,
  clearSessionCookie,
  cookieValue,
  SESSION_MAX_AGE,
} = require('../src/session-cookie');

test('session cookies are HttpOnly, SameSite=Lax, Path=/, 30 days and Secure in production', () => {
  const prod = sessionCookieHeader('thq_session', 'tok.en', { NODE_ENV: 'production' });
  assert.match(prod, /^thq_session=tok\.en;/);
  assert.match(prod, /;\s*HttpOnly/);
  assert.match(prod, /;\s*Secure/);
  assert.match(prod, /;\s*SameSite=Lax/);
  assert.match(prod, /;\s*Path=\//);
  assert.match(prod, new RegExp(`;\\s*Max-Age=${SESSION_MAX_AGE}`));

  const dev = sessionCookieHeader('tp_session', 'tok', { NODE_ENV: 'development' });
  assert.doesNotMatch(dev, /;\s*Secure/);
  assert.match(dev, /^tp_session=tok;/);
  assert.equal(SESSION_MAX_AGE, 30 * 24 * 60 * 60);
});

test('setSessionCookie and clearSessionCookie append independent Set-Cookie headers', () => {
  const env = { NODE_ENV: 'production' };
  const written = [];
  const res = { append(name, value) { written.push([name, value]); } };

  setSessionCookie(res, 'thq_session', 'tok one', env);
  clearSessionCookie(res, 'thq_session', env);

  assert.equal(written.length, 2);
  assert.equal(written[0][0], 'Set-Cookie');
  assert.match(written[0][1], /^thq_session=tok%20one;/);
  assert.equal(written[1][0], 'Set-Cookie');
  assert.match(written[1][1], /^thq_session=;/);
  assert.match(written[1][1], /Max-Age=0/);
  assert.match(written[1][1], /Expires=Thu, 01 Jan 1970/);
});
