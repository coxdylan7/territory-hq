// Shared Postgres client factory for HQ and Portal.
//
// Three properties matter for Netlify Functions:
//   1. Importing a module must not open a socket or read implicit PG* env vars.
//   2. A missing DATABASE_URL must fail closed without printing its value.
//   3. Prepared statements stay disabled for Supabase Supavisor transaction
//      mode (port 6543); this is enforced here for every HQ/Portal caller.
// The underlying postgres.js client is created on first use and then reused for
// warm invocations, so no connection is made until a route actually queries.
const postgres = require('postgres');

function databaseUrl(env = process.env) {
  const url = String((env && env.DATABASE_URL) || '').trim();
  if (!url) {
    throw new Error('DATABASE_URL is required for server-side Postgres access');
  }
  return url;
}

function poolMax(env = process.env, fallback) {
  const raw = String((env && env.DATABASE_MAX) || '').trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function makeSql(options = {}) {
  const {
    env = process.env,
    factory = postgres,
    max,
    ...postgresOptions
  } = options;

  let client;
  function getClient() {
    if (!client) {
      client = factory(databaseUrl(env), {
        ...postgresOptions,
        ...(max === undefined ? {} : { max: poolMax(env, max) }),
        // Last so no caller can re-enable prepared statements against a
        // transaction-mode pooler. All other client options pass through.
        prepare: false,
      });
    }
    return client;
  }

  // postgres.js exposes `sql` as a tagged-template function with helpers such as
  // `begin` and `unsafe`. The proxy preserves that shape while staying lazy.
  const sql = new Proxy(function taggedSql(...args) {
    return Reflect.apply(getClient(), undefined, args);
  }, {
    get(_target, property) {
      if (property === 'then') return undefined;
      const current = getClient();
      const value = current[property];
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });

  return { sql, getClient };
}

module.exports = { databaseUrl, poolMax, makeSql };
