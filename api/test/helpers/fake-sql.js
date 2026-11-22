'use strict';

// Minimal Postgres.js-shaped client for service tests. It records tagged
// template queries and transaction boundaries without opening a connection.
function createFakeSql(handler = () => []) {
  const calls = [];

  function makeClient() {
    const sql = (strings, ...values) => {
      const text = String.raw({ raw: strings }, ...values.map(() => '?'))
        .replace(/\s+/g, ' ')
        .trim();
      calls.push({ kind: 'query', text, values });
      return Promise.resolve(handler(text, values, calls));
    };
    sql.unsafe = async (statement, params = []) => {
      calls.push({ kind: 'unsafe', text: statement, values: params });
      return handler(statement, params, calls);
    };
    return sql;
  }

  const sql = makeClient();
  sql.begin = async (callback) => {
    calls.push({ kind: 'begin' });
    try {
      const result = await callback(makeClient());
      calls.push({ kind: 'commit' });
      return result;
    } catch (error) {
      calls.push({ kind: 'rollback' });
      throw error;
    }
  };

  return { sql, calls };
}

function queryTexts(calls) {
  return calls
    .filter((call) => call.kind === 'query' || call.kind === 'unsafe')
    .map((call) => call.text);
}

module.exports = { createFakeSql, queryTexts };
