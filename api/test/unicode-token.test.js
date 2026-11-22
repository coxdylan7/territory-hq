const test = require('node:test');
const assert = require('node:assert/strict');

const { safeEq } = require('../src/helpers');
const { resolveCrossAppOwner } = require('../src/cross-app-auth');
const { makeCrossAppHandlers } = require('../src/cross-app-handlers');

const silentLogger = { error() {} };

test('safeEq compares UTF-8 byte lengths before using timingSafeEqual', () => {
  // These have equal JS string lengths but different UTF-8 byte lengths.
  assert.equal(safeEq('\ud800\ud800\ud800', 'aaa'), false);
  assert.equal(safeEq('ééé', 'aaa'), false);
  assert.equal(safeEq('abc', 'abc'), true);
  assert.equal(safeEq('éé', 'éé'), true);
});

test('malformed Unicode bearer tokens return unauthorized instead of throwing', async () => {
  const env = { CROSS_APP_TOKENS_JSON: JSON.stringify({ 'abc': 'owner-a' }) };
  const replies = [];
  const reply = (res, body, origin, status) => {
    replies.push({ body, status });
    return body;
  };
  const sql = {
    unsafe() {
      throw new Error('unauthorized requests must not query the database');
    },
  };
  const handlers = makeCrossAppHandlers({
    sql,
    resolveOwner: (req) => resolveCrossAppOwner(req, env, silentLogger),
    reply,
  });
  const req = {
    headers: { authorization: 'Bearer \ud800\ud800\ud800' },
    query: {},
  };

  await assert.doesNotReject(() => handlers.creditsBalances(req, {}));
  await assert.doesNotReject(() => handlers.sharedMessages(req, {}));
  assert.deepEqual(replies, [
    { body: { error: 'unauthorized' }, status: 401 },
    { body: { error: 'unauthorized' }, status: 401 },
  ]);
});
