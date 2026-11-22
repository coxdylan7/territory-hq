// Exact CORS allowlists. PUBLIC_ORIGIN/FIRST_PARTY_ORIGINS are the only origins
// allowed to send credentialed (cookie) requests and receive mutation methods.
// ALLOWED_ORIGINS is a separate bearer-token consumer list for cross-app GETs.
// Wildcards are never reflected, including when configured.
const { allowedOrigins, normalizeOrigin } = require('./csrf');

const FIRST_PARTY_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const BEARER_METHODS = 'GET, OPTIONS';
const ALLOWED_HEADERS = 'authorization, content-type';

function crossAppOrigins(env = process.env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
}

function setHeaders(res, origin, env) {
  res.setHeader('Vary', 'Origin');
  const presented = normalizeOrigin(origin);
  if (!presented) return;

  if (allowedOrigins(env).includes(presented)) {
    res.setHeader('Access-Control-Allow-Origin', presented);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', FIRST_PARTY_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    return;
  }

  if (crossAppOrigins(env).includes(presented)) {
    res.setHeader('Access-Control-Allow-Origin', presented);
    res.setHeader('Access-Control-Allow-Methods', BEARER_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  }
}

function corsMiddleware(env = process.env) {
  return (req, res, next) => {
    setHeaders(res, req.headers && req.headers.origin, env);
    if (req.method === 'OPTIONS') {
      if (typeof res.sendStatus === 'function') return res.sendStatus(204);
      return res.status(204).end();
    }
    return next();
  };
}

module.exports = { crossAppOrigins, corsMiddleware, setHeaders, FIRST_PARTY_METHODS, BEARER_METHODS };
