'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, 'postgres-integration.test.js'), 'utf8');

const REQUIRED_TESTS = [
  'real Postgres overlap checks reject equal and contained bookings and allow adjacent bookings',
  'real Postgres schema boot can be rerun with triggers already installed',
  'real Postgres legacy quote backfill runs once and then becomes immutable',
  'real Postgres refund trigger enforces the original charge owner, account, booking and amount',
  'real Postgres a rolled-back command can retry with the same key',
  'real Postgres invite activation isolates owners and accounts',
  'real Postgres ambassador removal downgrades and audits a confirmed booking',
];

test('optional Postgres suite declares every deferred behavior check', () => {
  for (const name of REQUIRED_TESTS) {
    assert.ok(source.includes(`dbTest('${name}'`), `missing optional DB test: ${name}`);
  }
});

test('optional Postgres suite covers interval edges, quote reconciliation and refund identity', () => {
  assert.match(source, /BOOKING_OVERLAP/);
  assert.match(source, /adjacent/i);
  assert.match(source, /contained/i);
  assert.match(source, /equal/i);
  assert.match(source, /fill_legacy_booking_quote/);
  assert.match(source, /immutable/i);
  assert.match(source, /reverses_credit_id/);
  assert.match(source, /owner-2/);
  assert.match(source, /account_id/);
  assert.match(source, /amount_numeric/);
});

test('optional Postgres suite covers trigger reruns, rollback retry, invite isolation and audited removal', () => {
  assert.match(source, /makeEnsureSchema\(sql\)\(\)/);
  assert.match(source, /CREATE TRIGGER[\s\S]*booking_events/);
  assert.match(source, /same key/i);
  assert.match(source, /activatePortalInvite/);
  assert.match(source, /ACCOUNT_MISMATCH/);
  assert.match(source, /ACCOUNT_NOT_AVAILABLE/);
  assert.match(source, /removePortalUsersBookings/);
  assert.match(source, /ambassador_removed/);
  assert.match(source, /confirmed_at/);
});
