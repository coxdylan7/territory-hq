'use strict';

// All database access used by the deployment scripts is read-only and runs
// inside an explicit READ ONLY transaction. No data-modifying SQL is present
// in this repository helper.

const path = require('node:path');
const { createRequire } = require('node:module');
const { redactSecrets, repoPath } = require('./deployment-target');

function assertReadOnlySql(text) {
  const withoutComments = String(text).replace(/--[^\n]*/g, '').trim();
  if (!/^(select|with)\b/i.test(withoutComments)) {
    throw new Error('only SELECT statements are allowed');
  }
  const single = withoutComments.replace(/;\s*$/, '');
  if (single.includes(';')) {
    throw new Error('only one statement per query is allowed');
  }
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|vacuum|analyze|refresh|set|reset|begin|commit|rollback)\b/i.test(single)) {
    throw new Error('data-modifying or session-changing SQL is not allowed');
  }
  return text;
}

function loadPostgres() {
  // The API package owns the postgres dependency. Resolve through its manifest
  // so the root-level scripts do not need a separate install or lockfile.
  const requireFromApi = createRequire(path.join(repoPath('api'), 'package.json'));
  return requireFromApi('postgres');
}

async function withReadOnlyClient(dbUrl, work) {
  const postgres = loadPostgres();
  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: 'territory-readonly-verify' },
  });

  let inTransaction = false;
  try {
    await sql.unsafe('BEGIN READ ONLY');
    inTransaction = true;
    const result = await work({
      async query(text) {
        return sql.unsafe(assertReadOnlySql(text));
      },
      async scalar(text) {
        const rows = await sql.unsafe(assertReadOnlySql(text));
        return rows.length ? Object.values(rows[0])[0] : null;
      },
    });
    await sql.unsafe('ROLLBACK');
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) {
      try {
        await sql.unsafe('ROLLBACK');
      } catch {
        // The original failure is the useful one; keep it.
      }
    }
    const safe = redactSecrets(error && error.message ? error.message : String(error), dbUrl);
    throw new Error(`read-only database check failed: ${safe}`);
  } finally {
    try {
      await sql.end({ timeout: 2 });
    } catch {
      // Connection teardown must not mask a check result.
    }
  }
}

module.exports = { assertReadOnlySql, withReadOnlyClient };
