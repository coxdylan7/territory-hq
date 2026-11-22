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

test('deployment docs give exact Git-connected Netlify settings for both sites', () => {
  const table = docs.match(/\| Setting \| HQ site \| Portal site \|[\s\S]*?(?=\n\n)/);
  assert.ok(table, 'docs must contain the exact two-site settings table');
  const rows = table[0].split('\n');
  const row = (label) => {
    const found = rows.find((line) => line.startsWith(`| ${label} |`));
    assert.ok(found, `docs settings table is missing ${label}`);
    return found;
  };

  assert.equal(row('Repository'), '| Repository | `coxdylan7/territory-hq` | `coxdylan7/territory-hq` |');
  assert.equal(row('Production branch'), '| Production branch | `main` | `main` |');
  assert.equal(row('Base directory'), '| Base directory | unset (repository root) | `portal` |');
  assert.equal(row('Package directory'), '| Package directory | not required (leave unset) | not required (leave unset) |');
  assert.equal(row('Config file discovered'), '| Config file discovered | `netlify.toml` | `portal/netlify.toml` |');
  assert.equal(row('Publish directory'), '| Publish directory | `web/dist` | `web/dist` |');
  assert.equal(row('Functions directory'), '| Functions directory | `netlify/functions` | `netlify/functions` |');
  assert.equal(row('Node version'), '| Node version | `NODE_VERSION = "22.12.0"` | `NODE_VERSION = "22.12.0"` |');

  const build = row('Build command');
  const commands = build.split('|').map((cell) => cell.trim());
  assert.equal(commands[2], '`npm --prefix api install --no-audit --no-fund && npm --prefix web install --no-audit --no-fund && npm --prefix web run build`');
  assert.equal(commands[3], commands[2], 'Portal build command is relative to its base, not repository-root-relative');

  assert.match(docs, /repository root/i);
  assert.doesNotMatch(docs, /Set Package directory to ["'`]portal["'`]/i, 'no separate package-directory requirement');
  assert.match(docs, /base directory/i);
  assert.match(docs, /`portal\/netlify\.toml`/);
});

test('README mirrors the exact Git-connected base and paths', () => {
  assert.match(readme, /github\.com\/coxdylan7\/territory-hq/);
  const table = readme.match(/\| Site \| Base directory \| Config \| Publish \| Functions \|[\s\S]*?(?=\n\n)/);
  assert.ok(table, 'README must contain the two-site settings table');
  assert.match(table[0], /\| HQ \| repository root \(leave unset\) \| `netlify\.toml` \| `web\/dist` \| `netlify\/functions` \|/);
  assert.match(table[0], /\| Portal \| `portal` \| `portal\/netlify\.toml` \| `web\/dist` \| `netlify\/functions` \|/);
  assert.doesNotMatch(table[0], /\| Portal \|[^\n]*`portal\/web\/dist`/);
  assert.doesNotMatch(table[0], /\| Portal \|[^\n]*`portal\/netlify\/functions`/);
  assert.match(combined, /no separate package directory/i);
});

test('docs confirm shared root function code is bundled from the Portal base', () => {
  assert.match(docs, /esbuild/i);
  assert.match(docs, /repositoryRoot/i);
  assert.match(docs, /static relative import/i);
  assert.match(docs, /serverless-http/);
  assert.match(docs, /@netlify\/aws-lambda-compat/);
  assert.match(docs, /postgres/);
  assert.match(docs, /not duplicated/i);
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
