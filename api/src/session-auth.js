// First-party sessions are carried by an HttpOnly cookie. An Authorization
// bearer header is accepted for session lookup only behind an explicit,
// temporary opt-in; owner-scoped cross-app bearer tokens are resolved
// separately in cross-app-auth.js and are never affected by this flag.
const { bearerToken } = require('./helpers');
const { cookieValue, HQ_COOKIE } = require('./session-cookie');

function legacyBearerEnabled(env = process.env) {
  return env.ALLOW_LEGACY_BEARER_SESSION === '1';
}

function sessionTokenFromRequest(req, options = {}) {
  const env = options.env || process.env;
  const name = options.cookieName || HQ_COOKIE;
  const fromCookie = cookieValue(req, name);
  if (fromCookie) return fromCookie;
  return legacyBearerEnabled(env) ? bearerToken(req) : '';
}

async function currentSessionUser(sql, req, options = {}) {
  const token = sessionTokenFromRequest(req, options);
  if (!token) return null;
  const rows = await sql`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires > ${new Date().toISOString()}`;
  return rows[0] || null;
}

module.exports = { legacyBearerEnabled, sessionTokenFromRequest, currentSessionUser };
