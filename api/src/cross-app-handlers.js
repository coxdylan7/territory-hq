const { creditsBalancesQuery, sharedMessagesQuery } = require('./cross-app-queries');

// Express handlers for owner-scoped cross-app reads. Dependencies are injected
// so authorization and SQL use can be tested without a database connection.
function requestLicense(req) {
  const license = req.query && req.query.license;
  return typeof license === 'string' && license ? license : undefined;
}

function makeCrossAppHandlers({ sql, resolveOwner, reply }) {
  return {
    async creditsBalances(req, res) {
      const ownerUserId = resolveOwner(req);
      if (!ownerUserId) {
        return reply(res, { error: 'unauthorized' }, req.headers.origin, 401);
      }

      const query = creditsBalancesQuery(ownerUserId, requestLicense(req));
      const rows = await sql.unsafe(query.text, query.values);
      return reply(res, rows.map((r) => ({
        accountId: r.account_id,
        accountName: r.account_name,
        licenseNumber: r.license_number,
        city: r.city,
        balance: r.balance,
      })), req.headers.origin, 200);
    },

    async sharedMessages(req, res) {
      const ownerUserId = resolveOwner(req);
      if (!ownerUserId) {
        return reply(res, { error: 'unauthorized' }, req.headers.origin, 401);
      }

      const query = sharedMessagesQuery(ownerUserId, requestLicense(req));
      const rows = await sql.unsafe(query.text, query.values);
      return reply(res, rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        accountName: r.account_name,
        licenseNumber: r.license_number,
        city: r.city,
        channel: r.channel,
        purpose: r.purpose,
        body: r.body,
        to: r.recipient,
        direction: r.direction,
        date: r.date,
        status: r.status,
      })), req.headers.origin, 200);
    },
  };
}

module.exports = { makeCrossAppHandlers };
