const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const read = (p) => readFileSync(path.join(__dirname, '../..', p), 'utf8');

test('session, CSRF and CSP behavior and configuration are documented', () => {
  const docs = read('README.md');
  for (const needle of [
    'HttpOnly',
    'SameSite=Lax',
    'FIRST_PARTY_ORIGINS',
    'COOKIE_SECURE',
    'ALLOW_LEGACY_BEARER_SESSION',
    'Content-Security-Policy',
    'cross-origin request blocked',
  ]) {
    assert.ok(docs.includes(needle), `README must document ${needle}`);
  }

  const env = read('api/.env.example');
  for (const needle of ['FIRST_PARTY_ORIGINS=', 'COOKIE_SECURE=', 'ALLOW_LEGACY_BEARER_SESSION=']) {
    assert.ok(env.includes(needle), `api/.env.example must document ${needle}`);
  }
});
