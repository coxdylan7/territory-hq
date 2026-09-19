// Territory Portal API — store-side app: redeem credit balance into brand
// activations and budtender trainings. Portal users are either `client`
// (linked to an owner account) or `staff` (ambassadors/trainers executed by
// the Territory owner through the console).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { sql } = require('./db');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 8081);
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

// ---------------------------------------------------------------- auth middleware

async function gate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return fail(res, 401, 'missing token');
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
    if (u.role === 'client') {
      const acc = await sql`SELECT name, city, address FROM accounts WHERE id = ${u.account_id}`.catch(() => []);
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
  ok(res, { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}

// ---------------------------------------------------------------- auth routes

app.post('/api/auth/invite-signup', async (req, res) => {
  const { token, name, password } = req.body || {};
  if (!token || !name || !password || password.length < 6) return fail(res, 400, 'name, password (6+ chars) and invite token required');
  try {
    const inv = await sql`SELECT * FROM portal_invites WHERE token = ${token}`.catch(() => []);
    if (!inv.length) return fail(res, 404, 'invalid invite token');
    const it = inv[0];
    if (it.used_at) return fail(res, 400, 'invite already used');
    if (new Date(it.expires).getTime() < Date.now()) return fail(res, 400, 'invite expired');
    const uid = randomToken();
    const created = await sql`
      INSERT INTO portal_users (id, name, email, role, account_id, owner_user_id, pass_hash, status)
      VALUES (${uid}, ${name.trim()}, ${it.email}, ${it.role}, ${it.account_id || null}, ${it.owner_user_id}, ${hashPassword(password)}, 'active')
      RETURNING id, name, email, role, account_id, owner_user_id`;
    await sql`UPDATE portal_invites SET used_at = now() WHERE token = ${token}`;
    await createSession(res, created[0]);
  } catch (e) {
    fail(res, 409, 'could not activate invite');
  }
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

app.post('/api/auth/logout', gate, async (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  await sql`DELETE FROM portal_sessions WHERE token = ${token}`.catch(() => {});
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
     WHERE owner_user_id = ${req.user.owner_user_id} AND active = true
     ORDER BY name`;
  ok(res, rows);
});

function creditEstimate(et, hours) {
  const h = Math.max(0, Number(hours) || 0);
  const baseH = Number(et.baseHours) || 0;
  return Math.round((Number(et.basePriceCredits) || 0) + Math.max(0, h - baseH) * (Number(et.extraHourCredits) || 0));
}

app.get('/api/balance', gate, async (req, res) => {
  if (req.user.role !== 'client') return ok(res, { balance: null });
  const { account_id, owner_user_id } = req.user;
  const rows = await sql`SELECT COALESCE(SUM(amount), 0)::float AS bal FROM credits WHERE account_id = ${account_id} AND user_id = ${owner_user_id}`;
  ok(res, { balance: Math.round((rows[0].bal || 0) * 100) / 100 });
});

app.get('/api/bookings', gate, async (req, res) => {
  const u = req.user;
  const rows = await (u.role === 'client'
    ? sql`
        SELECT b.id, b.event_type_id AS "eventTypeId", b.event_type_name AS "eventTypeName",
               b.date, b.start_time AS "startTime", b.duration_hours AS "durationHours",
               b.notes_client AS "notesClient", b.notes_admin AS "notesAdmin",
               b.status, b.credits_charged AS "creditsCharged",
               p.name AS "ambassadorName", b.created_at AS "createdAt"
          FROM bookings b
          LEFT JOIN portal_users p ON p.id = b.ambassador_user_id
         WHERE b.account_id = ${u.account_id}
         ORDER BY b.date, b.start_time`
    : sql`
        SELECT b.id, b.event_type_name AS "eventTypeName",
               b.date, b.start_time AS "startTime", b.duration_hours AS "durationHours",
               b.notes_client AS "notesClient", b.notes_admin AS "notesAdmin",
               b.status, b.credits_charged AS "creditsCharged",
               a.name AS "accountName", a.city AS "accountCity", a.address AS "accountAddress"
          FROM bookings b
          LEFT JOIN accounts a ON a.id = b.account_id
         WHERE b.ambassador_user_id = ${u.id}
         ORDER BY b.date, b.start_time`);
  ok(res, rows);
});

app.post('/api/bookings', gate, async (req, res) => {
  const u = req.user;
  if (u.role !== 'client') return fail(res, 403, 'clients only');
  const { eventTypeId, date, startTime, durationHours, notes } = req.body || {};
  if (!eventTypeId || !date) return fail(res, 400, 'event type and date required');
  if (new Date(date).toString() === 'Invalid Date') return fail(res, 400, 'invalid date');
  if (date < todayStr()) return fail(res, 400, 'date must be today or later');
  if (startTime && toMin(startTime) === null) return fail(res, 400, 'invalid start time');
  try {
    const ets = await sql`
      SELECT id, name, base_hours AS "baseHours", base_price_credits AS "basePriceCredits", extra_hour_credits AS "extraHourCredits", active
        FROM event_types WHERE id = ${eventTypeId} AND owner_user_id = ${u.owner_user_id} AND active = true`;
    if (!ets.length) return fail(res, 404, 'event type not available');
    const et = ets[0];
    const hours = Number(durationHours) > 0 ? Number(durationHours) : Number(et.baseHours);
    const est = creditEstimate(et, hours);

    const bal = await sql`SELECT COALESCE(SUM(amount),0)::float AS bal FROM credits WHERE account_id = ${u.account_id} AND user_id = ${u.owner_user_id}`;
    const balance = bal[0].bal || 0;
    if (balance < est) return fail(res, 402, 'insufficient credits');

    // overlap guard: same store, same date, live status, time collision
    const live = await sql`
      SELECT start_time AS "startTime", duration_hours AS "durationHours"
        FROM bookings
       WHERE account_id = ${u.account_id} AND date = ${date}
         AND status NOT IN ('declined','cancelled','completed')`;
    const ns = toMin(startTime) ?? 0;
    const ne = ns + hours * 60;
    for (const row of live) {
      const os = toMin(row.startTime) ?? 0;
      const oe = os + Number(row.durationHours || et.baseHours) * 60;
      if (ns < oe && ne > os) return fail(res, 409, 'store already has an event that overlaps that time');
    }

    const acc = await sql`SELECT name, license_number FROM accounts WHERE id = ${u.account_id}`;
    const a = acc[0] || {};
    const bid = randomToken();
    const created = await sql`
      INSERT INTO bookings (id, owner_user_id, account_id, event_type_id, event_type_name,
                            account_name, license_number,
                            date, start_time, duration_hours, notes_client, status)
      VALUES (${bid}, ${u.owner_user_id}, ${u.account_id}, ${et.id}, ${et.name},
              ${a.name || null}, ${a.license_number || null},
              ${date}, ${startTime || null}, ${hours}, ${notes || null}, 'requested')
      RETURNING id, event_type_name AS "eventTypeName", date, start_time AS "startTime",
                duration_hours AS "durationHours", notes_client AS "notesClient",
                status, created_at AS "createdAt"`;
    ok(res, { booking: created[0], estimatedCost: est, balance });
  } catch (e) {
    fail(res, 500, 'could not create booking');
  }
});

app.put('/api/bookings/:id/cancel', gate, async (req, res) => {
  const u = req.user;
  if (u.role !== 'client') return fail(res, 403, 'clients only');
  try {
    const updated = await sql`
      UPDATE bookings SET status = 'cancelled'
       WHERE id = ${req.params.id} AND account_id = ${u.account_id} AND status IN ('requested')
       RETURNING id, date`;
    if (!updated.length) return fail(res, 404, 'booking not found or already decided');
    ok(res, updated[0]);
  } catch (e) {
    fail(res, 500, 'could not cancel booking');
  }
});

// ---------------------------------------------------------------- static web

const dist = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1d' }));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((req, res) => fail(res, 404, 'not found'));

app.listen(PORT, () => {
  console.log('territory-portal listening on :' + PORT);
});