const postgres = require('postgres');

const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  prepare: false,
  connection: { application_name: 'territory-portal' },
});

module.exports = { sql };