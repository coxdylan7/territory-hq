-- Territory HQ — store portal schema
-- Source of truth: api/src/schema.js

CREATE TABLE IF NOT EXISTS portal_users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  pass_hash TEXT,
  role TEXT DEFAULT 'client',
  status TEXT DEFAULT 'active',
  account_id TEXT,
  owner_user_id TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT,
  expires TEXT
);

CREATE TABLE IF NOT EXISTS portal_invites (
  id TEXT PRIMARY KEY,
  email TEXT,
  role TEXT DEFAULT 'client',
  account_id TEXT,
  owner_user_id TEXT,
  token TEXT UNIQUE,
  expires TEXT,
  used_at TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS event_types (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  name TEXT,
  description TEXT,
  base_hours DOUBLE PRECISION DEFAULT 4,
  base_price_credits DOUBLE PRECISION DEFAULT 0,
  extra_hour_credits DOUBLE PRECISION DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
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
);