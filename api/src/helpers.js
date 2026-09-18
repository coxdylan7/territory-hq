// Port of the auth + response helpers from reference/netlify/functions/api.js
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
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.set(SEC).type('application/json');
  if (allow.length && (allow.includes('*') || allow.includes(origin))) {
    res.set('vary', 'Origin');
    res.set('access-control-allow-origin', allow.includes('*') ? '*' : origin);
    res.set('access-control-allow-methods', 'GET, OPTIONS');
    res.set('access-control-allow-headers', 'authorization, content-type');
  }
  return res.status(status || 200).json(obj);
}

function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function readTokenOk(req) {
  return safeEq(bearerToken(req), process.env.READ_TOKEN || '');
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
  readTokenOk,
};