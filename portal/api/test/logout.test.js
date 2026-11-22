const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { logoutSession, isUsableSessionToken } = require('../src/logout');

const VALID = 'a'.repeat(64);
const requestWithCookie = (cookie) => ({ headers: cookie ? { cookie } : {} });

function deps() {
  const calls = [];
  return {
    calls,
    deleteSession: async (token) => { calls.push(['delete', token]); },
    clearCookie: () => { calls.push(['clear']); },
  };
}

test('logout clears tp_session even when no session cookie is present', async () => {
  const d = deps();
  assert.deepEqual(await logoutSession(requestWithCookie(''), d), { ok: true });
  assert.deepEqual(d.calls, [['clear']]);
});

test('logout is ungated for expired and deleted sessions but still deletes usable tokens', async () => {
  for (const description of ['expired', 'deleted']) {
    const d = deps();
    assert.deepEqual(await logoutSession(requestWithCookie(`tp_session=${VALID}`), d), { ok: true }, description);
    assert.deepEqual(d.calls, [['delete', VALID], ['clear']], description);
  }
});

test('logout clears malformed cookies without attempting a database delete', async () => {
  for (const value of ['bad', 'short%0Atoken', '%20%20', 'null']) {
    const d = deps();
    assert.equal(isUsableSessionToken(decodeURIComponent(value)), false, value);
    assert.deepEqual(await logoutSession(requestWithCookie(`tp_session=${value}`), d), { ok: true }, value);
    assert.deepEqual(d.calls, [['clear']], value);
  }
});

test('logout still clears the cookie when session deletion fails', async () => {
  const d = deps();
  d.deleteSession = async () => { d.calls.push(['delete-failed']); throw new Error('db down'); };
  assert.deepEqual(await logoutSession(requestWithCookie(`tp_session=${VALID}`), d), { ok: true });
  assert.deepEqual(d.calls, [['delete-failed'], ['clear']]);
});

test('portal logout route uses the ungated tested helper', () => {
  const src = readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(src, /app\.post\('\/api\/auth\/logout',\s*async/);
  assert.doesNotMatch(src, /app\.post\('\/api\/auth\/logout',\s*gate/);
  assert.match(src, /await logoutSession\(req,\s*\{/);
});
