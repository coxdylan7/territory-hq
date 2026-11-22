'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');
const schema = readFileSync(path.join(repoRoot, 'api/src/schema.js'), 'utf8');
const migration = readFileSync(
  path.join(repoRoot, 'supabase/migrations/20261122010000_credit_ledger.sql'),
  'utf8'
);
const sources = { runtime: schema, migration };

function creditsDefinition(source) {
  const match = source.match(/CREATE TABLE IF NOT EXISTS credits \(([\s\S]*?)\n  `?\);?/);
  return match ? match[1] : '';
}

test('credits.created_at nullability is aligned between runtime schema and migration', () => {
  const runtimeCredits = creditsDefinition(schema);
  assert.match(runtimeCredits, /created_at TIMESTAMPTZ DEFAULT now\(\),/);
  assert.doesNotMatch(runtimeCredits, /created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);

  assert.match(migration, /ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,/);
  assert.match(migration, /ALTER COLUMN created_at SET DEFAULT now\(\)/);
});

test('quote guard permits exactly one legacy null-to-complete reconciliation', () => {
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /OLD\.quoted_credits IS NULL/, `${name}: missing old-null quote branch`);
    assert.match(source, /OLD\.quote_base_hours IS NULL/, `${name}: all four old quote fields must be null`);
    assert.match(source, /OLD\.quote_base_credits IS NULL/, `${name}: all four old quote fields must be null`);
    assert.match(source, /OLD\.quote_extra_hour_credits IS NULL/, `${name}: all four old quote fields must be null`);
    assert.match(source, /NEW\.quoted_credits IS NOT NULL/, `${name}: backfill must complete the quote`);
    assert.match(source, /NEW\.quote_base_hours IS NOT NULL/, `${name}: backfill must complete the quote`);
    assert.match(source, /NEW\.quote_base_credits IS NOT NULL/, `${name}: backfill must complete the quote`);
    assert.match(source, /NEW\.quote_extra_hour_credits IS NOT NULL/, `${name}: backfill must complete the quote`);
    assert.match(source, /one-time legacy quote backfill/i, `${name}: backfill branch must be documented`);
  }
});

test('an idempotent legacy quote backfill helper exists in both schema paths', () => {
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /CREATE OR REPLACE FUNCTION (?:public\.)?fill_legacy_booking_quote\(/, `${name}: missing backfill helper`);
    assert.match(source, /quoted_credits IS NULL/, `${name}: helper must only target legacy null quotes`);
    assert.match(source, /quote_extra_hour_credits IS NULL/, `${name}: helper must only target legacy null quotes`);
  }
});
