// Auth + response helpers shared by the Express API
const crypto = require('crypto');

/* ---------------- passwords (PBKDF2, same format as the original) ---------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

/* ---------------- tokens ---------------- */
function newToken() { return crypto.randomBytes(32).toString('hex'); }

/* ---------------- user views / status ---------------- */
function userView(u) {
  const today = new Date().toISOString().slice(0, 10);
  let status = u.status;
  if (status === 'active' && u.role !== 'admin' && u.sub_expires && u.sub_expires < today) status = 'expired';
  return { id: u.id, name: u.name, email: u.email, role: u.role, status, subExpires: u.sub_expires, plan: u.plan, createdAt: u.created_at };
}
function isUsable(u) {
  return userView(u).status === 'active';
}

/* ---------------- header / auth extraction ---------------- */
function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

/* ---------------- security headers ---------------- */
const SEC = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

/* ---------------- response helpers (Express) ---------------- */
function json(res, obj, status) {
  return res.status(status || 200).set(SEC).type('application/json').json(obj);
}
function jsonCors(res, obj, origin, status) {
  // Global corsMiddleware has already applied exact headers. This helper only
  // removes the legacy wildcard path for direct callers; cross-app bearer CORS
  // remains limited to exact ALLOWED_ORIGINS values.
  const allow = String(process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter((s) => s && s !== '*');
  res.set(SEC).type('application/json');
  if (origin && allow.includes(String(origin))) {
    res.set('access-control-allow-origin', String(origin));
    res.set('access-control-allow-methods', 'GET, OPTIONS');
    res.set('access-control-allow-headers', 'authorization, content-type');
  }
  return res.status(status || 200).json(obj);
}

function safeEq(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length || !left.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  hashPassword,
  verifyPassword,
  newToken,
  userView,
  isUsable,
  bearerToken,
  json,
  jsonCors,
  safeEq,
};