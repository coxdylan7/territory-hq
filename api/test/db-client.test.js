'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseUrl, poolMax, makeSql } = require('../src/db-client');

test('databaseUrl fails closed when the server-side secret is absent', () => {
  assert.throws(() => databaseUrl({}), /DATABASE_URL/);
  assert.throws(() => databaseUrl({ DATABASE_URL: '   ' }), /DATABASE_URL/);
  assert.equal(databaseUrl({ DATABASE_URL: ' postgres://example/db \n' }), 'postgres://example/db');
});

test('poolMax keeps the existing default unless a valid serverless override is set', () => {
  assert.equal(poolMax({}, 4), 4);
  assert.equal(poolMax({ DATABASE_MAX: '1' }, 4), 1);
  assert.equal(poolMax({ DATABASE_MAX: '20' }, 4), 20);
  for (const bad of ['0', '-1', 'abc', '1.5', '   ']) {
    assert.equal(poolMax({ DATABASE_MAX: bad }, 4), 4, `${bad} must not change the pool size`);
  }
});

test('makeSql defers client creation and reuses one client across invocations', () => {
  const calls = [];
  const client = { marker: 'client', begin: () => 'tx' };
  const factory = (url, options) => {
    calls.push({ url, options });
    return client;
  };

  const { sql, getClient } = makeSql({
    env: { DATABASE_URL: 'postgres://example/db', DATABASE_MAX: '1' },
    factory,
    max: 4,
    idle_timeout: 20,
  });

  assert.equal(calls.length, 0, 'importing the app must not open a pool');
  assert.equal(getClient(), client);
  assert.equal(getClient(), client);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: 'postgres://example/db',
    options: { max: 1, idle_timeout: 20 },
  });

  assert.equal(sql.begin(), 'tx', 'tagged-template helper forwards client methods');
  assert.equal(calls.length, 1);
});

test('makeSql without DATABASE_URL throws only on first use, without a secret value', () => {
  const calls = [];
  const { getClient } = makeSql({
    env: {},
    factory: (...args) => calls.push(args),
    max: 4,
  });

  assert.equal(calls.length, 0);
  assert.throws(() => getClient(), (error) => {
    assert.match(error.message, /DATABASE_URL/);
    assert.doesNotMatch(error.message, /postgres:\/\//);
    return true;
  });
  assert.equal(calls.length, 0, 'must never construct a client with an implicit local connection');
});
