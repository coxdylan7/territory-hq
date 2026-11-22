const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveCrossAppOwner } = require('../src/cross-app-auth');
const { makeCrossAppHandlers } = require('../src/cross-app-handlers');

function harness({ resolveOwner, sql }) {
  const replies = [];
  const reply = (res, body, origin, status) => {
    replies.push({ body, origin, status });
    return body;
  };
  return {
    replies,
    handlers: makeCrossAppHandlers({ resolveOwner, sql, reply, env: {} }),
  };
}

test('authorized credits reads use only the resolved owner', async () => {
  const queries = [];
  const sql = {
    unsafe(text, values) {
      queries.push({ text, values });
      return [{
        account_id: 'acc-1',
        account_name: 'Store One',
        license_number: 'OCM-1',
        city: 'Albany',
        balance: 75.5,
      }];
    },
  };
  const { handlers, replies } = harness({
    sql,
    resolveOwner: () => 'owner-a',
  });
  const req = {
    headers: { authorization: 'Bearer token-a', origin: 'https://other.example' },
    query: { ownerUserId: 'owner-b', owner_id: 'owner-b', license: 'OCM-1' },
  };

  const body = await handlers.creditsBalances(req, {});

  assert.equal(queries.length, 1);
  assert.equal(queries[0].values[0], 'owner-a');
  assert.equal(queries[0].values[1], 'OCM-1');
  assert.match(queries[0].text, /WHERE user_id = \$1/);
  assert.equal(replies[0].status, 200);
  assert.deepEqual(body, [{
    accountId: 'acc-1',
    accountName: 'Store One',
    licenseNumber: 'OCM-1',
    city: 'Albany',
    balance: 75.5,
  }]);
});

test('authorized shared message reads use only the resolved owner', async () => {
  const queries = [];
  const sql = {
    unsafe(text, values) {
      queries.push({ text, values });
      return [{
        id: 'msg-1',
        account_id: 'acc-1',
        account_name: 'Store One',
        license_number: 'OCM-1',
        city: 'Albany',
        channel: 'text',
        purpose: 'follow-up',
        body: 'Hello',
        recipient: '555-0100',
        direction: 'outbound',
        date: '2026-11-21',
        status: 'sent',
      }];
    },
  };
  const { handlers, replies } = harness({
    sql,
    resolveOwner: () => 'owner-a',
  });
  const req = {
    headers: { authorization: 'Bearer token-a', origin: 'https://other.example' },
    query: { ownerUserId: 'owner-b', license: 'OCM-1' },
  };

  const body = await handlers.sharedMessages(req, {});

  assert.equal(queries.length, 1);
  assert.equal(queries[0].values[0], 'owner-a');
  assert.equal(queries[0].values[1], 'OCM-1');
  assert.match(queries[0].text, /WHERE user_id = \$1/);
  assert.equal(replies[0].status, 200);
  assert.deepEqual(body, [{
    id: 'msg-1',
    accountId: 'acc-1',
    accountName: 'Store One',
    licenseNumber: 'OCM-1',
    city: 'Albany',
    channel: 'text',
    purpose: 'follow-up',
    body: 'Hello',
    to: '555-0100',
    direction: 'outbound',
    date: '2026-11-21',
    status: 'sent',
  }]);
});

test('cross-app handlers deny legacy global tokens before querying', async () => {
  const queries = [];
  const sql = {
    unsafe(text, values) {
      queries.push({ text, values });
      return [];
    },
  };
  const env = { CROSS_APP_TOKENS_JSON: '', READ_TOKEN: 'legacy-global' };
  const { handlers, replies } = harness({
    sql,
    resolveOwner: (req) => resolveCrossAppOwner(req, env, { error() {} }),
  });
  const req = {
    headers: { authorization: 'Bearer legacy-global', origin: 'https://other.example' },
    query: { license: 'OCM-1' },
  };

  await handlers.creditsBalances(req, {});
  await handlers.sharedMessages(req, {});

  assert.equal(queries.length, 0);
  assert.deepEqual(replies.map((r) => r.status), [401, 401]);
  assert.deepEqual(replies.map((r) => r.body), [
    { error: 'unauthorized' },
    { error: 'unauthorized' },
  ]);
});
