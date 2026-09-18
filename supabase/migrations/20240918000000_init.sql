# Territory HQ — initial schema
# Source of truth: api/src/schema.js

-- ============================================
-- 001  users, sessions
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  pass_hash TEXT,
  role TEXT DEFAULT 'user',
  status TEXT DEFAULT 'pending',
  sub_expires TEXT,
  plan TEXT DEFAULT 'standard',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT,
  expires TEXT
);

-- ============================================
-- 002  accounts
-- ============================================

CREATE TABLE IF NOT EXISTS accounts (
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
);

-- ============================================
-- 003  settings
-- ============================================

CREATE TABLE IF NOT EXISTS settings (
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
);

-- ============================================
-- 004  ocm_seen
-- ============================================

CREATE TABLE IF NOT EXISTS ocm_seen (
  user_id TEXT,
  license_number TEXT,
  PRIMARY KEY (user_id, license_number)
);

-- ============================================
-- 005  kv (general key/value store per user)
-- ============================================

CREATE TABLE IF NOT EXISTS kv (
  user_id TEXT,
  key TEXT,
  value TEXT,
  PRIMARY KEY (user_id, key)
);

-- ============================================
-- 006  route_log
-- ============================================

CREATE TABLE IF NOT EXISTS route_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  date TEXT,
  day TEXT,
  stops TEXT,
  miles DOUBLE PRECISION,
  minutes DOUBLE PRECISION,
  dismissed INTEGER DEFAULT 0
);

-- ============================================
-- 007  credits
-- ============================================

CREATE TABLE IF NOT EXISTS credits (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  account_id TEXT,
  account_name TEXT,
  license_number TEXT,
  city TEXT,
  amount DOUBLE PRECISION,
  note TEXT,
  date TEXT
);

-- ============================================
-- 008  expenses
-- ============================================

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  date TEXT,
  category TEXT,
  amount DOUBLE PRECISION,
  miles DOUBLE PRECISION,
  notes TEXT
);

-- ============================================
-- 009  messages
-- ============================================

CREATE TABLE IF NOT EXISTS messages (
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
);

-- ============================================
-- Useful indexes
-- ============================================

CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions  (user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_user   ON accounts  (user_id);
CREATE INDEX IF NOT EXISTS idx_expenses_user   ON expenses  (user_id);
CREATE INDEX IF NOT EXISTS idx_route_log_user  ON route_log (user_id);
CREATE INDEX IF NOT EXISTS idx_credits_user    ON credits   (user_id);
CREATE INDEX IF NOT EXISTS idx_messages_user   ON messages  (user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_license ON accounts (user_id, license_number);
