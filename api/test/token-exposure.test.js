const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repo = (p) => readFileSync(path.join(__dirname, '../..', p), 'utf8');

test('first-party browser clients never store or send session tokens and always use cookies', () => {
  for (const file of ['web/src/api.js', 'portal/web/src/api.js']) {
    const src = repo(file);
    assert.doesNotMatch(src, /localStorage|sessionStorage|AUTH_TOKEN|authHeaders/, `${file} must not store session tokens`);
    assert.doesNotMatch(src, /['"]Authorization['"]\s*:/, `${file} must not send session bearer tokens`);
    assert.match(src, /credentials:\s*['"]include['"]/, `${file} must send cookie credentials`);
    assert.doesNotMatch(src, /\bd\.token\b|\br\.token\b/, `${file} must not read a token from JSON`);
  }
});

test('HQ auth responses set a session cookie but never expose a token in JSON', () => {
  const src = repo('api/src/server.js');
  assert.match(src, /setSessionCookie\(res, HQ_COOKIE, token\)/);
  assert.match(src, /clearSessionCookie\(res, HQ_COOKIE\)/);
  // Only signup/login return first-party sessions. Portal-invite tokens shown
  // to the admin are a separate, non-session credential and are out of scope.
  for (const route of ['/api/auth/signup', '/api/auth/login']) {
    const start = src.indexOf(`app.post('${route}'`);
    assert.notEqual(start, -1);
    const end = src.indexOf('\napp.', start + 1);
    const body = src.slice(start, end < 0 ? src.length : end);
    assert.doesNotMatch(body, /\btoken\s*:/, `${route} JSON must not contain a session token`);
  }
  assert.match(src, /return json\(res, \{ ok: true, user: userView\(u\) \}\)/);
  assert.match(src, /currentSessionUser\(sql, req\)/);
});

test('portal auth responses set a session cookie but never expose a token in JSON', () => {
  const src = repo('portal/api/src/server.js');
  assert.match(src, /setSessionCookie\(res, PORTAL_COOKIE, token\)/);
  assert.match(src, /clearSessionCookie\(res, PORTAL_COOKIE\)/);
  assert.doesNotMatch(src, /ok\(res, \{ token/, 'portal JSON must not contain a session token');
  assert.doesNotMatch(src, /if \(!r\.token\)/, 'portal client must not require a JSON token');
});

test('cross-app GET routes still require owner-scoped bearer authorization', () => {
  const src = repo('api/src/server.js');
  assert.match(src, /resolveOwner: \(req\) => resolveCrossAppOwner\(req\)/);
  assert.match(src, /app\.get\('\/api\/credits\/balances'/);
  assert.match(src, /app\.get\('\/api\/messages\/shared'/);
  const docs = repo('README.md');
  assert.match(docs, /Authorization: Bearer <OWNER_SCOPED_TOKEN>/);
});
