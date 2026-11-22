'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'api/src/schema.js'), 'utf8');
const migrationDir = path.join(root, 'supabase/migrations');
const migrations = fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
const migrationSql = migrations
  .map((name) => fs.readFileSync(path.join(migrationDir, name), 'utf8'))
  .join('\n');
const ledgerSql = fs.readFileSync(
  path.join(migrationDir, '20261122010000_credit_ledger.sql'), 'utf8'
);

function names(pattern, source) {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

function createBlock(source, table) {
  const start = source.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  assert.ok(start >= 0, `missing CREATE TABLE for ${table}`);
  const end = source.indexOf('`)', start);
  assert.ok(end > start, `unterminated CREATE TABLE for ${table}`);
  return source.slice(start, end);
}

test('fresh runtime schema and migration chain define the same tables', () => {
  const schemaTables = names(/CREATE TABLE IF NOT EXISTS (\w+)/g, schema);
  const migrationTables = names(/CREATE TABLE IF NOT EXISTS (?:public\.)?(\w+)/g, migrationSql);
  assert.deepEqual([...schemaTables].sort(), [...migrationTables].sort());
  assert.equal(schemaTables.size, 17);
});

test('fresh runtime schema and migration chain define the same indexes', () => {
  const pattern = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g;
  assert.deepEqual([...names(pattern, schema)].sort(), [...names(pattern, migrationSql)].sort());
});

test('fresh runtime schema and migration chain define the same triggers and functions', () => {
  const triggerPattern = /CREATE TRIGGER (\w+)/g;
  const functionPattern = /CREATE OR REPLACE FUNCTION (?:public\.)?(\w+)/g;
  assert.deepEqual([...names(triggerPattern, schema)].sort(), [...names(triggerPattern, ledgerSql)].sort());
  assert.deepEqual([...names(functionPattern, schema)].sort(), [...names(functionPattern, ledgerSql)].sort());
});

test('fresh runtime schema and migration chain use the same constraint names', () => {
  const schemaConstraints = names(/CONSTRAINT (\w+)/g, schema);
  const migrationConstraints = names(/ADD CONSTRAINT (\w+)/g, migrationSql);
  for (const name of migrationConstraints) {
    assert.ok(schemaConstraints.has(name), `runtime schema is missing constraint ${name}`);
  }
  assert.match(schema, /entry_type IS NULL OR entry_type IN/);
  assert.match(schema, /amount_numeric IS NULL/);
  assert.match(ledgerSql, /entry_type IS NULL OR entry_type IN/);
  assert.match(ledgerSql, /amount_numeric IS NULL OR/);
});

test('ledger columns added by migration exist in the fresh runtime schema', () => {
  const creditsBlock = createBlock(schema, 'credits');
  const bookingsBlock = createBlock(schema, 'bookings');
  const added = [...ledgerSql.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.equal(new Set(added).size, added.length);

  const ledgerColumns = require('../scripts/lib/deployment-queries');
  for (const column of ledgerColumns.EXPECTED_CREDIT_COLUMNS) {
    assert.ok(added.includes(column), `migration must add credits.${column}`);
    assert.match(creditsBlock, new RegExp(`\\b${column}\\b`), `runtime schema is missing credits.${column}`);
  }
  for (const column of ledgerColumns.EXPECTED_BOOKING_COLUMNS) {
    assert.ok(added.includes(column), `migration must add bookings.${column}`);
    assert.match(bookingsBlock, new RegExp(`\\b${column}\\b`), `runtime schema is missing bookings.${column}`);
  }
});
