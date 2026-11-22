'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'supabase', 'migrations');
const names = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
const sqlByName = new Map(names.map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));

const EXPECTED_ORDER = [
  '20240918000000_init.sql',
  '20240921000000_portal.sql',
  '20261122002427_secure_public_data_api.sql',
  '20261122010000_credit_ledger.sql',
];

test('migrations have one deterministic, expected order', () => {
  assert.deepEqual(names, EXPECTED_ORDER);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^\d{14}_[a-z0-9_]+\.sql$/, `${name} must use the Supabase timestamp format`);
  }
});

test('security migration follows both base schemas and credit ledger follows security', () => {
  const index = (name) => names.indexOf(name);
  assert.ok(index('20240918000000_init.sql') < index('20240921000000_portal.sql'));
  assert.ok(index('20240921000000_portal.sql') < index('20261122002427_secure_public_data_api.sql'));
  assert.ok(index('20261122002427_secure_public_data_api.sql') < index('20261122010000_credit_ledger.sql'));
});

test('every migration is syntactically plausible without a database', () => {
  for (const [name, sql] of sqlByName) {
    const code = sql.split('\n').map((part) => part.replace(/--.*$/, '')).join('\n');
    assert.ok(sql.trim().endsWith(';'), `${name} must end with a semicolon`);
    assert.equal((code.match(/\$\$/g) || []).length % 2, 0, `${name} has unbalanced dollar quotes`);
    assert.equal((code.match(/'/g) || []).length % 2, 0, `${name} has unbalanced single quotes`);
    assert.equal(
      (code.match(/\(/g) || []).length,
      (code.match(/\)/g) || []).length,
      `${name} has unbalanced parentheses`
    );
  }
});

test('migrations contain no source-level destructive data commands', () => {
  const forbidden = [
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+SCHEMA\b/i,
    /\bDROP\s+COLUMN\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bCREATE\s+EXTENSION\b/i,
    /\bALTER\s+COLUMN\s+\w+\s+TYPE\b/i,
  ];
  for (const [name, sql] of sqlByName) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(sql, pattern, `${name} contains a destructive or deferred command: ${pattern}`);
    }
  }
});

test('additive ledger DDL is idempotent at the source level', () => {
  const sql = sqlByName.get('20261122010000_credit_ledger.sql');
  assert.doesNotMatch(sql, /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i);
  assert.doesNotMatch(sql, /CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE\s+[\w.]+\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i);

  for (const constraint of [
    'credits_entry_type_check', 'credits_amount_numeric_check',
    'credits_booking_entry_shape_check', 'bookings_status_check',
    'bookings_quote_positive_check',
  ]) {
    const drop = sql.indexOf(`DROP CONSTRAINT IF EXISTS ${constraint}`);
    const add = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
    assert.ok(drop >= 0, `${constraint}: missing guarded drop`);
    assert.ok(add > drop, `${constraint}: drop must precede add`);
  }
  for (const trigger of [
    'immutable_credits', 'enforce_booking_refund',
    'immutable_booking_quote', 'enforce_booking_transition',
  ]) {
    const drop = sql.indexOf(`DROP TRIGGER IF EXISTS ${trigger}`);
    const add = sql.indexOf(`CREATE TRIGGER ${trigger}`);
    assert.ok(drop >= 0, `${trigger}: missing guarded drop`);
    assert.ok(add > drop, `${trigger}: drop must precede create`);
  }
});

test('security migration protects explicit tables and does not blanket-revoke public', () => {
  const sql = sqlByName.get('20261122002427_secure_public_data_api.sql');
  assert.match(sql, /REVOKE\s+ALL\s+ON\s+TABLE\s+public\.\%I/i);
  assert.doesNotMatch(sql, /REVOKE\s+ALL\s+ON\s+ALL\s+TABLES/i);
  assert.doesNotMatch(sql, /REVOKE\s+ALL\s+ON\s+ALL\s+FUNCTIONS/i);
  assert.match(sql, /ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]*revoke\s+execute\s+on\s+functions\s+from\s+public/i);
});
