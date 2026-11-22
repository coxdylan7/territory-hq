const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { setSessionCookie, clearSessionCookie, PORTAL_COOKIE } = require('../../../api/src/session-cookie');

const serverSource = readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
const clientSource = readFileSync(path.join(__dirname, '../../web/src/api.js'), 'utf8');

test('portal API sets and clears an HttpOnly cookie instead of returning a session token', () => {
  assert.match(serverSource, /setSessionCookie\(res, PORTAL_COOKIE, token\)/);
  assert.match(serverSource, /clearSessionCookie\(res, PORTAL_COOKIE\)/);
  assert.doesNotMatch(serverSource, /ok\(res, \{ token/);
  assert.match(serverSource, /sessionTokenFromRequest\(req, \{ cookieName: PORTAL_COOKIE \}\)/);
  assert.doesNotMatch(serverSource, /req\.headers\.authorization/);

  const values = [];
  const res = { append(name, value) { values.push([name, value]); } };
  setSessionCookie(res, PORTAL_COOKIE, 'portal-token', { NODE_ENV: 'production' });
  clearSessionCookie(res, PORTAL_COOKIE, { NODE_ENV: 'production' });
  assert.equal(values.length, 2);
  assert.match(values[0][1], /^tp_session=portal-token;/);
  assert.match(values[0][1], /;\s*HttpOnly/);
  assert.match(values[0][1], /;\s*Secure/);
  assert.match(values[1][1], /Max-Age=0/);
});

test('portal browser client uses cookies and never stores or reads a token', () => {
  const code = clientSource.replace(/\/\/.*$/gm, '');
  assert.match(code, /credentials:\s*['"]include['"]/);
  assert.doesNotMatch(code, /localStorage|sessionStorage|Authorization|\btoken\b/i);
});
