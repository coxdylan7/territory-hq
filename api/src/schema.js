// Postgres DDL for the HQ application tables
// The two `messages` columns added later in the original are declared up front (fresh DB).

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    pass_hash TEXT,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'pending',
    sub_expires TEXT,
    plan TEXT DEFAULT 'standard',
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT,
    expires TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT,
    dba TEXT,
    address TEXT,
    city TEXT,
    county TEXT,
    phone TEXT,
    email TEXT,
    contact_name TEXT,
    status TEXT,
    priority INTEGER DEFAULT 0,
    priority_rank INTEGER DEFAULT 1,
    notes TEXT,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    source TEXT,
    license_number TEXT,
    last_visited TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    date TEXT,
    category TEXT,
    amount DOUBLE PRECISION,
    miles DOUBLE PRECISION,
    notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY,
    home_address TEXT,
    home_lat DOUBLE PRECISION,
    home_lng DOUBLE PRECISION,
    counties TEXT DEFAULT '[]',
    work_days TEXT DEFAULT '["Mon","Tue","Wed","Thu","Fri"]',
    mileage_rate DOUBLE PRECISION DEFAULT 0.70,
    gmaps_key TEXT DEFAULT '',
    default_credit DOUBLE PRECISION DEFAULT 0,
    alert_email TEXT DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS ocm_seen (
    user_id TEXT,
    license_number TEXT,
    PRIMARY KEY (user_id, license_number)
  )`,
  `CREATE TABLE IF NOT EXISTS kv (
    user_id TEXT,
    key TEXT,
    value TEXT,
    PRIMARY KEY (user_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS route_log (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    date TEXT,
    day TEXT,
    stops TEXT,
    miles DOUBLE PRECISION,
    minutes DOUBLE PRECISION,
    dismissed INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS credits (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    account_id TEXT,
    account_name TEXT,
    license_number TEXT,
    city TEXT,
    -- Legacy amount remains readable. New writes always populate both values.
    amount DOUBLE PRECISION,
    amount_numeric NUMERIC(14,2),
    note TEXT,
    date TEXT,
    entry_type TEXT,
    booking_id TEXT,
    source_id TEXT,
    idempotency_key TEXT,
    reverses_credit_id TEXT,
    actor_type TEXT,
    actor_id TEXT,
    -- Nullable for legacy rows; new writes receive now() from the column default.
    created_at TIMESTAMPTZ DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The explicit NULL branches mirror 20261122010000_credit_ledger.sql.
    -- CHECK treats NULL as unknown (allowed), but spelling it out prevents
    -- fresh-install and migrated-install parity from depending on that detail.
    CONSTRAINT credits_entry_type_check CHECK (entry_type IS NULL OR entry_type IN
      ('grant', 'adjustment', 'booking_charge', 'booking_refund', 'migration')),
    CONSTRAINT credits_amount_numeric_check CHECK (
      amount_numeric IS NULL
      OR (amount_numeric <> 0 AND amount_numeric = round(amount_numeric, 2))
    ),
    CONSTRAINT credits_booking_entry_shape_check CHECK (
      entry_type IS NULL
      OR entry_type NOT IN ('booking_charge', 'booking_refund')
      OR (
        booking_id IS NOT NULL
        AND (
          (entry_type = 'booking_charge' AND amount_numeric < 0)
          OR (entry_type = 'booking_refund' AND amount_numeric > 0 AND reverses_credit_id IS NOT NULL)
        )
      )
    )
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    account_id TEXT,
    account_name TEXT,
    license_number TEXT,
    city TEXT,
    channel TEXT,
    purpose TEXT,
    body TEXT,
    recipient TEXT,
    direction TEXT,
    date TEXT,
    status TEXT DEFAULT 'logged',
    blast_id TEXT
  )`,
  // Store portal: portal users (clients who spend credits + staff who staff events)
  `CREATE TABLE IF NOT EXISTS portal_users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    pass_hash TEXT,
    role TEXT DEFAULT 'client',
    status TEXT DEFAULT 'active',
    account_id TEXT,
    owner_user_id TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS portal_sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT,
    expires TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS portal_invites (
    id TEXT PRIMARY KEY,
    email TEXT,
    role TEXT DEFAULT 'client',
    account_id TEXT,
    owner_user_id TEXT,
    token TEXT UNIQUE,
    expires TEXT,
    used_at TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS event_types (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    name TEXT,
    description TEXT,
    base_hours DOUBLE PRECISION DEFAULT 4,
    base_price_credits DOUBLE PRECISION DEFAULT 0,
    extra_hour_credits DOUBLE PRECISION DEFAULT 0,
    active INTEGER DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    account_id TEXT,
    account_name TEXT,
    license_number TEXT,
    event_type_id TEXT,
    event_type_name TEXT,
    date TEXT,
    start_time TEXT,
    -- Legacy columns remain display snapshots; new writes also set typed values.
    duration_hours DOUBLE PRECISION,
    duration_hours_numeric NUMERIC(8,2),
    credits_charged DOUBLE PRECISION,
    credits_charged_numeric NUMERIC(14,2),
    status TEXT DEFAULT 'requested',
    ambassador_user_id TEXT,
    notes_client TEXT,
    notes_admin TEXT,
    quoted_credits NUMERIC(14,2),
    quote_base_hours NUMERIC(8,2),
    quote_base_credits NUMERIC(14,2),
    quote_extra_hour_credits NUMERIC(14,2),
    requested_by_portal_user_id TEXT,
    created_by_actor_type TEXT,
    created_by_actor_id TEXT,
    approved_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    declined_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    status_changed_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT,
    updated_at TEXT,
    CONSTRAINT bookings_status_check CHECK (status IN (
      'requested', 'approved', 'confirmed', 'declined', 'cancelled', 'completed'
    )),
    CONSTRAINT bookings_quote_positive_check CHECK (quoted_credits IS NULL OR quoted_credits > 0)
  )`,
  `CREATE INDEX IF NOT EXISTS bookings_owner_status_date_idx
     ON bookings (owner_user_id, status, date, start_time)`,
  `CREATE INDEX IF NOT EXISTS bookings_owner_account_date_idx
     ON bookings (owner_user_id, account_id, date)`,
  `CREATE INDEX IF NOT EXISTS bookings_owner_ambassador_date_idx
     ON bookings (owner_user_id, ambassador_user_id, date)
     WHERE ambassador_user_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS event_types_owner_active_name_idx
     ON event_types (owner_user_id, active, name)`,
  `CREATE INDEX IF NOT EXISTS portal_users_owner_role_status_idx
     ON portal_users (owner_user_id, id, role, status)`,
  `CREATE INDEX IF NOT EXISTS credits_owner_account_created_idx
     ON credits (user_id, account_id, created_at, id)`,
  // Indexes from 20240918000000_init.sql, kept here so a fresh runtime schema
  // has the same access paths as a database built by the migration chain.
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_route_log_user ON route_log (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_credits_user ON credits (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_user ON messages (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_license ON accounts (user_id, license_number)`,
  `CREATE TABLE IF NOT EXISTS booking_events (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    request_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS booking_events_owner_booking_created_idx
     ON booking_events (owner_user_id, booking_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS booking_events_request_unique
     ON booking_events (owner_user_id, request_id, action)
     WHERE request_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS api_idempotency (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    UNIQUE (owner_user_id, actor_type, actor_id, operation, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS api_idempotency_created_at_idx
     ON api_idempotency (created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS credits_booking_entry_unique
     ON credits (user_id, booking_id, entry_type)
     WHERE booking_id IS NOT NULL
       AND entry_type IN ('booking_charge', 'booking_refund')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS credits_idempotency_unique
     ON credits (user_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL`,
  `CREATE OR REPLACE FUNCTION immutable_credits_guard()
     RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'credits is an append-only ledger' USING ERRCODE = '23514';
   END;
   $$`,
  `DROP TRIGGER IF EXISTS immutable_credits ON credits`,
  `CREATE TRIGGER immutable_credits
     BEFORE UPDATE OR DELETE ON credits
     FOR EACH ROW EXECUTE FUNCTION immutable_credits_guard()`,
  `CREATE OR REPLACE FUNCTION enforce_booking_refund_guard()
     RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     charge credits%ROWTYPE;
   BEGIN
     IF NEW.entry_type IS DISTINCT FROM 'booking_refund' THEN
       RETURN NEW;
     END IF;
     IF NEW.reverses_credit_id IS NULL OR NEW.booking_id IS NULL THEN
       RAISE EXCEPTION 'booking refund must name its original charge and booking' USING ERRCODE = '23514';
     END IF;
     SELECT * INTO charge FROM credits WHERE id = NEW.reverses_credit_id FOR SHARE;
     IF NOT FOUND OR charge.entry_type IS DISTINCT FROM 'booking_charge' THEN
       RAISE EXCEPTION 'booking refund must reverse a booking charge' USING ERRCODE = '23514';
     END IF;
     IF charge.booking_id IS DISTINCT FROM NEW.booking_id
        OR charge.user_id IS DISTINCT FROM NEW.user_id
        OR charge.account_id IS DISTINCT FROM NEW.account_id THEN
       RAISE EXCEPTION 'booking refund must match the charge owner, account and booking' USING ERRCODE = '23514';
     END IF;
     IF charge.amount_numeric IS NULL
        OR NEW.amount_numeric IS NULL
        OR NEW.amount_numeric <> -charge.amount_numeric THEN
       RAISE EXCEPTION 'booking refund must exactly negate the original charge' USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END;
   $$`,
  `DROP TRIGGER IF EXISTS enforce_booking_refund ON credits`,
  `CREATE TRIGGER enforce_booking_refund
     BEFORE INSERT OR UPDATE ON credits
     FOR EACH ROW EXECUTE FUNCTION enforce_booking_refund_guard()`,
  `CREATE OR REPLACE FUNCTION immutable_booking_quote_guard()
     RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
        OR NEW.account_id IS DISTINCT FROM OLD.account_id
        OR NEW.event_type_id IS DISTINCT FROM OLD.event_type_id
        OR NEW.event_type_name IS DISTINCT FROM OLD.event_type_name
        OR NEW.date IS DISTINCT FROM OLD.date
        OR NEW.start_time IS DISTINCT FROM OLD.start_time
        OR NEW.duration_hours IS DISTINCT FROM OLD.duration_hours
        OR NEW.duration_hours_numeric IS DISTINCT FROM OLD.duration_hours_numeric
        OR NEW.requested_by_portal_user_id IS DISTINCT FROM OLD.requested_by_portal_user_id
        OR NEW.created_by_actor_type IS DISTINCT FROM OLD.created_by_actor_type
        OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id THEN
       RAISE EXCEPTION 'booking quote snapshots are immutable' USING ERRCODE = '23514';
     END IF;

     -- Allow one-time legacy quote backfill: all four snapshots start NULL and
     -- are completed together. Afterwards OLD values are non-NULL, so this
     -- branch cannot run again and every later quote change is rejected.
     IF OLD.quoted_credits IS NULL
        AND OLD.quote_base_hours IS NULL
        AND OLD.quote_base_credits IS NULL
        AND OLD.quote_extra_hour_credits IS NULL
        AND NEW.quoted_credits IS NOT NULL
        AND NEW.quote_base_hours IS NOT NULL
        AND NEW.quote_base_credits IS NOT NULL
        AND NEW.quote_extra_hour_credits IS NOT NULL THEN
       RETURN NEW;
     END IF;

     IF NEW.quoted_credits IS DISTINCT FROM OLD.quoted_credits
        OR NEW.quote_base_hours IS DISTINCT FROM OLD.quote_base_hours
        OR NEW.quote_base_credits IS DISTINCT FROM OLD.quote_base_credits
        OR NEW.quote_extra_hour_credits IS DISTINCT FROM OLD.quote_extra_hour_credits THEN
       RAISE EXCEPTION 'booking quote snapshots are immutable' USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END;
   $$`,
  `CREATE OR REPLACE FUNCTION fill_legacy_booking_quote(
     p_booking_id TEXT,
     p_quoted_credits NUMERIC,
     p_base_hours NUMERIC,
     p_base_credits NUMERIC,
     p_extra_hour_credits NUMERIC
   ) RETURNS boolean LANGUAGE plpgsql AS $$
   BEGIN
     UPDATE bookings
        SET quoted_credits = p_quoted_credits,
            quote_base_hours = p_base_hours,
            quote_base_credits = p_base_credits,
            quote_extra_hour_credits = p_extra_hour_credits
      WHERE id = p_booking_id
        AND quoted_credits IS NULL
        AND quote_base_hours IS NULL
        AND quote_base_credits IS NULL
        AND quote_extra_hour_credits IS NULL;
     RETURN FOUND;
   END;
   $$`,
  `DROP TRIGGER IF EXISTS immutable_booking_quote ON bookings`,
  `CREATE TRIGGER immutable_booking_quote
     BEFORE UPDATE ON bookings
     FOR EACH ROW EXECUTE FUNCTION immutable_booking_quote_guard()`,
  `CREATE OR REPLACE FUNCTION enforce_booking_transition_guard()
     RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.status IS DISTINCT FROM OLD.status THEN
       IF OLD.status = 'requested'
          AND NEW.status IN ('approved', 'declined', 'cancelled') THEN
         RETURN NEW;
       ELSIF OLD.status = 'approved'
             AND NEW.status IN ('confirmed', 'cancelled', 'approved') THEN
         RETURN NEW;
       ELSIF OLD.status = 'confirmed'
             AND NEW.status IN ('cancelled', 'completed', 'approved') THEN
         RETURN NEW;
       END IF;
       RAISE EXCEPTION 'invalid booking transition: % -> %', OLD.status, NEW.status
         USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END;
   $$`,
  `DROP TRIGGER IF EXISTS enforce_booking_transition ON bookings`,
  `CREATE TRIGGER enforce_booking_transition
     BEFORE UPDATE ON bookings
     FOR EACH ROW EXECUTE FUNCTION enforce_booking_transition_guard()`,
  // migrate legacy portal roles to the new role set (idempotent)
  `UPDATE portal_users SET role = 'store_manager' WHERE role = 'client'`,
  `UPDATE portal_users SET role = 'brand_ambassador' WHERE role = 'staff'`,
  `UPDATE portal_invites SET role = 'store_manager' WHERE role = 'client'`,
  `UPDATE portal_invites SET role = 'brand_ambassador' WHERE role = 'staff'`,
];

// Runtime-created tables must get the same protection as migrated tables. The
// list is intentionally explicit: never revoke on every public object.
const MANAGED_TABLES = [
  'users', 'sessions', 'accounts', 'expenses', 'settings', 'ocm_seen',
  'kv', 'route_log', 'credits', 'messages', 'portal_users',
  'portal_sessions', 'portal_invites', 'event_types', 'bookings',
  'booking_events', 'api_idempotency',
];

function protectionStatements() {
  return [`
DO $$
DECLARE
  app_table text;
  api_roles text;
BEGIN
  SELECT string_agg(format('%I', rolname), ', ' ORDER BY rolname)
    INTO api_roles
    FROM pg_catalog.pg_roles
   WHERE rolname IN ('anon', 'authenticated');

  FOREACH app_table IN ARRAY ARRAY[
    ${MANAGED_TABLES.map((table) => `'${table}'`).join(', ')}
  ]::text[]
  LOOP
    -- A managed table may be absent (e.g. an old install). REVOKE on a missing
    -- table errors, so skip it entirely rather than relying on IF EXISTS.
    IF to_regclass(format('public.%I', app_table)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', app_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', app_table);
    IF api_roles IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %s', app_table, api_roles);
    END IF;
  END LOOP;
END $$;`];
}

function makeEnsureSchema(sql) {
  let done = false;
  return async function ensureSchema() {
    if (done) return;
    // One transaction: newly created tables cannot be exposed between DDL and
    // RLS/REVOKE protection. `done` is only set after commit, so a failed boot
    // can safely retry the whole sequence.
    await sql.begin(async (tx) => {
      for (const stmt of STATEMENTS) {
        await tx.unsafe(stmt);
      }
      for (const stmt of protectionStatements()) {
        await tx.unsafe(stmt);
      }
    });
    done = true;
  };
}

let defaultEnsureSchema;
function ensureSchema() {
  if (!defaultEnsureSchema) defaultEnsureSchema = makeEnsureSchema(require('./db').sql);
  return defaultEnsureSchema();
}

module.exports = {
  ensureSchema,
  makeEnsureSchema,
  MANAGED_TABLES,
  protectionStatements,
};
