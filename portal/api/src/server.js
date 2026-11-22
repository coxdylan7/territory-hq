// Territory Portal API — store-side app: redeem credit balance into brand
// activations and budtender trainings. Portal users are either `client`
// (linked to an owner account) or `staff` (ambassadors/trainers executed by
// the Territory owner through the console).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { sql } = require('./db');
const { databaseUrl } = require('../../../api/src/db-client');
const { securityHeadersMiddleware } = require('../../../api/src/security-headers');
const { csrfMiddleware } = require('../../../api/src/csrf');
const { corsMiddleware } = require('../../../api/src/cors');
const { trustProxySetting } = require('../../../api/src/trust-proxy');
const {
  setSessionCookie, clearSessionCookie, PORTAL_COOKIE,
} = require('../../../api/src/session-cookie');
const { sessionTokenFromRequest } = require('../../../api/src/session-auth');
const { readIdempotencyKey, canonicalRequestHash } = require('../../../api/src/idempotency');
const { errorBody } = require('../../../api/src/service-errors');
const { readBalance } = require('../../../api/src/credit-ledger');
const {
  createBooking,
  cancelBooking,
  acceptBooking,
  declineAssignmentBooking,
  completeBooking,
} = require('../../../api/src/booking-service');
const { logoutSession } = require('./logout');
const { activatePortalInvite } = require('./invite-activation');

// Built in a factory so a Netlify Function can import it without listening.
function createApp(options = {}) {
const serveWeb = options.serveWeb === undefined
  ? process.env.SERVE_WEB !== 'false'
  : options.serveWeb;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));
app.use(securityHeadersMiddleware());
app.use(corsMiddleware());
app.use(csrfMiddleware());
app.use(express.json({ limit: '1mb' }));

const SESSION_DAYS = 30;
const PBKDF2_ITER = 310000;

// ---------------------------------------------------------------- helpers

function hmacMd5Hex(str) {
  return crypto.createHmac('md5', process.env.APP_SECRET || 'territory-portal').update(str).digest('hex');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(pw), salt, PBKDF2_ITER, 32, 'sha256').toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.pbkdf2Sync(String(pw), salt, PBKDF2_ITER, 32, 'sha256');
  const expect = Buffer.from(hash, 'hex');
  return test.length === expect.length && crypto.timingSafeEqual(test, expect);
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function toMin(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const json = { 'Content-Type': 'application/json' };

function fail(res, status, error) {
  res.status(status).json({ error });
}

function ok(res, data) {
  res.json(data);
}

function withHumanErrors(result, messages) {
  const humanError = messages[result.body && result.body.code];
  if (!humanError) return result;
  return { ...result, body: { ...result.body, error: humanError } };
}

function sendCommandResult(res, result) {
  if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
  res.status(result.status).json(result.body);
}

function portalActor(user) {
  return {
    type: 'portal_user',
    id: user.id,
    role: user.role,
    accountId: user.account_id || null,
    ownerUserId: user.owner_user_id,
  };
}

function commandContext(req, res, user, operation, resourceId) {
  try {
    const key = readIdempotencyKey(req);
    const actor = portalActor(user);
    return {
      ownerUserId: user.owner_user_id,
      actor,
      key,
      requestHash: canonicalRequestHash({
        operation,
        resourceId: resourceId || null,
        actor,
        body: req.body || {},
      }),
    };
  } catch (error) {
    sendCommandResult(res, { status: error.status || 400, body: errorBody(error) });
    return null;
  }
}

// ---------------------------------------------------------------- auth middleware

async function gate(req, res, next) {
  const token = sessionTokenFromRequest(req, { cookieName: PORTAL_COOKIE });
  if (!token) return fail(res, 401, 'missing session cookie');
  const nu = new Date(Date.now() + SESSION_DAYS * 86400000);
  try {
    const rows = await sql`
      UPDATE portal_sessions s
         SET expires = ${nu.toISOString()}
        FROM portal_users u
       WHERE s.token = ${token}
         AND s.expires::timestamptz > now()
         AND u.id = s.user_id
         AND u.status = 'active'
       RETURNING u.id, u.name, u.email, u.role, u.account_id, u.owner_user_id, u.status`;
    if (!rows.length) return fail(res, 401, 'session invalid');
    const u = rows[0];
    req.user = u;
    if (u.role !== 'brand_ambassador') {
      const acc = await sql`SELECT name, city, address FROM accounts WHERE id = ${u.account_id} AND user_id = ${u.owner_user_id}`.catch(() => []);
      const a = acc[0] || {};
      req.user.accountName = a.name || null;
      req.user.accountCity = a.city || null;
      req.user.accountAddress = a.address || null;
    }
    next();
  } catch (e) {
    fail(res, 500, 'db error');
  }
}

async function createSession(res, user) {
  const token = randomToken();
  await sql`
    INSERT INTO portal_sessions (token, user_id, expires)
    VALUES (${token}, ${user.id}, ${new Date(Date.now() + SESSION_DAYS * 86400000).toISOString()})`;
  setSessionCookie(res, PORTAL_COOKIE, token);
  ok(res, { user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}

// ---------------------------------------------------------------- auth routes

app.post('/api/auth/invite-signup', async (req, res) => {
  const result = await activatePortalInvite(sql, req.body || {}, {
    now: () => new Date(),
    hashPassword,
    randomToken,
    sessionDays: SESSION_DAYS,
  });
  if (result.sessionToken) setSessionCookie(res, PORTAL_COOKIE, result.sessionToken);
  res.status(result.status).json(result.body);
});

// Pre-claim store picker: accounts belong to the invite's owner.
app.get('/api/portal/available-accounts', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return fail(res, 400, 'missing token');
  const inv = await sql`SELECT * FROM portal_invites WHERE token = ${token} AND used_at IS NULL`.catch(() => []);
  if (!inv.length || new Date(inv[0].expires).getTime() < Date.now()) return fail(res, 404, 'invite invalid or expired');
  if (inv[0].role === 'brand_ambassador') return ok(res, []);
  const rows = await sql`
    SELECT id, name, city, license_number AS "licenseNumber"
      FROM accounts
     WHERE user_id = ${inv[0].owner_user_id}
     ORDER BY name`;
  ok(res, rows.map((a) => ({ id: a.id, name: a.name, city: a.city || '', licenseNumber: a.licenseNumber || '' })));
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 400, 'email and password required');
  try {
    const rows = await sql`SELECT id, name, email, role, account_id, owner_user_id, pass_hash, status FROM portal_users WHERE lower(email) = lower(${email})`;
    if (!rows.length) return fail(res, 401, 'invalid credentials');
    const u = rows[0];
    if (!verifyPassword(password, u.pass_hash)) return fail(res, 401, 'invalid credentials');
    if (u.status !== 'active') return fail(res, 403, 'account suspended');
    await createSession(res, u);
  } catch (e) {
    fail(res, 500, 'db error');
  }
});

app.post('/api/auth/logout', async (req, res) => {
  await logoutSession(req, {
    deleteSession: async (token) => {
      await sql`DELETE FROM portal_sessions WHERE token = ${token}`;
    },
    clearCookie: () => clearSessionCookie(res, PORTAL_COOKIE),
  });
  ok(res, {});
});

app.get('/api/me', gate, (req, res) => {
  const u = req.user;
  ok(res, {
    id: u.id, name: u.name, email: u.email, role: u.role,
    accountId: u.account_id, accountName: u.accountName || null,
    accountCity: u.accountCity || null,
  });
});

// ---------------------------------------------------------------- data routes

// active event types priced by the owner who runs this portal
app.get('/api/event-types', gate, async (req, res) => {
  const rows = await sql`
    SELECT id, name, base_hours AS "baseHours", base_price_credits AS "basePriceCredits", extra_hour_credits AS "extraHourCredits", active
      FROM event_types
     WHERE owner_user_id = ${req.user.owner_user_id}
     ORDER BY name`;
  ok(res, rows.filter((r) => r.active));
});

app.get('/api/balance', gate, async (req, res) => {
  if (req.user.role === 'brand_ambassador') return ok(res, { balance: null });
  const balance = await readBalance(sql, req.user.owner_user_id, req.user.account_id);
  ok(res, { balance: Number(balance) });
});

app.get('/api/bookings', gate, async (req, res) => {
  const u = req.user;
  const isStore = u.role !== 'brand_ambassador';
  const rows = await (isStore
    ? sql`
        SELECT b.id, b.event_type_id AS "eventTypeId", b.event_type_name AS "eventTypeName",
               b.date, b.start_time AS "startTime", b.duration_hours AS "durationHours",
               b.notes_client AS "notesClient", b.notes_admin AS "notesAdmin",
               b.status, b.credits_charged AS "creditsCharged",
               b.quoted_credits AS "quotedCredits",
               p.name AS "ambassadorName", b.created_at AS "createdAt"
          FROM bookings b
          LEFT JOIN portal_users p ON p.id = b.ambassador_user_id
            AND p.owner_user_id = ${u.owner_user_id}
         WHERE b.owner_user_id = ${u.owner_user_id}
           AND b.account_id = ${u.account_id}
         ORDER BY b.date, b.start_time`
    : sql`
        SELECT b.id, b.event_type_name AS "eventTypeName",
               b.date, b.start_time AS "startTime", b.duration_hours AS "durationHours",
               b.notes_client AS "notesClient", b.notes_admin AS "notesAdmin",
               b.status, b.credits_charged AS "creditsCharged",
               b.quoted_credits AS "quotedCredits",
               a.name AS "accountName", a.city AS "accountCity", a.address AS "accountAddress", a.license_number AS "licenseNumber"
          FROM bookings b
          LEFT JOIN accounts a ON a.id = b.account_id
            AND a.user_id = ${u.owner_user_id}
         WHERE b.owner_user_id = ${u.owner_user_id}
           AND b.ambassador_user_id = ${u.id}
         ORDER BY b.date, b.start_time`);
  ok(res, rows);
});

app.post('/api/bookings', gate, async (req, res) => {
  const u = req.user;
  if (u.role !== 'store_manager') return fail(res, 403, 'store managers only');
  if (!u.account_id) return fail(res, 400, 'no store linked to your account');
  const body = req.body || {};
  const context = commandContext(req, res, u, 'booking.create', body.eventTypeId || null);
  if (!context) return undefined;
  const result = await createBooking(sql, {
    ...context,
    ownerUserId: u.owner_user_id,
    accountId: u.account_id,
    input: {
      eventTypeId: body.eventTypeId,
      date: body.date,
      startTime: body.startTime,
      durationHours: body.durationHours,
      notes: body.notes,
    },
  });
  return sendCommandResult(res, withHumanErrors(result, {
    EVENT_TYPE_NOT_FOUND: 'event type not available',
    INSUFFICIENT_CREDITS: 'insufficient credits',
    BOOKING_OVERLAP: 'store already has an event that overlaps that time',
    VALIDATION_ERROR: 'a valid event type, future date, start time and duration are required',
  }));
});

app.put('/api/bookings/:id/cancel', gate, async (req, res) => {
  const u = req.user;
  if (u.role === 'brand_ambassador') return fail(res, 403, 'store users only');
  const context = commandContext(req, res, u, 'booking.cancel', req.params.id);
  if (!context) return undefined;
  const result = await cancelBooking(sql, { ...context, bookingId: req.params.id });
  return sendCommandResult(res, withHumanErrors(result, {
    FORBIDDEN_ACTOR: 'store users only',
    BOOKING_NOT_FOUND: 'booking not found or already decided',
    INVALID_TRANSITION: 'booking not found or already decided',
  }));
});

/* ---- ambassador actions ---- */

app.put('/api/bookings/:id/accept', gate, async (req, res) => {
  const u = req.user;
  if (u.role !== 'brand_ambassador') return fail(res, 403, 'ambassadors only');
  const context = commandContext(req, res, u, 'booking.accept', req.params.id);
  if (!context) return undefined;
  const result = await acceptBooking(sql, { ...context, bookingId: req.params.id });
  return sendCommandResult(res, withHumanErrors(result, {
    FORBIDDEN_ACTOR: 'you are not assigned to that event, or it is already handled',
    BOOKING_NOT_FOUND: 'you are not assigned to that event, or it is already handled',
    INVALID_TRANSITION: 'you are not assigned to that event, or it is already handled',
  }));
});

app.put('/api/bookings/:id/decline-assignment', gate, async (req, res) => {
  const u = req.user;
  if (u.role !== 'brand_ambassador') return fail(res, 403, 'ambassadors only');
  const context = commandContext(req, res, u, 'booking.declineAssignment', req.params.id);
  if (!context) return undefined;
  const result = await declineAssignmentBooking(sql, { ...context, bookingId: req.params.id });
  return sendCommandResult(res, withHumanErrors(result, {
    FORBIDDEN_ACTOR: 'you are not assigned to that event, or it is already handled',
    BOOKING_NOT_FOUND: 'you are not assigned to that event, or it is already handled',
    INVALID_TRANSITION: 'you are not assigned to that event, or it is already handled',
  }));
});

app.put('/api/bookings/:id/complete', gate, async (req, res) => {
  const u = req.user;
  if (u.role !== 'brand_ambassador') return fail(res, 403, 'ambassadors only');
  const context = commandContext(req, res, u, 'booking.complete', req.params.id);
  if (!context) return undefined;
  const result = await completeBooking(sql, { ...context, bookingId: req.params.id });
  return sendCommandResult(res, withHumanErrors(result, {
    FORBIDDEN_ACTOR: 'you are not assigned to that event, or it is already handled',
    BOOKING_NOT_FOUND: 'you are not assigned to that event, or it is already handled',
    INVALID_TRANSITION: 'you are not assigned to that event, or it is already handled',
  }));
});

// ------------------------------------------------- health + API-only fallback
app.get('/api/health', (req, res) => ok(res, { ok: true, service: 'portal' }));
app.use('/api', (req, res) => fail(res, 404, 'not found'));

// ---------------------------------------------------------------- static web
const dist = path.join(__dirname, '..', '..', 'web', 'dist');
if (serveWeb && fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1d' }));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((req, res) => fail(res, 404, 'not found'));
return app;
}

let cachedApp;
function getApp(options) {
  if (!cachedApp) cachedApp = createApp(options);
  return cachedApp;
}

/* ================= start (local/Docker only) ================= */
function start(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const listen = options.listen || ((app, port) => app.listen(port, () => {
    logger.log(`territory-portal listening on :${port}`);
  }));

  try {
    databaseUrl(env);
  } catch (error) {
    logger.error('FATAL: DATABASE_URL is required for the Territory Portal API.');
    if (options.exit !== false) process.exit(1);
    return Promise.reject(error);
  }

  return Promise.resolve()
    .then(() => listen(getApp(), Number(env.PORT || 8081)))
    .catch((error) => {
      logger.error('FATAL: could not start the Territory Portal API (check DATABASE_URL).');
      if (options.exit !== false) process.exit(1);
      throw error;
    });
}

if (require.main === module) start();

module.exports = { createApp, getApp, start };