// Postgres DDL — faithful port of the Turso schema from reference/netlify/functions/api.js
// The two `messages` columns added later in the original are declared up front (fresh DB).
const { sql } = require('./db');

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
    amount DOUBLE PRECISION,
    note TEXT,
    date TEXT
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
    duration_hours DOUBLE PRECISION,
    credits_charged DOUBLE PRECISION,
    status TEXT DEFAULT 'requested',
    ambassador_user_id TEXT,
    notes_client TEXT,
    notes_admin TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,
];

let done = false;

async function ensureSchema() {
  if (done) return;
  for (const stmt of STATEMENTS) {
    await sql.unsafe(stmt);
  }
  done = true;
}

module.exports = { ensureSchema };