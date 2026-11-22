'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptsDir = path.join(__dirname, '..', 'scripts');
const scripts = ['migration-preflight.js', 'post-migration-verify.js'];
const libDir = path.join(scriptsDir, 'lib');

function run(script, args = [], options = {}) {
  return spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function combined(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

const EXPLICIT_ARGS = [
  '--environment', 'staging',
  '--confirm-environment', 'staging',
  '--project-ref', 'abcdefghijklmnopqrst',
  '--db-url', 'postgres://deploy_user:s3cr3t-value@db.example.test:6543/postgres',
];

test('both deployment scripts expose help without connecting', () => {
  for (const script of scripts) {
    const result = run(script, ['--help']);
    assert.equal(result.status, 0, `${script}: ${combined(result)}`);
    for (const flag of ['--environment', '--confirm-environment', '--project-ref', '--db-url', '--dry-run']) {
      assert.match(result.stdout, new RegExp(flag.replace(/[-]/g, '\\-')), `${script} help is missing ${flag}`);
    }
    assert.doesNotMatch(combined(result), /postgres:\/\/[^/\s]+:[^@\s]+@/, 'help must not contain credentials');
  }
});

test('both deployment scripts fail closed with no arguments', () => {
  for (const script of scripts) {
    const result = run(script);
    assert.notEqual(result.status, 0, `${script} accepted implicit defaults`);
    assert.match(result.stderr, /missing explicit inputs/);
    assert.doesNotMatch(combined(result), /postgres:\/\/[^/\s]+:[^@\s]+@/);
  }
});

test('both deployment scripts redact the connection string in dry-run mode', () => {
  for (const script of scripts) {
    const result = run(script, [...EXPLICIT_ARGS, '--dry-run']);
    assert.equal(result.status, 0, `${script}: ${combined(result)}`);
    assert.match(result.stdout, /\[redacted\]/);
    assert.match(result.stdout, /environment=staging/);
    assert.match(result.stdout, /project-ref=abcdefghijklmnopqrst/);
    assert.doesNotMatch(combined(result), /s3cr3t-value/);
    assert.doesNotMatch(combined(result), /db\.example\.test/);
    assert.doesNotMatch(combined(result), /postgres:\/\/[^/\s]+:[^@\s]+@/);
  }
});

test('preflight refuses a production target and mismatched confirmation', () => {
  const production = run('migration-preflight.js', [
    '--environment', 'production',
    '--confirm-environment', 'production',
    '--project-ref', 'abcdefghijklmnopqrst',
    '--db-url', 'postgres://u:p@db.example.test:5432/postgres',
    '--dry-run',
  ]);
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /environment must be one of/);

  const mismatch = run('post-migration-verify.js', [
    '--environment', 'staging',
    '--confirm-environment', 'production',
    '--project-ref', 'abcdefghijklmnopqrst',
    '--db-url', 'postgres://u:p@db.example.test:5432/postgres',
    '--dry-run',
  ]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /must exactly repeat/);
});

test('post-migration verify allows production only with explicit repeated confirmation', () => {
  const result = run('post-migration-verify.js', [
    '--environment', 'production',
    '--confirm-environment', 'production',
    '--project-ref', 'abcdefghijklmnopqrst',
    '--db-url', 'postgres://u:p@db.example.test:5432/postgres',
    '--dry-run',
  ]);
  assert.equal(result.status, 0, combined(result));
  assert.match(result.stdout, /environment=production/);
});

test('deployment scripts never use implicit database or project configuration', () => {
  const files = [
    ...scripts.map((name) => path.join(scriptsDir, name)),
    ...fs.readdirSync(libDir).map((name) => path.join(libDir, name)),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /process\.env\.DATABASE_URL/, `${file} reads DATABASE_URL implicitly`);
    assert.doesNotMatch(source, /process\.env\.SUPABASE/, `${file} reads Supabase config implicitly`);
    assert.doesNotMatch(source, /supabase\s+db\s+push/, `${file} can apply migrations`);
    assert.doesNotMatch(source, /spawn(?:Sync)?\s*\(/, `${file} launches subprocesses`);
  }
  const allSource = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.match(allSource, /--confirm-environment/, 'explicit typed confirmation is not implemented');
  assert.match(allSource, /--project-ref/, 'explicit project input is not implemented');
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(scriptsDir, script), 'utf8');
    assert.doesNotMatch(source, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE)\b/i, `${script} contains data-modifying SQL`);
  }
});

test('deployment scripts are executable files with shebangs', () => {
  for (const script of scripts) {
    const file = path.join(scriptsDir, script);
    assert.match(fs.readFileSync(file, 'utf8'), /^#!\/usr\/bin\/env node/);
    assert.ok(fs.statSync(file).mode & 0o111, `${script} is not executable`);
  }
});
