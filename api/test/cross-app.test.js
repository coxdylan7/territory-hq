const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveCrossAppOwner } = require('../src/cross-app-auth');
const { creditsBalancesQuery, sharedMessagesQuery } = require('../src/cross-app-queries');

const silentLogger = { error() {} };
const requestWithBearer = (token, extra = {}) => ({
  headers: { authorization: `Bearer ${token}` },
  query: {},
  ...extra,
});

test('unknown and legacy global tokens are denied by default', () => {
  const env = { CROSS_APP_TOKENS_JSON: '', READ_TOKEN: 'legacy-global-token' };

  assert.equal(resolveCrossAppOwner(requestWithBearer('not-mapped'), env, silentLogger), null);
  assert.equal(resolveCrossAppOwner(requestWithBearer('legacy-global-token'), env, silentLogger), null);
  assert.equal(resolveCrossAppOwner({ headers: {}, query: {} }, env, silentLogger), null);
});

test('a mapped bearer token resolves only its configured owner', () => {
  const env = {
    CROSS_APP_TOKENS_JSON: JSON.stringify({ 'token-a': 'owner-a', 'token-b': 'owner-b' }),
    READ_TOKEN: 'legacy-global-token',
  };
  const req = requestWithBearer('token-a', {
    query: { ownerUserId: 'owner-b', owner_id: 'owner-b', userId: 'owner-b' },
    body: { ownerUserId: 'owner-b' },
  });

  assert.equal(resolveCrossAppOwner(req, env, silentLogger), 'owner-a');
  assert.equal(resolveCrossAppOwner(requestWithBearer('token-b'), env, silentLogger), 'owner-b');
});

test('malformed token configuration fails closed', () => {
  const malformed = [
    'not-json',
    '[]',
    '{"token-a":""}',
    '{"token-a":42}',
    '{"":"owner-a"}',
  ];

  for (const config of malformed) {
    const env = { CROSS_APP_TOKENS_JSON: config, READ_TOKEN: 'legacy-global-token' };
    assert.equal(resolveCrossAppOwner(requestWithBearer('token-a'), env, silentLogger), null);
    assert.equal(resolveCrossAppOwner(requestWithBearer('legacy-global-token'), env, silentLogger), null);
  }
});

test('config docs describe tokens as opaque strings with no fixed format', () => {
  for (const file of ['README.md', 'api/.env.example']) {
    const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    assert.match(source, /opaque/i, `${file} should explain tokens are opaque`);
    assert.match(source, /no fixed format|any non-empty/i, `${file} should not claim a required token format`);
  }
});

test('credits balances query requires owner scope', () => {
  for (const owner of [undefined, null, '', '   ']) {
    assert.throws(() => creditsBalancesQuery(owner), /owner/i);
  }

  const query = creditsBalancesQuery('owner-a', 'OCM-123');
  assert.match(query.text, /WHERE user_id = \$1/);
  assert.match(query.text, /AND license_number = \$2/);
  assert.deepEqual(query.values, ['owner-a', 'OCM-123']);
});

test('shared messages query requires owner scope', () => {
  for (const owner of [undefined, null, '', '   ']) {
    assert.throws(() => sharedMessagesQuery(owner), /owner/i);
  }

  const query = sharedMessagesQuery('owner-b');
  assert.match(query.text, /FROM messages/);
  assert.match(query.text, /date,\s*status/);
  assert.match(query.text, /WHERE user_id = \$1/);
  assert.match(query.text, /ORDER BY date DESC/);
  assert.deepEqual(query.values, ['owner-b']);

  const filtered = sharedMessagesQuery('owner-b', 'OCM-456');
  assert.match(filtered.text, /AND license_number = \$2/);
  assert.deepEqual(filtered.values, ['owner-b', 'OCM-456']);
});
