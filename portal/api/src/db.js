// Portal database access uses the same lazy, fail-closed, pooler-safe factory as HQ.
const { makeSql } = require('../../../api/src/db-client');

const { sql } = makeSql({
  max: 10,
  idle_timeout: 30,
  connection: { application_name: 'territory-portal' },
});

module.exports = { sql };
