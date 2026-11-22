// CSRF defence for cookie-authenticated state changes. Credentialed mutations
// must carry an exact, configured browser Origin; absent Origin is only accepted
// from clients that show no browser fetch metadata and carry no session cookie
// (or from the explicitly tested legacy bearer compatibility path).
const { bearerToken } = require('./helpers');
const { HQ_COOKIE, PORTAL_COOKIE } = require('./session-cookie');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizeOrigin(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return text && text !== 'null' ? text : '';
}

function configuredOriginText(env = process.env) {
  return [env.PUBLIC_ORIGIN, env.FIRST_PARTY_ORIGINS]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .join(',');
}

function allowedOrigins(env = process.env) {
  return configuredOriginText(env)
    .split(',')
    .map(normalizeOrigin)
    .filter((origin) => origin && origin !== '*');
}

function hasSessionCookie(req) {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw || typeof raw !== 'string') return false;
  return raw.split(';').some((part) => {
    const at = part.indexOf('=');
    const name = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
    return name === HQ_COOKIE || name === PORTAL_COOKIE;
  });
}

// Only Express's req.protocol is used. It reflects x-forwarded-proto solely when
// the operator explicitly configured app.set('trust proxy', ...), so raw
// x-forwarded-* headers can never influence the CSRF decision.
function requestOrigin(req) {
  const protocol = String((req && req.protocol) || '').trim().toLowerCase();
  const host = req && req.headers && req.headers.host;
  if (!protocol || !host) return '';
  return normalizeOrigin(`${protocol}://${host}`);
}

function legacyBearerAllowed(req, env) {
  return env.ALLOW_LEGACY_BEARER_SESSION === '1' && Boolean(bearerToken(req));
}

function isAllowedMutation(req, env = process.env) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (!MUTATING.has(method)) return true;

  const headers = (req && req.headers) || {};
  const site = String(headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (site === 'cross-site') return false;

  const rawOrigin = headers.origin;
  const hasOrigin = rawOrigin !== undefined && rawOrigin !== null && String(rawOrigin).trim() !== '';
  if (!hasOrigin) {
    if (legacyBearerAllowed(req, env)) return true;
    if (hasSessionCookie(req)) return false;
    if (site) return false; // browser fetch metadata without Origin is not a non-browser client
    return true;
  }

  const presented = normalizeOrigin(rawOrigin);
  if (!presented) return false;

  const configured = allowedOrigins(env);
  if (configured.length) return configured.includes(presented);
  if (configuredOriginText(env).trim()) return false; // explicit but unusable config fails closed

  const same = requestOrigin(req);
  return Boolean(same) && same === presented;
}

function csrfMiddleware(env = process.env) {
  return (req, res, next) => {
    if (!isAllowedMutation(req, env)) {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
    return next();
  };
}

module.exports = {
  MUTATING,
  allowedOrigins,
  configuredOriginText,
  csrfMiddleware,
  hasSessionCookie,
  isAllowedMutation,
  normalizeOrigin,
  requestOrigin,
};
