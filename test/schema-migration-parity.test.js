'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { schemaStatements, protectionStatements } = require('../api/src/schema');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'api/src/schema.js'), 'utf8');
const publicRuntimeSql = schemaStatements('public').join('\n');
const isolatedRuntimeSql = schemaStatements('ledger_test_parity').join('\n');
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
  const functionPattern = /CREATE OR REPLACE FUNCTION (?:"public"|public)\.(\w+)/g;
  assert.deepEqual([...names(triggerPattern, publicRuntimeSql)].sort(), [...names(triggerPattern, ledgerSql)].sort());
  assert.deepEqual([...names(functionPattern, publicRuntimeSql)].sort(), [...names(functionPattern, ledgerSql)].sort());
});

const FUNCTION_NAMES = [
  'immutable_credits_guard',
  'enforce_booking_refund_guard',
  'immutable_booking_quote_guard',
  'fill_legacy_booking_total',
  'fill_legacy_booking_quote',
  'enforce_booking_transition_guard',
];
const TRIGGER_NAMES = [
  'immutable_credits',
  'enforce_booking_refund',
  'immutable_booking_quote',
  'enforce_booking_transition',
];

function normalizeSql(text) {
  return String(text)
    .replace(/--[^\n]*/g, ' ')
    .replace(/"public"\./g, 'public.')
    .replace(/SET search_path = "public"/g, 'SET search_path = public')
    .replace(/\$\$;/g, '$$')
    .replace(/\s+/g, ' ')
    .trim();
}

function functionDefinition(source, schemaName, name) {
  const variants = [`"${schemaName}".${name}`, `${schemaName}.${name}`];
  const start = variants
    .map((qualified) => source.indexOf(`CREATE OR REPLACE FUNCTION ${qualified}(`))
    .find((index) => index >= 0);
  assert.ok(start >= 0, `missing function ${schemaName}.${name}`);
  const firstDollar = source.indexOf('$$', start);
  const end = source.indexOf('$$', firstDollar + 2);
  assert.ok(end > firstDollar, `unterminated function ${schemaName}.${name}`);
  return source.slice(start, end + 2);
}

function triggerDefinition(source, name) {
  const start = source.indexOf(`CREATE TRIGGER ${name}`);
  assert.ok(start >= 0, `missing trigger ${name}`);
  const match = /CREATE TRIGGER [\s\S]*?EXECUTE FUNCTION [^()]+\(\)/.exec(source.slice(start));
  assert.ok(match, `unterminated trigger ${name}`);
  return match[0];
}

test('runtime function bodies semantically match the migration functions', () => {
  for (const name of FUNCTION_NAMES) {
    const runtime = normalizeSql(functionDefinition(publicRuntimeSql, 'public', name));
    const migration = normalizeSql(functionDefinition(ledgerSql, 'public', name));
    assert.equal(runtime, migration, `${name}: runtime and migration bodies must agree`);
  }
});

test('runtime trigger actions semantically match the migration triggers', () => {
  for (const name of TRIGGER_NAMES) {
    const runtime = normalizeSql(triggerDefinition(publicRuntimeSql, name));
    const migration = normalizeSql(triggerDefinition(ledgerSql, name));
    assert.equal(runtime, migration, `${name}: runtime and migration triggers must agree`);
  }
});

test('runtime functions are schema-qualified with fixed search_path parity', () => {
  for (const source of [publicRuntimeSql, isolatedRuntimeSql]) {
    const schemaName = source === publicRuntimeSql ? 'public' : 'ledger_test_parity';
    for (const name of FUNCTION_NAMES) {
      const definition = functionDefinition(source, schemaName, name);
      assert.match(definition, new RegExp(`CREATE OR REPLACE FUNCTION "${schemaName}"\\.${name}\\(`));
      assert.match(definition, new RegExp(`SET search_path = "${schemaName}", pg_temp`));
    }
  }
  for (const name of FUNCTION_NAMES) {
    const definition = functionDefinition(ledgerSql, 'public', name);
    assert.match(definition, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`));
    assert.match(definition, /SET search_path = public, pg_temp/);
  }
});

test('runtime security setup targets the same validated schema as runtime DDL', () => {
  const isolated = protectionStatements('ledger_test_parity').join('\n');
  assert.match(isolated, /to_regclass\(format\('"ledger_test_parity"\.%I'/);
  assert.match(isolated, /ALTER TABLE "ledger_test_parity"\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(isolated, /ALTER TABLE "ledger_test_parity"\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(isolated, /REVOKE ALL ON TABLE "ledger_test_parity"\.%I FROM %s/);
  assert.doesNotMatch(isolated, /\bpublic\./);

  const production = protectionStatements('public').join('\n');
  assert.match(production, /to_regclass\(format\('"public"\.%I'/);
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
