const { PORTAL_COOKIE } = require('../../../api/src/session-cookie');
const { sessionTokenFromRequest } = require('../../../api/src/session-auth');

// Portal session tokens are generated with 32 random bytes. Only a token with a
// plausible shape is sent to the database; every other cookie (missing, empty,
// truncated, malformed) is still cleared so logout is always idempotent.
const USABLE_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

function isUsableSessionToken(token) {
  return USABLE_TOKEN.test(String(token || ''));
}

async function logoutSession(req, deps) {
  const token = sessionTokenFromRequest(req, {
    cookieName: PORTAL_COOKIE,
    env: deps.env || process.env,
  });

  if (isUsableSessionToken(token)) {
    try { await deps.deleteSession(token); } catch (e) { /* clearing still matters */ }
  }
  deps.clearCookie();
  return { ok: true };
}

module.exports = { isUsableSessionToken, logoutSession };
