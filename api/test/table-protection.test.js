const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// No connection is made: schema.js will be given an injected sql client below.
const { MANAGED_TABLES, makeEnsureSchema, protectionStatements } = require('../src/schema');

const BASE_TABLES = [
  'users', 'sessions', 'accounts', 'expenses', 'settings', 'ocm_seen',
  'kv', 'route_log', 'credits', 'messages', 'portal_users',
  'portal_sessions', 'portal_invites', 'event_types', 'bookings',
];

const LEDGER_TABLES = ['booking_events', 'api_idempotency'];

const EXPECTED_TABLES = [...BASE_TABLES, ...LEDGER_TABLES];

function repoFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

// Simulates Postgres.js sql.begin: everything the callback issues goes through
// the transaction client, with an explicit commit or rollback event.
function transactionalSql(config = {}) {
  const events = [];
  const tx = {
    unsafe: async (statement) => {
      events.push(['ddl', statement]);
      if (config.failOn && config.failOn.test(statement)) throw new Error('protection failed');
    },
  };
  const sql = {
    unsafe: async () => {
      events.push(['outside-transaction']);
      throw new Error('DDL escaped the transaction');
    },
    begin: async (callback) => {
      events.push(['begin']);
      try {
        const result = await callback(tx);
        events.push(['commit']);
        return result;
      } catch (err) {
        events.push(['rollback']);
        throw err;
      }
    },
  };
  return { sql, events };
}

// Pull out the per-table loop from a DO block so we can inspect its control flow.
function loopBody(sql) {
  const match = /\bforeach\b[\s\S]*?\bloop\b([\s\S]*?)\bend\s*loop\b/i.exec(sql);
  assert.ok(match, 'expected a FOREACH loop over the managed tables');
  return match[1];
}

function assertMissingTablesSkipped(sql, label) {
  const body = loopBody(sql);
  const lower = body.toLowerCase();

  assert.match(body, /if\s+to_regclass\s*\(\s*format\s*\(\s*'public\.%i'\s*,\s*app_table\s*\)\s*\)\s+is\s+null\s+then\s+continue\s*;\s*end\s+if\s*;/i,
    `${label}: absent tables must be skipped before any DDL or REVOKE`);

  const guardEnd = lower.indexOf('end if;');
  const firstDdl = Math.min(...['enable row level security', 'alter table', 'revoke all on table'].map((s) => lower.indexOf(s)).filter((i) => i >= 0));
  assert.ok(firstDdl > guardEnd, `${label}: no DDL/REVOKE before the missing-table guard`);

  const revokeIndex = lower.indexOf('revoke all on table');
  assert.ok(revokeIndex > guardEnd, `${label}: REVOKE is not guarded`);
  assert.doesNotMatch(body.slice(0, revokeIndex), /revoke all on table/i, `${label}: only one guarded REVOKE`);
  const loopStart = sql.toLowerCase().indexOf('foreach');
  assert.ok(loopStart >= 0, `${label}: expected a FOREACH loop`);
  assert.doesNotMatch(sql.slice(0, loopStart), /revoke all on table public\.%i/i,
    `${label}: no unconditional table REVOKE outside the loop`);
}

test('the known app table list covers all 17 current tables', () => {
  assert.equal(MANAGED_TABLES.length, 17);
  assert.equal(new Set(MANAGED_TABLES).size, 17);
  assert.deepEqual([...MANAGED_TABLES].sort(), [...EXPECTED_TABLES].sort());
});

test('the security migration protects known app tables without blanket object revokes', () => {
  const sql = repoFile('supabase/migrations/20261122002427_secure_public_data_api.sql');

  for (const table of BASE_TABLES) {
    assert.ok(sql.includes(`'${table}'`), `migration is missing app table ${table}`);
  }
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /revoke all on table public\.%I/i);
  assert.doesNotMatch(sql, /revoke all on all tables in schema public/i);
  assert.doesNotMatch(sql, /revoke all on all sequences in schema public/i);
  assert.doesNotMatch(sql, /revoke all on all functions in schema public/i);
  assert.match(sql, /alter default privileges for role postgres in schema public/i);
  assert.doesNotMatch(sql, /alter default privileges for role postgres\s+revoke execute on functions from public/i);
});

test('default-privilege revokes skip Data API roles that do not exist', () => {
  const sql = repoFile('supabase/migrations/20261122002427_secure_public_data_api.sql');

  assert.doesNotMatch(sql, /revoke all on (tables|sequences|functions) from anon\s*,/i);
  assert.match(sql, /from pg_catalog\.pg_roles/i);
  assert.match(sql, /service_role/i);
  assert.match(sql, /execute format\([^)]*alter default privileges/is);
});

test('the portal schema migration still runs before the security migration', () => {
  const migrations = fs.readdirSync(path.join(__dirname, '../../supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  assert.ok(migrations.indexOf('20240921000000_portal.sql') >= 0);
  assert.ok(migrations.indexOf('20261122002427_secure_public_data_api.sql') > migrations.indexOf('20240921000000_portal.sql'));
});

test('the credit-ledger migration protects its new tables', () => {
  const sql = repoFile('supabase/migrations/20261122010000_credit_ledger.sql');
  for (const table of LEDGER_TABLES) {
    assert.ok(sql.includes(`'${table}'`), `migration is missing ledger table ${table}`);
  }
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /revoke all on table public\.%I/i);
  assertMissingTablesSkipped(sql, 'credit-ledger migration');
});

test('generated protection SQL skips absent tables before RLS or REVOKE', () => {
  const statements = protectionStatements();
  const source = statements.join('\n');
  for (const table of EXPECTED_TABLES) {
    assert.ok(source.includes(`'${table}'`), `runtime protection is missing app table ${table}`);
  }
  assert.doesNotMatch(source, /revoke all on all tables/i, 'no blanket table revokes');
  assert.doesNotMatch(source, /revoke all on all functions/i, 'no blanket function revokes');
  for (const statement of statements) {
    assertMissingTablesSkipped(statement, 'runtime protection');
  }
});

test('the security migration skips absent tables before RLS or REVOKE', () => {
  const sql = repoFile('supabase/migrations/20261122002427_secure_public_data_api.sql');
  assertMissingTablesSkipped(sql, 'security migration');
});

test('ensureSchema creates, migrates and protects tables inside one transaction', async () => {
  const { sql, events } = transactionalSql();
  const ensureSchema = makeEnsureSchema(sql);

  await ensureSchema();

  assert.deepEqual(events.map(([kind]) => kind).filter((k) => k === 'begin' || k === 'commit' || k === 'rollback' || k === 'outside-transaction'),
    ['begin', 'commit'], 'all DDL must run in exactly one transaction');
  const statements = events.filter(([kind]) => kind === 'ddl').map(([, statement]) => statement);
  assert.ok(statements.some((s) => /CREATE TABLE IF NOT EXISTS users/.test(s)));
  assert.ok(statements.some((s) => /UPDATE portal_users SET role/.test(s)), 'migrations must run in the transaction');
  assert.ok(statements.some((s) => /ENABLE ROW LEVEL SECURITY/.test(s)), 'protection must run in the transaction');
  assert.ok(statements.findIndex((s) => /CREATE TABLE/.test(s)) < statements.findIndex((s) => /ENABLE ROW LEVEL SECURITY/.test(s)),
    'protection must follow table creation');
  assert.match(statements[statements.length - 1], /REVOKE ALL ON TABLE/, 'protection must be the last DDL before commit');
  assert.ok(events.findIndex(([kind]) => kind === 'commit') > events.findIndex(([kind]) => kind === 'ddl'),
    'commit must follow all DDL');

  const firstRunCount = statements.length;
  await ensureSchema();
  assert.equal(events.filter(([kind]) => kind === 'ddl').length, firstRunCount, 'second call must be a no-op');
  assert.equal(events.filter(([kind]) => kind === 'begin').length, 1, 'idempotent call must not open a transaction');
});

test('failed protection rolls back and leaves ensureSchema retryable', async () => {
  const state = { failOn: /ENABLE ROW LEVEL SECURITY/ };
  const { sql, events } = transactionalSql(state);
  const ensureSchema = makeEnsureSchema(sql);

  await assert.rejects(ensureSchema(), /protection failed/);
  assert.deepEqual(events.map(([kind]) => kind).filter((k) => k === 'begin' || k === 'commit' || k === 'rollback'), ['begin', 'rollback']);

  state.failOn = null;
  await ensureSchema();
  assert.deepEqual(events.map(([kind]) => kind).filter((k) => k === 'begin' || k === 'commit' || k === 'rollback'),
    ['begin', 'rollback', 'begin', 'commit'], 'retry must re-run the whole transaction');
  await ensureSchema();
  assert.equal(events.filter(([kind]) => kind === 'begin').length, 2, 'successful run must remain idempotent');
});
