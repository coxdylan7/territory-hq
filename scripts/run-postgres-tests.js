#!/usr/bin/env node
'use strict';

// Runs the optional real-Postgres suite only when TEST_DATABASE_URL is set.
// The value is passed through to the child process and is never printed.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const testUrl = (process.env.TEST_DATABASE_URL || '').trim();
if (!testUrl) {
  process.stdout.write('TEST_DATABASE_URL is not set; skipping optional PostgreSQL integration tests.\n');
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  ['--test', 'test/postgres-integration.test.js'],
  {
    cwd: path.join(__dirname, '..', 'api'),
    stdio: 'inherit',
    env: process.env,
  }
);

if (result.error) {
  process.stderr.write(`Could not start the PostgreSQL integration suite: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
