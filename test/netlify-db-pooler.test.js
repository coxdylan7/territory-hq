'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const root = path.join(__dirname, '..');
const DB_CLIENT = path.join(root, 'api/src/db-client.js');
const PLACEHOLDER_URL = 'postgres://placeholder@example.invalid/db';

async function withDbModule(relativePath, callback) {
  const modulePath = path.join(root, relativePath);
  const calls = [];
  const originalLoad = Module._load;
  const fakePostgres = (url, options) => {
    calls.push({ url, options });
    return () => Promise.resolve([]);
  };

  Module._load = function load(request, parent, isMain) {
    if (request === 'postgres') return fakePostgres;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  delete require.cache[DB_CLIENT];

  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = PLACEHOLDER_URL;
  try {
    return await callback({ db: require(modulePath), calls });
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    Module._load = originalLoad;
    delete require.cache[modulePath];
    delete require.cache[DB_CLIENT];
  }
}

test('HQ and Portal share the pooler-safe postgres.js client settings', async () => {
  for (const [name, relativePath, applicationName, max] of [
    ['HQ', 'api/src/db.js', 'territory-hq', 4],
    ['Portal', 'portal/api/src/db.js', 'territory-portal', 10],
  ]) {
    await withDbModule(relativePath, async ({ db, calls }) => {
      await db.sql`select 1`;

      assert.equal(calls.length, 1, `${name} must create exactly one lazy client`);
      assert.equal(calls[0].url, PLACEHOLDER_URL, `${name} must use DATABASE_URL unchanged`);
      assert.equal(calls[0].options.prepare, false, `${name} must disable prepared statements`);
      assert.equal(calls[0].options.max, max, `${name} pool cap must be preserved`);
      assert.equal(
        calls[0].options.connection.application_name,
        applicationName,
        `${name} application name must be preserved`
      );
    });
  }
});
