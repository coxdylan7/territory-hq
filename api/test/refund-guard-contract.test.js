'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');
const sources = {
  runtime: readFileSync(path.join(repoRoot, 'api/src/schema.js'), 'utf8'),
  migration: readFileSync(
    path.join(repoRoot, 'supabase/migrations/20261122010000_credit_ledger.sql'),
    'utf8'
  ),
};

for (const [name, source] of Object.entries(sources)) {
  test(`${name} installs an idempotent booking refund constraint trigger`, () => {
    assert.match(source, /CREATE OR REPLACE FUNCTION (?:public\.)?enforce_booking_refund_guard\(\)/);
    assert.match(source, /DROP TRIGGER IF EXISTS enforce_booking_refund ON (?:public\.)?credits/);
    assert.match(source, /CREATE TRIGGER enforce_booking_refund[\s\S]*?BEFORE INSERT OR UPDATE ON (?:public\.)?credits/);
  });

  test(`${name} validates the referenced charge's owner, account, booking and amount`, () => {
    assert.match(source, /reverses_credit_id IS NULL/, `${name}: a refund must name the charge it reverses`);
    assert.match(source, /entry_type(?: IS DISTINCT FROM| <>| =) 'booking_charge'/, `${name}: reversed entry must be a charge`);
    assert.match(source, /charge\.user_id/, `${name}: owner must match`);
    assert.match(source, /charge\.account_id/, `${name}: account must match`);
    assert.match(source, /charge\.booking_id/, `${name}: booking must match`);
    assert.match(source, /-charge\.amount_numeric/, `${name}: amount must be exactly negated`);
  });
}
