// Supabase Postgres (via Postgres.js) — mirrors the Turso/libSQL `sql()` helper's
// return shape: `await sql(...)` yields an array of plain objects.
// The client is created lazily by the shared factory so importing this module
// never opens a connection; see db-client.js for the fail-closed behaviour.
const { makeSql } = require('./db-client');

const { sql } = makeSql({
  max: 4,
  idle_timeout: 20,
  connect_timeout: 15,
  // prepare:false — required when talking through PgBouncer (transaction pooler).
  prepare: false,
  connection: { application_name: 'territory-hq' },
});

module.exports = { sql };
