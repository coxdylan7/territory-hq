#!/usr/bin/env node
'use strict';

// Read-only preflight for the staged Supabase migrations. It never applies a
// migration, never writes data, and never opens a connection in --dry-run.

const {
  UsageError,
  parseArgs,
  printHelp,
  redactSecrets,
  describeTarget,
} = require('./lib/deployment-target');
const { withReadOnlyClient } = require('./lib/read-only-db');
const {
  BASE_TABLES,
  LEDGER_TABLES,
  expectedMigrations,
  structuralQueries,
  migrationVersionsQuery,
  privilegeQueries,
  legacyQueries,
} = require('./lib/deployment-queries');

const OPTIONS = {
  command: 'scripts/migration-preflight.js',
  allowedEnvironments: ['branch', 'staging'],
};

function line(status, message) {
  process.stdout.write(`${status.padEnd(7)} ${message}\n`);
}

function dryRun(parsed) {
  process.stdout.write('DRY RUN — no connection opened, no query executed\n');
  process.stdout.write(`Target: ${describeTarget(parsed)}\n`);
  process.stdout.write('Connection: [redacted]\n');
  process.stdout.write('Checks (all read-only):\n');
  for (const query of [...structuralQueries(), ...legacyQueries()]) {
    process.stdout.write(`  - ${query.id}: ${query.title}\n`);
  }
  process.stdout.write(`Expected migrations: ${expectedMigrations().join(', ')}\n`);
  process.stdout.write('Production targets are refused; no migration is applied by this script.\n');
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

function evaluate(results) {
  const failures = [];
  const pass = (message) => line('PASS', message);
  const fail = (message) => {
    failures.push(message);
    line('FAIL', message);
  };

  if (!results['history-table'][0] || !results['history-table'][0].present) {
    fail('supabase_migrations.schema_migrations is missing; migration order cannot be proven');
  } else {
    // schema_migrations stores only the numeric version, while the local
    // migration files include a descriptive suffix after an underscore.
    const versionOf = (value) => String(value).split('_')[0];
    const applied = new Set(results.versions.map((row) => versionOf(row.version)));
    const expected = expectedMigrations().map(versionOf);
    for (const version of expected.slice(0, 2)) {
      if (applied.has(version)) pass(`migration ${version} is recorded`);
      else fail(`migration ${version} is not recorded in history`);
    }
    for (const version of expected.slice(2)) {
      line(applied.has(version) ? 'INFO' : 'PENDING', `migration ${version} ${applied.has(version) ? 'is already recorded' : 'is not applied yet'}`);
    }
  }

  const presentTables = new Set(
    results.tables.filter((row) => row.present).map((row) => row.name)
  );
  for (const table of BASE_TABLES) {
    if (presentTables.has(table)) pass(`base table public.${table} exists`);
    else fail(`base table public.${table} is missing`);
  }
  const ledgerPresent = LEDGER_TABLES.filter((table) => presentTables.has(table));
  if (ledgerPresent.length === 0 || ledgerPresent.length === LEDGER_TABLES.length) {
    line('INFO', `ledger tables present: ${ledgerPresent.length}/${LEDGER_TABLES.length}`);
  } else {
    fail(`partial ledger tables: ${ledgerPresent.join(', ')}; resolve before applying migrations`);
  }

  const roleNames = results.roles.map((row) => row.rolname);
  if (!roleNames.length) {
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

  for (const row of results.rls) {
    if (!BASE_TABLES.includes(row.table_name)) continue;
    if (row.relrowsecurity && row.relforcerowsecurity) continue;
    if (!presentTables.has(row.table_name)) continue;
    fail(`public.${row.table_name} does not have RLS enabled and forced`);
  }
  pass('RLS state checked for existing base tables');

  const partialArtifacts = [];
  const artifactGroups = {
    columns: results.columns.map((row) => `${row.table_name}.${row.column_name}`),
    constraints: results.constraints.map((row) => row.conname),
    triggers: results.triggers.map((row) => row.trigger_name),
    indexes: results.indexes.map((row) => row.indexname),
  };
  for (const [kind, found] of Object.entries(artifactGroups)) {
    if (found.length === 0) line('PENDING', `no ledger ${kind} installed yet`);
    else line('INFO', `existing ledger ${kind}: ${found.sort().join(', ')}`);
  }
  if (partialArtifacts.length) failures.push(...partialArtifacts);

  for (const query of legacyQueries()) {
    const row = results[query.id][0] || {};
    if (query.id === 'balance-baseline') {
      line('INFO', `balance baseline rows sampled: ${results[query.id].length}`);
      continue;
    }
    const nonzero = Object.entries(row).filter(([, value]) => Number(value) > 0);
    if (!nonzero.length) {
      pass(`${query.title}: clean`);
    } else {
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
    const failures = evaluate(results);
    if (failures.length) {
      process.stderr.write(`PREFLIGHT FAILED: ${failures.length} issue(s) must be resolved\n`);
      process.exitCode = 1;
    } else {
      line('PASS', 'preflight is clean; continue with the documented staging rehearsal');
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
