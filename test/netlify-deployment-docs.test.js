'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const readme = read('README.md');
const docPath = 'docs/netlify-deployment.md';
const docs = existsSync(path.join(root, docPath)) ? read(docPath) : '';
const runbook = read('docs/supabase-deployment-runbook.md');
const combined = `${readme}\n${docs}`;

test('README points to the authoritative two-site Netlify runbook', () => {
  assert.match(readme, /github\.com\/coxdylan7\/territory-hq/i, 'repository URL must be explicit');
  assert.match(readme, /docs\/netlify-deployment\.md/, 'README must link the detailed Netlify runbook');
  assert.match(combined, /Netlify is the authoritative web hosting target/i);
  assert.match(combined, /Render and Railway are legacy/i);
  assert.match(combined, /non-authoritative/i);
});

test('deployment docs give exact Netlify UI settings for both monorepo sites', () => {
  for (const fragment of [
    'Package directory',
    'Base directory',
    'repository root',
    '`portal`',
    '`netlify.toml`',
    '`portal/netlify.toml`',
    '`web/dist`',
    '`portal/web/dist`',
    '`netlify/functions`',
    '`portal/netlify/functions`',
    'NODE_VERSION = "22.12.0"',
  ]) {
    assert.ok(docs.includes(fragment), `Netlify docs are missing: ${fragment}`);
  }

  assert.match(docs, /npm --prefix api install --no-audit --no-fund/);
  assert.match(docs, /npm --prefix web install --no-audit --no-fund/);
  assert.match(docs, /npm --prefix web run build/);
  assert.match(docs, /npm --prefix portal\/api install --no-audit --no-fund/);
  assert.match(docs, /npm --prefix portal\/web install --no-audit --no-fund/);
  assert.match(docs, /npm --prefix portal\/web run build/);
});

test('deployment docs list all function environment gates without values', () => {
  for (const key of [
    'DATABASE_URL',
    'SKIP_SCHEMA=1',
    'PUBLIC_ORIGIN',
    'FIRST_PARTY_ORIGINS',
    'ALLOWED_ORIGINS',
    'TRUST_PROXY=1',
    'PORTAL_URL',
    'CROSS_APP_TOKENS_JSON',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'ANTHROPIC_API_KEY',
  ]) {
    assert.ok(docs.includes(key), `Netlify docs are missing env key: ${key}`);
  }
  assert.match(docs, /site environment variables/i);
  assert.match(docs, /DATABASE_URL.*server-side secret/i);
  assert.match(docs, /never.*\.env|do not read.*\.env/i);
  assert.doesNotMatch(docs, /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/);
  assert.doesNotMatch(docs, /\bsb_secret_[A-Za-z0-9_-]{8,}\b/);
});

test('deployment docs define deploy order, smoke tests and rollback', () => {
  for (const fragment of [
    'Deploy HQ first',
    'Deploy Portal second',
    'GET /api/health',
    'thq_session',
    'tp_session',
    'Redeploy the last known-good deploy',
  ]) {
    assert.ok(docs.includes(fragment), `Netlify docs are missing: ${fragment}`);
  }
  assert.match(docs, /smoke/i);
});

test('Netlify constraint is documented as a bounded, GO-ready blast', () => {
  assert.match(docs, /60-second/i);
  assert.match(docs, /messages\/blast/i);
  assert.match(docs, /bounded/i);
  assert.match(docs, /10 recipient/i);
  assert.match(docs, /8,?000\s*ms/i);
  assert.match(docs, /concurrency of 5|5 concurrent/i);
  assert.match(docs, /16,?000\s*ms/i);
  assert.match(docs, /12,?000\s*ms/i);
  assert.match(docs, /\bGO\b/i);
  assert.doesNotMatch(docs, /current blocker/i);
  assert.match(readme, /bounded/i);
  assert.doesNotMatch(readme, /currently blocked|do not enable SMS blasts/i);
});

test('Supabase runbook points to the Netlify hosting runbook and exact health route', () => {
  assert.match(runbook, /docs\/netlify-deployment\.md/);
  assert.match(runbook, /GET \/api\/health/);
  assert.doesNotMatch(runbook, /GET \/api\/health[^\n]*or the configured root health route/i);
});
