'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../');
const schemaPath = path.join(repoRoot, 'api/src/schema.js');
const migrationDir = path.join(repoRoot, 'supabase/migrations');
const preflightPath = path.join(repoRoot, 'docs/credit-ledger-deployment-preflight.md');

function latestMigration() {
  const migrations = fs
    .readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return {
    name: migrations.at(-1),
    sql: fs.readFileSync(path.join(migrationDir, migrations.at(-1)), 'utf8'),
  };
}

const schema = fs.readFileSync(schemaPath, 'utf8');
const migration = latestMigration();
const sources = { schema, migration: migration.sql };

function sourceHas(needle) {
  for (const [name, source] of Object.entries(sources)) {
    assert.match(
      source,
      new RegExp(escapeRegExp(needle)),
      `${name} is missing ${needle}`
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('additive migration supersedes the security migration', () => {
  assert.ok(migration.name > '20261122002427_secure_public_data_api.sql');
  assert.match(migration.sql, /booking quote/i);
  assert.match(migration.sql, /deployment preflight/i);
});

test('both schema paths define immutable booking quote and audit metadata columns', () => {
  const names = [
    'quoted_credits NUMERIC(14,2)',
    'quote_base_hours NUMERIC(8,2)',
    'quote_base_credits NUMERIC(14,2)',
    'quote_extra_hour_credits NUMERIC(14,2)',
    'requested_by_portal_user_id TEXT',
    'created_by_actor_type TEXT',
    'created_by_actor_id TEXT',
    'approved_at TIMESTAMPTZ',
    'confirmed_at TIMESTAMPTZ',
    'declined_at TIMESTAMPTZ',
    'cancelled_at TIMESTAMPTZ',
    'completed_at TIMESTAMPTZ',
    'status_changed_at TIMESTAMPTZ',
    'version INTEGER NOT NULL DEFAULT 1',
  ];
  for (const name of names) sourceHas(name);
});

test('both schema paths stage numeric money without coercing legacy values', () => {
  sourceHas('amount_numeric NUMERIC(14,2)');
  sourceHas('credits_charged_numeric NUMERIC(14,2)');
  sourceHas('duration_hours_numeric NUMERIC(8,2)');
  assert.doesNotMatch(migration.sql, /ALTER\s+TABLE\s+credits\s+ALTER\s+COLUMN\s+amount/i);
  assert.doesNotMatch(migration.sql, /USING\s+round\(/i);
});

test('both schema paths define append-only ledger metadata and uniqueness', () => {
  const names = [
    'entry_type TEXT',
    'booking_id TEXT',
    'source_id TEXT',
    'idempotency_key TEXT',
    'reverses_credit_id TEXT',
    'actor_type TEXT',
    'actor_id TEXT',
    'metadata JSONB NOT NULL DEFAULT',
    'credits_booking_entry_unique',
    'credits_idempotency_unique',
    'immutable_credits',
  ];
  for (const name of names) sourceHas(name);
  assert.match(migration.sql, /NOT\s+VALID/i);
});

test('both schema paths define audit and idempotency tables with owner indexes', () => {
  const names = [
    'booking_events (',
    'api_idempotency (',
    'booking_events_owner_booking_created_idx',
    'booking_events_request_unique',
    'api_idempotency_created_at_idx',
    'bookings_owner_status_date_idx',
    'bookings_owner_account_date_idx',
    'bookings_owner_ambassador_date_idx',
    'credits_owner_account_created_idx',
    'event_types_owner_active_name_idx',
    'portal_users_owner_role_status_idx',
  ];
  for (const name of names) sourceHas(name);
});

test('both schema paths enforce the documented state machine without exclusion constraints', () => {
  sourceHas('bookings_status_check');
  sourceHas('enforce_booking_transition');
  sourceHas('immutable_booking_quote');
  assert.doesNotMatch(migration.sql, /CREATE\s+EXTENSION[^\n]*btree_gist/i);
  assert.doesNotMatch(migration.sql, /bookings_account_no_overlap/i);
  assert.doesNotMatch(migration.sql, /bookings_ambassador_no_overlap/i);
});

test('new protected tables are included in boot-time security protection', () => {
  const { MANAGED_TABLES } = require('../src/schema');
  assert.ok(MANAGED_TABLES.includes('booking_events'));
  assert.ok(MANAGED_TABLES.includes('api_idempotency'));
});

test('deployment preflight documents all unsafe legacy-data categories', () => {
  const preflight = fs.readFileSync(preflightPath, 'utf8');
  for (const topic of [
    'backup',
    'null owner',
    'orphan account',
    'invalid date',
    'duration',
    'status',
    'duplicate',
    'overlap',
    'amount',
    'quarantine',
    'balance parity',
    'btree_gist',
    'exclusion',
  ]) {
    assert.match(preflight, new RegExp(escapeRegExp(topic), 'i'), `preflight is missing ${topic}`);
  }
});
