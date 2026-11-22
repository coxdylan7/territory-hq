'use strict';

// Read-only catalog and legacy-data queries shared by the preflight and
// post-migration verification scripts. All identifiers come from checked-in
// constants; no operator input is interpolated into SQL.

const fs = require('node:fs');
const path = require('node:path');
const { MANAGED_TABLES } = require(path.join(__dirname, '../../api/src/schema'));
const { repoPath } = require('./deployment-target');

const BASE_TABLES = [
  'users', 'sessions', 'accounts', 'expenses', 'settings', 'ocm_seen',
  'kv', 'route_log', 'credits', 'messages', 'portal_users',
  'portal_sessions', 'portal_invites', 'event_types', 'bookings',
];
const LEDGER_TABLES = ['booking_events', 'api_idempotency'];

const EXPECTED_CREDIT_COLUMNS = [
  'amount_numeric', 'entry_type', 'booking_id', 'source_id', 'idempotency_key',
  'reverses_credit_id', 'actor_type', 'actor_id', 'created_at', 'metadata',
];
const EXPECTED_BOOKING_COLUMNS = [
  'quoted_credits', 'quote_base_hours', 'quote_base_credits',
  'quote_extra_hour_credits', 'requested_by_portal_user_id',
  'created_by_actor_type', 'created_by_actor_id', 'approved_at', 'confirmed_at',
  'declined_at', 'cancelled_at', 'completed_at', 'status_changed_at', 'version',
  'duration_hours_numeric', 'credits_charged_numeric',
];
const EXPECTED_CONSTRAINTS = [
  'credits_entry_type_check', 'credits_amount_numeric_check',
  'credits_booking_entry_shape_check', 'bookings_status_check',
  'bookings_quote_positive_check',
];
const EXPECTED_TRIGGERS = [
  'immutable_credits', 'enforce_booking_refund',
  'immutable_booking_quote', 'enforce_booking_transition',
];
const EXPECTED_INDEXES = [
  'idx_sessions_user', 'idx_accounts_user', 'idx_expenses_user',
  'idx_route_log_user', 'idx_credits_user', 'idx_messages_user',
  'idx_accounts_license', 'credits_booking_entry_unique',
  'credits_idempotency_unique', 'credits_owner_account_created_idx',
  'bookings_owner_status_date_idx', 'bookings_owner_account_date_idx',
  'bookings_owner_ambassador_date_idx', 'event_types_owner_active_name_idx',
  'portal_users_owner_role_status_idx', 'booking_events_owner_booking_created_idx',
  'booking_events_request_unique', 'api_idempotency_created_at_idx',
];

function expectedMigrations() {
  return fs.readdirSync(repoPath('supabase', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => name.replace(/\.sql$/, ''));
}

function literals(values) {
  return values
    .map((value) => {
      if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`unsafe identifier: ${value}`);
      return `'${value}'`;
    })
    .join(', ');
}

function tableRowsQuery(tables) {
  return `SELECT name, to_regclass('public.' || quote_ident(name)) IS NOT NULL AS present
    FROM (VALUES ${tables.map((table) => `('${table}')`).join(', ')}) AS v(name)
    ORDER BY name;`;
}

function structuralQueries() {
  return [
    {
      id: 'history-table',
      title: 'Supabase migration history table',
      sql: `SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS present;`,
    },
    {
      id: 'tables',
      title: 'Managed public tables',
      sql: tableRowsQuery(MANAGED_TABLES),
    },
    {
      id: 'roles',
      title: 'Data API roles present on this server',
      sql: `SELECT rolname FROM pg_catalog.pg_roles
        WHERE rolname IN ('anon', 'authenticated') ORDER BY rolname;`,
    },
    {
      id: 'rls',
      title: 'RLS and FORCE RLS state',
      sql: `SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN (${literals(MANAGED_TABLES)})
        ORDER BY c.relname;`,
    },
    {
      id: 'columns',
      title: 'Ledger columns',
      sql: `SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'credits' AND column_name IN (${literals(EXPECTED_CREDIT_COLUMNS)}))
            OR (table_name = 'bookings' AND column_name IN (${literals(EXPECTED_BOOKING_COLUMNS)}))
          )
        ORDER BY table_name, column_name;`,
    },
    {
      id: 'constraints',
      title: 'Ledger constraints and validation state',
      sql: `SELECT conname, convalidated
        FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND conname IN (${literals(EXPECTED_CONSTRAINTS)})
        ORDER BY conname;`,
    },
    {
      id: 'triggers',
      title: 'Ledger triggers',
      sql: `SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND t.tgname IN (${literals(EXPECTED_TRIGGERS)})
        ORDER BY c.relname, t.tgname;`,
    },
    {
      id: 'indexes',
      title: 'Expected indexes',
      sql: `SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (${literals(EXPECTED_INDEXES)})
        ORDER BY indexname;`,
    },
  ];
}

function migrationVersionsQuery() {
  return `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;`;
}

function privilegeQueries(roles, tables = MANAGED_TABLES) {
  if (!roles.length) return [];
  const rows = [];
  for (const table of tables) {
    for (const role of roles) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(role)) throw new Error(`unsafe role: ${role}`);
      const target = `public.${table}`;
      const privilege = (name) => `has_table_privilege('${role}', '${target}', '${name}') AS can_${name.toLowerCase()}`;
      rows.push(`SELECT '${table}' AS table_name, '${role}' AS role_name,
        ${privilege('SELECT')}, ${privilege('INSERT')}, ${privilege('UPDATE')}, ${privilege('DELETE')}`);
    }
  }
  return [{
    id: 'privileges',
    title: 'Data API table privileges',
    sql: `${rows.join('\nUNION ALL\n')};`,
  }];
}

function legacyQueries() {
  return [
    {
      id: 'legacy-ownership',
      title: 'Null owners, orphan accounts and owner mismatches',
      sql: `SELECT
        (SELECT count(*) FROM public.bookings WHERE owner_user_id IS NULL) AS bookings_null_owner,
        (SELECT count(*) FROM public.credits WHERE user_id IS NULL) AS credits_null_owner,
        (SELECT count(*) FROM public.bookings b
          WHERE b.account_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.accounts a
             WHERE a.id = b.account_id AND a.user_id = b.owner_user_id)) AS bookings_account_owner_mismatch,
        (SELECT count(*) FROM public.credits c
          WHERE c.account_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.accounts a WHERE a.id = c.account_id)) AS credits_orphan_account;`,
    },
    {
      id: 'legacy-shape',
      title: 'Dates, times, durations and statuses',
      sql: `SELECT
        (SELECT count(*) FROM public.bookings
          WHERE date IS NOT NULL AND date <> '' AND date !~ '^\\d{4}-\\d{2}-\\d{2}$') AS invalid_dates,
        (SELECT count(*) FROM public.bookings
          WHERE start_time IS NOT NULL AND start_time <> ''
            AND start_time !~ '^([01]\\d|2[0-3]):[0-5]\\d$') AS invalid_times,
        (SELECT count(*) FROM public.bookings
          WHERE status IS NULL OR status NOT IN
            ('requested','approved','confirmed','declined','cancelled','completed')) AS unknown_statuses,
        (SELECT count(*) FROM public.bookings
          WHERE duration_hours IS NULL OR duration_hours <= 0 OR duration_hours > 24) AS bad_durations;`,
    },
    {
      id: 'legacy-money',
      title: 'Amounts, quote snapshots and charged quotes',
      sql: `SELECT
        (SELECT count(*) FROM public.credits WHERE amount = 0) AS zero_amounts,
        (SELECT count(*) FROM public.credits
          WHERE amount IS NOT NULL AND amount <> round(amount::numeric, 2)) AS subcent_amounts,
        (SELECT count(*) FROM public.bookings WHERE quoted_credits IS NULL) AS null_quotes,
        (SELECT count(*) FROM public.bookings
          WHERE status IN ('confirmed','completed')
            AND credits_charged IS DISTINCT FROM quoted_credits) AS charged_quote_mismatch;`,
    },
    {
      id: 'legacy-duplicates',
      title: 'Duplicate ledger entries and idempotency keys',
      sql: `SELECT
        (SELECT count(*) FROM (
          SELECT booking_id FROM public.credits
           WHERE entry_type IN ('booking_charge','booking_refund')
           GROUP BY booking_id HAVING count(*) > 1) d) AS duplicate_booking_entries,
        (SELECT count(*) FROM public.credits r
          WHERE r.entry_type = 'booking_refund' AND NOT EXISTS (
            SELECT 1 FROM public.credits c
             WHERE c.entry_type = 'booking_charge' AND c.booking_id = r.booking_id)) AS refunds_without_charge,
        (SELECT count(*) FROM (
          SELECT user_id, idempotency_key FROM public.credits
           WHERE idempotency_key IS NOT NULL
           GROUP BY user_id, idempotency_key HAVING count(*) > 1) d) AS duplicate_idempotency_keys;`,
    },
    {
      id: 'legacy-overlaps',
      title: 'Live account overlaps (one-minute granularity)',
      sql: `WITH live AS (
        SELECT id, owner_user_id, account_id, date, start_time,
               COALESCE(duration_hours_numeric, duration_hours::numeric) AS hours
          FROM public.bookings
         WHERE status IN ('requested','approved','confirmed')
           AND date ~ '^\\d{4}-\\d{2}-\\d{2}$'
           AND start_time ~ '^([01]\\d|2[0-3]):[0-5]\\d$'
           AND COALESCE(duration_hours_numeric, duration_hours::numeric) > 0
      )
      SELECT count(*) AS overlapping_pairs
        FROM live a
        JOIN live b
          ON a.id < b.id
         AND a.owner_user_id = b.owner_user_id
         AND a.account_id = b.account_id
         AND a.date = b.date
         AND (a.start_time::time + a.hours * interval '1 hour') > b.start_time::time
         AND (b.start_time::time + b.hours * interval '1 hour') > a.start_time::time;`,
    },
    {
      id: 'balance-baseline',
      title: 'Per-account legacy versus numeric balance baseline',
      sql: `SELECT user_id, account_id, count(*) AS entries,
               sum(amount)::text AS legacy_sum,
               sum(amount_numeric)::text AS numeric_sum
          FROM public.credits
         GROUP BY user_id, account_id
         ORDER BY user_id, account_id
         LIMIT 200;`,
    },
  ];
}

module.exports = {
  BASE_TABLES,
  LEDGER_TABLES,
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
};
