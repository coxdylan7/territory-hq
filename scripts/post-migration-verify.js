#!/usr/bin/env node
'use strict';

// Read-only post-migration verification. Production is allowed only when it is
// named explicitly and repeated as confirmation; there is no default target.

const {
  UsageError,
  parseArgs,
  printHelp,
  redactSecrets,
  describeTarget,
} = require('./lib/deployment-target');
const { withReadOnlyClient } = require('./lib/read-only-db');
const {
  MANAGED_TABLES,
  EXPECTED_CREDIT_COLUMNS,
  EXPECTED_BOOKING_COLUMNS,
  EXPECTED_CONSTRAINTS,
  EXPECTED_TRIGGERS,
  EXPECTED_INDEXES,
  expectedMigrations,
  structuralQueries,
  migrationVersionsQuery,
  privilegeQueries,
  legacyQueries,
} = require('./lib/deployment-queries');

const OPTIONS = {
  command: 'scripts/post-migration-verify.js',
  allowedEnvironments: ['branch', 'staging', 'production'],
  supportsValidatedFlag: true,
};

function line(status, message) {
  process.stdout.write(`${status.padEnd(7)} ${message}\n`);
}

function dryRun(parsed) {
  process.stdout.write('DRY RUN — no connection opened, no query executed\n');
  process.stdout.write(`Target: ${describeTarget(parsed)}\n`);
  process.stdout.write('Connection: [redacted]\n');
  process.stdout.write(`Validated constraints required: ${parsed.requireValidatedConstraints ? 'yes' : 'no (NOT VALID reported only)'}\n`);
  process.stdout.write('Checks (all read-only):\n');
  for (const query of [...structuralQueries(), ...legacyQueries()]) {
    process.stdout.write(`  - ${query.id}: ${query.title}\n`);
  }
  process.stdout.write(`Expected migrations: ${expectedMigrations().join(', ')}\n`);
  process.stdout.write('This script never applies migrations or changes data.\n');
}

async function collect(db) {
  const results = {};
  for (const query of structuralQueries()) {
    results[query.id] = await db.query(query.sql);
  }
  if (results['history-table'][0] && results['history-table'][0].present) {
    results.versions = await db.query(migrationVersionsQuery());
  }
  const roles = results.roles.map((row) => row.rolname);
  const presentTables = results.tables.filter((row) => row.present).map((row) => row.name);
  for (const query of privilegeQueries(roles, presentTables)) {
    results[query.id] = await db.query(query.sql);
  }
  for (const query of legacyQueries()) {
    results[query.id] = await db.query(query.sql);
  }
  return results;
}

function evaluate(results, requireValidatedConstraints) {
  const failures = [];
  const pass = (message) => line('PASS', message);
  const fail = (message) => {
    failures.push(message);
    line('FAIL', message);
  };

  if (!results['history-table'][0] || !results['history-table'][0].present) {
    fail('supabase_migrations.schema_migrations is missing');
  } else {
    const versionOf = (value) => String(value).split('_')[0];
    const applied = new Set(results.versions.map((row) => versionOf(row.version)));
    const expected = expectedMigrations().map(versionOf);
    for (const version of expected) {
      if (applied.has(version)) pass(`migration ${version} is recorded`);
      else fail(`migration ${version} is missing from history`);
    }
    for (const version of applied) {
      if (!expected.includes(version)) {
        line('INFO', `additional history entry: ${version}`);
      }
    }
  }

  const present = new Set(results.tables.filter((row) => row.present).map((row) => row.name));
  for (const table of MANAGED_TABLES) {
    if (present.has(table)) pass(`table public.${table} exists`);
    else fail(`table public.${table} is missing`);
  }

  const rlsByTable = new Map(results.rls.map((row) => [row.table_name, row]));
  for (const table of MANAGED_TABLES) {
    const row = rlsByTable.get(table);
    if (!row || !row.relrowsecurity || !row.relforcerowsecurity) {
      fail(`public.${table} must have RLS enabled and forced`);
    }
  }
  if (!failures.length) pass('RLS is enabled and forced on all managed tables');

  const roles = results.roles.map((row) => row.rolname);
  if (!roles.length) {
    line('INFO', 'no anon/authenticated roles on this server; Data API checks not applicable');
  } else {
    const exposed = (results.privileges || []).filter((row) =>
      row.can_select || row.can_insert || row.can_update || row.can_delete
    );
    if (!exposed.length) pass('anon/authenticated hold no table privileges on managed tables');
    else {
      for (const row of exposed) {
        fail(`Data API role ${row.role_name} still has privileges on public.${row.table_name}`);
      }
    }
  }

  const columnKeys = new Set(results.columns.map((row) => `${row.table_name}.${row.column_name}`));
  for (const column of EXPECTED_CREDIT_COLUMNS) {
    if (!columnKeys.has(`credits.${column}`)) fail(`credits.${column} is missing`);
  }
  for (const column of EXPECTED_BOOKING_COLUMNS) {
    if (!columnKeys.has(`bookings.${column}`)) fail(`bookings.${column} is missing`);
  }

  const constraints = new Map(results.constraints.map((row) => [row.conname, row]));
  for (const name of EXPECTED_CONSTRAINTS) {
    const row = constraints.get(name);
    if (!row) {
      fail(`constraint ${name} is missing`);
    } else if (requireValidatedConstraints && !row.convalidated) {
      fail(`constraint ${name} is still NOT VALID`);
    } else {
      line(row.convalidated ? 'PASS' : 'INFO', `constraint ${name} ${row.convalidated ? 'is validated' : 'is intentionally NOT VALID (deferred preflight)'}`);
    }
  }

  const triggers = new Set(results.triggers.map((row) => row.trigger_name));
  for (const name of EXPECTED_TRIGGERS) {
    if (!triggers.has(name)) fail(`trigger ${name} is missing or disabled`);
    else pass(`trigger ${name} is installed`);
  }

  const indexes = new Set(results.indexes.map((row) => row.indexname));
  for (const name of EXPECTED_INDEXES) {
    if (!indexes.has(name)) fail(`index ${name} is missing`);
  }
  if (indexes.size === EXPECTED_INDEXES.length) {
    pass('all expected indexes exist');
  }

  for (const query of legacyQueries()) {
    const row = results[query.id][0] || {};
    if (query.id === 'balance-baseline') {
      line('INFO', `balance baseline rows sampled: ${results[query.id].length}`);
      continue;
    }
    const nonzero = Object.entries(row).filter(([, value]) => Number(value) > 0);
    if (!nonzero.length) pass(`${query.title}: clean`);
    else {
      for (const [key, value] of nonzero) {
        fail(`${query.title}: ${key}=${value}`);
      }
    }
  }

  return failures;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2), OPTIONS);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`ERROR: ${error.message}\n\n`);
      printHelp(OPTIONS, process.stderr);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (parsed.help) {
    printHelp(OPTIONS);
    return;
  }
  if (parsed.dryRun) {
    dryRun(parsed);
    return;
  }

  try {
    const results = await withReadOnlyClient(parsed.dbUrl, collect);
    const failures = evaluate(results, parsed.requireValidatedConstraints);
    if (failures.length) {
      process.stderr.write(`VERIFICATION FAILED: ${failures.length} issue(s)\n`);
      process.exitCode = 1;
    } else {
      line('PASS', 'post-migration verification is clean');
    }
  } catch (error) {
    process.stderr.write(`ERROR: ${redactSecrets(error.message, parsed.dbUrl)}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${redactSecrets(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
});
