'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const runbookPath = path.join(root, 'docs/supabase-deployment-runbook.md');
const preflightPath = path.join(root, 'docs/credit-ledger-deployment-preflight.md');
const runbook = fs.readFileSync(runbookPath, 'utf8');
const preflight = fs.readFileSync(preflightPath, 'utf8');

test('deployment runbook covers every required operational topic', () => {
  const topics = [
    'Safety rules and required environment variables',
    'Backup and restore point',
    'Disposable branch/staging database',
    'Local verification before touching any database',
    'Supabase CLI linking',
    'Migration list and dry checks',
    'Legacy-data preflight',
    'TEST_DATABASE_URL integration suite',
    'db push and advisors',
    'Verification queries',
    'Application rollout order',
    'Rollback and restore decision points',
    'Post-deploy smoke tests',
  ];
  for (const topic of topics) {
    assert.match(runbook, new RegExp(topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `runbook is missing: ${topic}`);
  }
});

test('runbook documents exact explicit commands and confirmation gates', () => {
  for (const command of [
    'supabase link --project-ref "$STAGING_REF"',
    'supabase migration list --remote',
    'supabase db push --remote --skip-vault --dry-run',
    'supabase db push --remote --skip-vault',
    'supabase db advisors --remote --type all --level warn --fail-on error',
    'supabase db lint --remote --fail-on error',
    'npm run verify',
    'npm run migration:preflight',
    'npm run migration:verify',
    'TEST_DATABASE_URL="$DISPOSABLE_TEST_DB_URL" npm --prefix api test',
    '--confirm-environment',
    '--db-url-stdin',
  ]) {
    assert.ok(runbook.includes(command), `runbook is missing command fragment: ${command}`);
  }
  assert.match(runbook, /npm run build:all/);
  assert.match(runbook, /SKIP_SCHEMA=1/);
  assert.match(runbook, /do not deploy the new\s+application before the migration/i);
});

test('runbook and preflight document required legacy-data categories', () => {
  for (const topic of [
    'null owner', 'orphan', 'invalid date', 'duration', 'status',
    'duplicate', 'overlap', 'amount', 'balance baseline', 'NOT VALID',
  ]) {
    assert.match(`${runbook}\n${preflight}`, new RegExp(topic, 'i'), `documentation is missing: ${topic}`);
  }
});

test('runbook contains no credential values and never reads .env', () => {
  assert.doesNotMatch(runbook, /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/, 'literal credentials in runbook');
  assert.doesNotMatch(runbook, /\bsb_secret_[A-Za-z0-9_-]{8,}\b/);
  assert.doesNotMatch(runbook, /\beyJ[A-Za-z0-9_-]{10,}\b/);
  assert.match(runbook, /Do not use `--password/, 'runbook must forbid command-line passwords');
  assert.doesNotMatch(runbook, /cat\s+(?:api\/)?\.env/);
  assert.doesNotMatch(runbook, /source\s+(?:api\/)?\.env/);
  assert.doesNotMatch(runbook, /node --env-file/);
});
