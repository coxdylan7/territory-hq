// Supabase Postgres (via Postgres.js) — mirrors the Turso/libSQL `sql()` helper's
// return shape: `await sql(...)` yields an array of plain objects.
const postgres = require('postgres');

const url = (process.env.DATABASE_URL || '').trim();
if (!url) {
  console.error('FATAL: DATABASE_URL is not set. Copy .env.example to .env and add your Supabase connection string.');
  process.exit(1);
}

// prepare:false — required when talking through PgBouncer (Supabase transaction pooler).
const sql = postgres(url, {
  prepare: false,
  connection: { application_name: 'territory-hq' },
  max: 4,
  idle_timeout: 20,
  connect_timeout: 15,
});

module.exports = { sql };