'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { makeEnsureSchema } = require('../src/schema');
const { createFakeSql } = require('./helpers/fake-sql');

const TRIGGERS = [
  'immutable_credits',
  'enforce_booking_refund',
  'immutable_booking_quote',
  'enforce_booking_transition',
];

function source(relative) {
  const repoRoot = path.join(__dirname, '..', '..');
  const fullPath = relative.startsWith('src/')
    ? path.join(repoRoot, 'api', relative)
    : path.join(repoRoot, relative);
  return readFileSync(fullPath, 'utf8');
}

function triggerCatalog(initial = []) {
  const triggers = new Set(initial);
  const handler = (text) => {
    const drop = text.match(/DROP TRIGGER IF EXISTS\s+([a-z_]+)/i);
    if (drop) triggers.delete(drop[1]);
    const create = text.match(/CREATE TRIGGER\s+([a-z_]+)/i);
    if (create) {
      if (triggers.has(create[1])) {
        const error = new Error(`trigger "${create[1]}" already exists`);
        error.code = '42710';
        throw error;
      }
      triggers.add(create[1]);
    }
    return [];
  };
  return { triggers, ...createFakeSql(handler) };
}

test('runtime schema drops each trigger before recreating it', () => {
  const runtime = source('src/schema.js');
  for (const trigger of TRIGGERS) {
    const dropIndex = runtime.indexOf(`DROP TRIGGER IF EXISTS ${trigger}`);
    const createIndex = runtime.indexOf(`CREATE TRIGGER ${trigger}`);
    assert.ok(dropIndex >= 0, `${trigger}: missing DROP TRIGGER IF EXISTS in runtime schema`);
    assert.ok(createIndex > dropIndex, `${trigger}: drop must precede create`);
  }
});

test('credit-ledger migration drops each trigger before recreating it', () => {
  const migration = source('supabase/migrations/20261122010000_credit_ledger.sql');
  for (const trigger of TRIGGERS) {
    const dropIndex = migration.indexOf(`DROP TRIGGER IF EXISTS ${trigger}`);
    const createIndex = migration.indexOf(`CREATE TRIGGER ${trigger}`);
    assert.ok(dropIndex >= 0, `${trigger}: missing DROP TRIGGER IF EXISTS in migration`);
    assert.ok(createIndex > dropIndex, `${trigger}: drop must precede create`);
  }
});

test('boot succeeds when migration-created triggers already exist', async () => {
  const { sql, triggers } = triggerCatalog(TRIGGERS);
  await makeEnsureSchema(sql)();
  assert.deepEqual([...triggers].sort(), [...TRIGGERS].sort());
});

test('two independent boots can run schema DDL against the same catalog', async () => {
  const { sql, triggers } = triggerCatalog();
  await makeEnsureSchema(sql)();
  await makeEnsureSchema(sql)();
  assert.deepEqual([...triggers].sort(), [...TRIGGERS].sort());
});
