// HttpOnly session cookie helpers shared by the HQ API and the portal API.
// The token is a server-side session identifier; it never needs to be readable
// by JavaScript, so it is never stored in localStorage and never returned in
// JSON. Cross-app Authorization bearer tokens are a separate, owner-scoped
// mechanism and are untouched by these helpers.
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds

const HQ_COOKIE = 'thq_session';
const PORTAL_COOKIE = 'tp_session';

function isSecure(env) {
  return env.NODE_ENV === 'production'
    || env.COOKIE_SECURE === '1'
    || String(env.COOKIE_SECURE || '').toLowerCase() === 'true';
}

function attributes(env, maxAge) {
  const parts = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isSecure(env)) parts.push('Secure');
  return parts.join('; ');
}

function sessionCookieHeader(name, token, env = process.env) {
  return `${name}=${encodeURIComponent(String(token || ''))}; ${attributes(env, SESSION_MAX_AGE)}`;
}

function clearSessionCookieHeader(name, env = process.env) {
  return `${name}=; ${attributes(env, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function appendHeader(res, value) {
  if (typeof res.append === 'function') res.append('Set-Cookie', value);
  else {
    const previous = res.getHeader ? res.getHeader('Set-Cookie') : undefined;
    const all = previous ? [].concat(previous).concat(value) : [value];
    res.setHeader('Set-Cookie', all);
  }
}

function setSessionCookie(res, name, token, env) {
  appendHeader(res, sessionCookieHeader(name, token, env));
}

function clearSessionCookie(res, name, env) {
  appendHeader(res, clearSessionCookieHeader(name, env));
}

function cookieValue(req, name) {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw || typeof raw !== 'string') return '';
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(at + 1).trim()); } catch (e) { return ''; }
  }
  return '';
}

module.exports = {
  SESSION_MAX_AGE,
  HQ_COOKIE,
  PORTAL_COOKIE,
  isSecure,
  sessionCookieHeader,
  clearSessionCookieHeader,
  setSessionCookie,
  clearSessionCookie,
  cookieValue,
};
