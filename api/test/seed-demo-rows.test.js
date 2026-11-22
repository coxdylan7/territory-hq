'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { demoCreditGrant, demoBooking } = require('../scripts/seed-demo-rows');

const owner = { id: 'owner-1' };
const account = {
  id: 'acc-1',
  name: 'TEST — Store A',
  license_number: 'TEST-A',
  city: 'Albany',
};
const eventType = {
  id: 'et-1',
  name: 'Training',
  base_hours: '1.5',
  base_price_credits: '10.25',
  extra_hour_credits: '0.49',
};

test('demo credit grant writes typed ledger fields and structured metadata', () => {
  const row = demoCreditGrant({
    id: 'cr-1',
    owner,
    account,
    credits: '250',
    date: '2026-11-21',
  });

  assert.equal(row.amount, '250.00');
  assert.equal(row.amount_numeric, '250.00');
  assert.equal(row.entry_type, 'grant');
  assert.equal(row.source_id, 'seed-demo');
  assert.equal(row.idempotency_key, 'seed-demo:grant:cr-1');
  assert.equal(row.actor_type, 'seed_demo');
  assert.equal(row.actor_id, 'owner-1');
  assert.deepEqual(JSON.parse(row.metadata), {
    source: 'seed_demo',
    accountName: 'TEST — Store A',
    demo: true,
  });
});

test('demo booking stores complete immutable quote snapshots and typed amounts', () => {
  const row = demoBooking({
    id: 'bk-1',
    owner,
    account,
    eventType,
    date: '2026-11-22',
    status: 'approved',
    ambassadorUserId: 'amb-1',
    charged: '11.52',
    notes: 'seed-demo',
    durationHours: '4.1',
  });

  assert.equal(row.duration_hours, 4.1);
  assert.equal(row.duration_hours_numeric, '4.10');
  assert.equal(row.credits_charged, '11.52');
  assert.equal(row.credits_charged_numeric, '11.52');
  assert.equal(row.quoted_credits, '11.52');
  assert.equal(row.quote_base_hours, '1.50');
  assert.equal(row.quote_base_credits, '10.25');
  assert.equal(row.quote_extra_hour_credits, '0.49');
  assert.equal(row.created_by_actor_type, 'seed_demo');
  assert.equal(row.created_by_actor_id, 'owner-1');
  assert.equal(row.status, 'approved');
});

test('seed script uses the typed row builders instead of legacy inserts', () => {
  const source = readFileSync(path.join(__dirname, '../scripts/seed-demo.js'), 'utf8');
  assert.match(source, /require\('\.\/seed-demo-rows'\)/);
  assert.match(source, /demoCreditGrant\(/);
  assert.match(source, /demoBooking\(/);
  assert.match(source, /amount_numeric/);
  assert.match(source, /metadata\s*\}::jsonb/);
  assert.match(source, /duration_hours_numeric/);
  assert.match(source, /quote_extra_hour_credits/);
  assert.doesNotMatch(source, /INSERT INTO credits \(id, user_id, account_id, account_name, license_number, city, amount, note, date\)/);
});
