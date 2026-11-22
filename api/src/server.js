// Territory HQ — REST API (Express + Supabase Postgres)
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { sql } = require('./db');
const { ensureSchema } = require('./schema');
const { smsConfigured, sendSmsTwilio, proxyAnthropic } = require('./integrations');
const { resolveCrossAppOwner } = require('./cross-app-auth');
const { makeCrossAppHandlers } = require('./cross-app-handlers');
const { makeErrorHandler, internalError } = require('./error-handler');
const { securityHeadersMiddleware } = require('./security-headers');
const { csrfMiddleware } = require('./csrf');
const { corsMiddleware } = require('./cors');
const { trustProxySetting } = require('./trust-proxy');
const { setSessionCookie, clearSessionCookie, HQ_COOKIE } = require('./session-cookie');
const { currentSessionUser, sessionTokenFromRequest } = require('./session-auth');
const {
  hashPassword, verifyPassword, newToken, userView, isUsable,
  json, jsonCors,
} = require('./helpers');
const { readIdempotencyKey, canonicalRequestHash } = require('./idempotency');
const { errorBody } = require('./service-errors');
const { adjustCredits, ledgerView } = require('./credit-ledger');
const {
  approveBooking,
  cancelBooking,
  declineBooking,
  assignBooking,
  removePortalUsersBookings,
  bookingView: sharedBookingView,
} = require('./booking-service');

const app = express();
app.disable('x-powered-by');
// Forwarded protocol/host headers are trusted only when the operator opts in.
app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));
app.use(securityHeadersMiddleware());

/* ---------------- exact CORS and preflight ---------------- */
app.use(corsMiddleware());

// Cookie-authenticated state changes require a first-party Origin.
app.use(csrfMiddleware());

app.use(express.json());

/* ---------------- request log (dev only) ---------------- */
app.use((req, res, next) => {
  if (process.env.DEBUG_REQUEST === '1') console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.ip || '?'}`);
  next();
});

/* ---------------- current user from HttpOnly session cookie ---------------- */
// Cross-app bearer tokens are resolved only by resolveCrossAppOwner below.
async function currentUser(req) {
  return currentSessionUser(sql, req);
}

/* ================= auth ================= */
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 8) return json(res, { error: 'Name, email, and an 8+ character password are required.' }, 400);
  const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
  if (existing.length) return json(res, { error: 'An account with that email already exists.' }, 409);
  const count = await sql`SELECT COUNT(*)::int AS n FROM users`;
  const isFirst = Number(count[0].n) === 0;
  const isBootstrapAdmin = isFirst || (process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase());
  const id = 'u' + Date.now();
  await sql`
    INSERT INTO users (id, name, email, pass_hash, role, status, created_at)
    VALUES (${id}, ${name}, ${email.toLowerCase()}, ${hashPassword(password)}, ${isBootstrapAdmin ? 'admin' : 'user'}, ${isBootstrapAdmin ? 'active' : 'pending'}, ${new Date().toISOString()})`;
  if (isBootstrapAdmin) {
    const token = newToken();
    const exp = new Date(Date.now() + 30 * 864e5).toISOString();
    await sql`INSERT INTO sessions (token, user_id, expires) VALUES (${token}, ${id}, ${exp})`;
    setSessionCookie(res, HQ_COOKIE, token);
    return json(res, {
      ok: true,
      user: userView({ id, name, email: email.toLowerCase(), role: 'admin', status: 'active', created_at: new Date().toISOString() }),
    });
  }
  return json(res, { ok: true, pending: true });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const rows = await sql`SELECT * FROM users WHERE email = ${(email || '').toLowerCase()}`;
    const u = rows[0];
    if (!u || !verifyPassword(password || '', u.pass_hash)) return json(res, { error: 'Invalid email or password.' }, 401);
    const token = newToken();
    const exp = new Date(Date.now() + 30 * 864e5).toISOString();
    await sql`INSERT INTO sessions (token, user_id, expires) VALUES (${token}, ${u.id}, ${exp})`;
    setSessionCookie(res, HQ_COOKIE, token);
    return json(res, { ok: true, user: userView(u) });
  } catch (err) {
    console.error('login error:', err && err.stack ? err.stack : err);
    return json(res, { error: 'login failed' }, 500);
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = sessionTokenFromRequest(req);
  if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
  clearSessionCookie(res, HQ_COOKIE);
  return json(res, { ok: true });
});

/* ================= cross-app reads (owner-scoped tokens) ================= */
// Each opaque token maps to exactly one owner_user_id in CROSS_APP_TOKENS_JSON.
// The owner id is never accepted from the caller; it is resolved from the
// bearer token and used as a SQL scope by the query helpers.
const crossApp = makeCrossAppHandlers({
  sql,
  resolveOwner: (req) => resolveCrossAppOwner(req),
  reply: jsonCors,
});

app.get('/api/credits/balances', (req, res) => crossApp.creditsBalances(req, res));
app.get('/api/messages/shared', (req, res) => crossApp.sharedMessages(req, res));

/* ================= authed user ================= */
app.get('/api/me', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return json(res, { error: 'unauthorized' }, 401);
  return json(res, { ...userView(user), smsEnabled: smsConfigured() });
});

/* ================= admin ================= */
app.get('/api/admin/users', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return json(res, { error: 'unauthorized' }, 401);
  if (user.role !== 'admin') return json(res, { error: 'forbidden' }, 403);
  const rows = await sql`SELECT * FROM users ORDER BY created_at DESC`;
  return json(res, rows.map(userView));
});

app.put('/api/admin/users/:id', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return json(res, { error: 'unauthorized' }, 401);
  if (user.role !== 'admin') return json(res, { error: 'forbidden' }, 403);
  const id = req.params.id;
  const b = req.body || {};
  const target = (await sql`SELECT * FROM users WHERE id = ${id}`)[0];
  if (!target) return json(res, { error: 'not found' }, 404);
  const status = b.status !== undefined ? b.status : target.status;
  const role = b.role !== undefined ? b.role : target.role;
  const subExpires = b.subExpires !== undefined ? b.subExpires : target.sub_expires;
  await sql`UPDATE users SET status = ${status}, role = ${role}, sub_expires = ${subExpires} WHERE id = ${id}`;
  if (status === 'suspended') await sql`DELETE FROM sessions WHERE user_id = ${id}`;
  return json(res, { ok: true });
});

app.delete('/api/admin/users/:id', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return json(res, { error: 'unauthorized' }, 401);
  if (user.role !== 'admin') return json(res, { error: 'forbidden' }, 403);
  const id = req.params.id;
  if (id === user.id) return json(res, { error: 'You cannot delete your own account.' }, 400);
  const target = (await sql`SELECT * FROM users WHERE id = ${id}`)[0];
  if (!target) return json(res, { error: 'not found' }, 404);
  const admins = await sql`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`;
  if (target.role === 'admin' && Number(admins[0].n) <= 1) {
    return json(res, { error: 'This is the last active admin — promote someone else first.' }, 400);
  }
  try {
    const portalUserIds = (await sql`
      SELECT id FROM portal_users WHERE owner_user_id = ${id} ORDER BY id
    `).map((row) => row.id);
    await sql.begin(async (tx) => {
      await removePortalUsersBookings(tx, {
        ownerUserId: id,
        portalUserIds,
        actor: { type: 'admin_user', id: user.id },
        key: `admin-user-delete:${id}`,
        requestHash: `admin-user-delete:${id}`,
        deleteInvites: true,
        deleteOwnerUser: true,
      });
    });
    return json(res, { ok: true });
  } catch (e) {
    return json(res, internalError('admin user deletion', e), 500);
  }
});

/* ================= active gate ================= */
// Mounted on every data route below: requires a signed-in, active user.
function gate(handler) {
  return async (req, res) => {
    const user = await currentUser(req);
    if (!user) return json(res, { error: 'unauthorized' }, 401);
    if (!isUsable(user)) return json(res, { error: 'inactive', reason: userView(user).status }, 402);
    return handler(req, res, user);
  };
}

const HQ_ACTOR_TYPE = 'hq_user';

function sendCommandResult(res, result) {
  if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
  const body = result.body && result.body.code === 'AMBASSADOR_NOT_FOUND'
    ? { ...result.body, error: 'Pick a valid staff member.' }
    : result.body;
  return json(res, body, result.status);
}

function commandContext(req, res, user, operation, resourceId) {
  try {
    const key = readIdempotencyKey(req);
    const actor = { type: HQ_ACTOR_TYPE, id: user.id };
    return {
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

/* ================= settings ================= */
// A Google Maps key must look like "AIza...". Anything else (typos, passwords,
// junk keys from other providers) is treated as no key so it can never break
// geocoding or routing.
function validGmapsKey(k) {
  const v = String(k || '').trim();
  return /^AIza[A-Za-z0-9_-]{10,}$/.test(v) ? v : '';
}

app.get('/api/settings', gate(async (req, res, user) => {
  const r = (await sql`SELECT * FROM settings WHERE user_id = ${user.id}`)[0];
  return json(res, {
    homeAddress: (r && r.home_address) || '', homeLat: r ? r.home_lat : null, homeLng: r ? r.home_lng : null,
    counties: JSON.parse((r && r.counties) || '[]'), workDays: JSON.parse((r && r.work_days) || '["Mon","Tue","Wed","Thu","Fri"]'),
    mileageRate: r && r.mileage_rate != null ? r.mileage_rate : 0.70, gmapsKey: validGmapsKey(r && r.gmaps_key),
    defaultCredit: (r && r.default_credit) || 0, alertEmail: (r && r.alert_email) || '',
  });
}));

app.put('/api/settings', gate(async (req, res, user) => {
  const s = req.body || {};
  await sql`
    INSERT INTO settings (user_id, home_address, home_lat, home_lng, counties, work_days, mileage_rate, gmaps_key, default_credit, alert_email)
    VALUES (${user.id}, ${s.homeAddress || ''}, ${s.homeLat ?? null}, ${s.homeLng ?? null}, ${JSON.stringify(s.counties || [])}, ${JSON.stringify(s.workDays || [])}, ${s.mileageRate ?? 0.70}, ${validGmapsKey(s.gmapsKey)}, ${s.defaultCredit || 0}, ${s.alertEmail || ''})
    ON CONFLICT (user_id) DO UPDATE SET
      home_address = excluded.home_address, home_lat = excluded.home_lat, home_lng = excluded.home_lng,
      counties = excluded.counties, work_days = excluded.work_days, mileage_rate = excluded.mileage_rate,
      gmaps_key = excluded.gmaps_key, default_credit = excluded.default_credit, alert_email = excluded.alert_email`;
  return json(res, { ok: true });
}));

/* ================= accounts ================= */
const accToView = (r) => ({ id: r.id, name: r.name, dba: r.dba, address: r.address, city: r.city, county: r.county, phone: r.phone, email: r.email, contactName: r.contact_name, status: r.status, priority: !!r.priority, priorityRank: r.priority_rank, notes: r.notes, lat: r.lat, lng: r.lng, source: r.source, licenseNumber: r.license_number, lastVisited: r.last_visited });

app.get('/api/accounts', gate(async (req, res, user) => {
  const rows = await sql`SELECT * FROM accounts WHERE user_id = ${user.id} ORDER BY created_at DESC`;
  return json(res, rows.map(accToView));
}));

app.post('/api/accounts', gate(async (req, res, user) => {
  const a = req.body || {}; const id = a.id || 'a' + Date.now();
  if (!a.licenseNumber) return json(res, { error: 'OCM license number is required.' }, 400);
  const clash = await sql`SELECT id FROM accounts WHERE user_id = ${user.id} AND license_number = ${a.licenseNumber}`;
  if (clash.length) return json(res, { error: 'An account with this license number already exists.' }, 409);
  await sql`
    INSERT INTO accounts (id, user_id, name, dba, address, city, county, phone, email, contact_name, status, priority, priority_rank, notes, lat, lng, source, license_number, last_visited, created_at)
    VALUES (${id}, ${user.id}, ${a.name}, ${a.dba || ''}, ${a.address || ''}, ${a.city || ''}, ${a.county || ''}, ${a.phone || ''}, ${a.email || ''}, ${a.contactName || ''}, ${a.status || 'Prospect'}, ${a.priority ? 1 : 0}, ${a.priorityRank || 1}, ${a.notes || ''}, ${a.lat ?? null}, ${a.lng ?? null}, ${a.source || 'manual'}, ${a.licenseNumber}, ${a.lastVisited || null}, ${new Date().toISOString()})`;
  return json(res, { id });
}));

app.put('/api/accounts/:id', gate(async (req, res, user) => {
  const a = req.body || {};
  if (!a.licenseNumber) return json(res, { error: 'OCM license number is required.' }, 400);
  const clash = await sql`SELECT id FROM accounts WHERE user_id = ${user.id} AND license_number = ${a.licenseNumber} AND id != ${req.params.id}`;
  if (clash.length) return json(res, { error: 'An account with this license number already exists.' }, 409);
  await sql`
    UPDATE accounts SET name = ${a.name}, dba = ${a.dba || ''}, address = ${a.address || ''}, city = ${a.city || ''},
      county = ${a.county || ''}, phone = ${a.phone || ''}, email = ${a.email || ''}, contact_name = ${a.contactName || ''},
      status = ${a.status || 'Prospect'}, priority = ${a.priority ? 1 : 0}, priority_rank = ${a.priorityRank || 1},
      notes = ${a.notes || ''}, lat = ${a.lat ?? null}, lng = ${a.lng ?? null}, last_visited = ${a.lastVisited || null},
      license_number = ${a.licenseNumber}
    WHERE id = ${req.params.id} AND user_id = ${user.id}`;
  return json(res, { ok: true });
}));

app.delete('/api/accounts/:id', gate(async (req, res, user) => {
  await sql`DELETE FROM accounts WHERE id = ${req.params.id} AND user_id = ${user.id}`;
  return json(res, { ok: true });
}));

/* ================= expenses ================= */
app.get('/api/expenses', gate(async (req, res, user) => {
  const rows = await sql`SELECT id, date, category, amount, miles, notes FROM expenses WHERE user_id = ${user.id} ORDER BY date DESC`;
  return json(res, rows);
}));

app.post('/api/expenses', gate(async (req, res, user) => {
  const e2 = req.body || {}; const id = e2.id || 'e' + Date.now();
  await sql`INSERT INTO expenses (id, user_id, date, category, amount, miles, notes) VALUES (${id}, ${user.id}, ${e2.date}, ${e2.category}, ${e2.amount || 0}, ${e2.miles || 0}, ${e2.notes || ''})`;
  return json(res, { id });
}));

app.delete('/api/expenses/:id', gate(async (req, res, user) => {
  await sql`DELETE FROM expenses WHERE id = ${req.params.id} AND user_id = ${user.id}`;
  return json(res, { ok: true });
}));

/* ================= ocm-seen ================= */
app.get('/api/ocm-seen', gate(async (req, res, user) => {
  const rows = await sql`SELECT license_number FROM ocm_seen WHERE user_id = ${user.id}`;
  return json(res, rows.map((r) => r.license_number));
}));

app.post('/api/ocm-seen', gate(async (req, res, user) => {
  for (const ln of (req.body || {}).licenseNumbers || []) {
    await sql`INSERT INTO ocm_seen (user_id, license_number) VALUES (${user.id}, ${ln}) ON CONFLICT DO NOTHING`;
  }
  return json(res, { ok: true });
}));

/* ================= week plan ================= */
app.get('/api/week-plan', gate(async (req, res, user) => {
  const r = (await sql`SELECT value FROM kv WHERE user_id = ${user.id} AND key = 'week_plan'`)[0];
  return json(res, r ? JSON.parse(r.value) : {});
}));

app.put('/api/week-plan', gate(async (req, res, user) => {
  await sql`INSERT INTO kv (user_id, key, value) VALUES (${user.id}, 'week_plan', ${JSON.stringify(req.body)})
    ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`;
  return json(res, { ok: true });
}));

/* ================= route log ================= */
app.get('/api/route-log', gate(async (req, res, user) => {
  const rows = await sql`SELECT * FROM route_log WHERE user_id = ${user.id} ORDER BY date DESC`;
  return json(res, rows.map((r) => ({ id: r.id, date: r.date, day: r.day, stops: JSON.parse(r.stops || '[]'), miles: r.miles, minutes: r.minutes, dismissed: !!r.dismissed })));
}));

app.post('/api/route-log', gate(async (req, res, user) => {
  const l = req.body || {}; const id = l.id || 'log' + Date.now();
  await sql`INSERT INTO route_log (id, user_id, date, day, stops, miles, minutes, dismissed) VALUES (${id}, ${user.id}, ${l.date}, ${l.day || ''}, ${JSON.stringify(l.stops || [])}, ${l.miles || 0}, ${l.minutes || 0}, ${l.dismissed ? 1 : 0})`;
  return json(res, { id });
}));

/* ================= credits ================= */
app.get('/api/credits', gate(async (req, res, user) => {
  const rows = await sql`SELECT * FROM credits WHERE user_id = ${user.id} ORDER BY date DESC`;
  return json(res, rows.map(ledgerView));
}));

app.post('/api/credits', gate(async (req, res, user) => {
  const c = req.body || {};
  const context = commandContext(req, res, user, 'credits.adjust', c.accountId || null);
  if (!context) return undefined;
  const result = await adjustCredits(sql, {
    ownerUserId: user.id,
    accountId: c.accountId,
    amount: c.amount,
    note: c.note,
    date: c.date,
    accountName: c.accountName,
    licenseNumber: c.licenseNumber,
    city: c.city,
    ...context,
  });
  return sendCommandResult(res, result);
}));

/* ================= messages ================= */
const msgToView = (r) => ({ id: r.id, accountId: r.account_id, accountName: r.account_name, licenseNumber: r.license_number, city: r.city, channel: r.channel, purpose: r.purpose, body: r.body, to: r.recipient, direction: r.direction, date: r.date, status: r.status || 'logged', blastId: r.blast_id || null });

app.get('/api/messages', gate(async (req, res, user) => {
  const rows = await sql`SELECT * FROM messages WHERE user_id = ${user.id} ORDER BY date DESC`;
  return json(res, rows.map(msgToView));
}));

app.post('/api/messages', gate(async (req, res, user) => {
  const m2 = req.body || {}; const id = m2.id || 'msg' + Date.now();
  await sql`
    INSERT INTO messages (id, account_id, account_name, license_number, city, channel, purpose, body, recipient, direction, date, status, blast_id, user_id)
    VALUES (${id}, ${m2.accountId}, ${m2.accountName || ''}, ${m2.licenseNumber || ''}, ${m2.city || ''}, ${m2.channel || ''}, ${m2.purpose || ''}, ${m2.body || ''}, ${m2.to || ''}, ${m2.direction || 'outbound'}, ${m2.date}, ${m2.status || 'logged'}, ${m2.blastId || null}, ${user.id})`;
  return json(res, { id });
}));

app.delete('/api/messages/:id', gate(async (req, res, user) => {
  await sql`DELETE FROM messages WHERE id = ${req.params.id} AND user_id = ${user.id}`;
  return json(res, { ok: true });
}));

// send (or resend) a single SMS/email — sends via Twilio if configured, otherwise just logs it
app.post('/api/messages/send', gate(async (req, res, user) => {
  const { accountId, accountName, licenseNumber, city, channel, purpose, to, text } = req.body || {};
  let result = { sent: false, reason: 'not_configured' };
  if (channel === 'text' && to) result = await sendSmsTwilio(to, text);
  const status = channel !== 'text' ? 'logged' : (result.sent ? 'sent' : 'queued');
  const id = 'msg' + Date.now();
  await sql`
    INSERT INTO messages (id, account_id, account_name, license_number, city, channel, purpose, body, recipient, direction, date, status, blast_id, user_id)
    VALUES (${id}, ${accountId || ''}, ${accountName || ''}, ${licenseNumber || ''}, ${city || ''}, ${channel || 'text'}, ${purpose || ''}, ${text || ''}, ${to || ''}, 'outbound', ${new Date().toISOString()}, ${status}, ${null}, ${user.id})`;
  return json(res, { id, sent: result.sent, reason: result.reason });
}));

// bulk SMS blast — same message to many accounts
app.post('/api/messages/blast', gate(async (req, res, user) => {
  const { accountIds, template } = req.body || {};
  if (!Array.isArray(accountIds) || !accountIds.length) return json(res, { error: 'No recipients selected.' }, 400);
  const blastId = 'blast' + Date.now();
  const results = [];
  for (const accId of accountIds) {
    const rows = await sql`SELECT * FROM accounts WHERE id = ${accId} AND user_id = ${user.id}`;
    const acc = rows[0];
    if (!acc || !acc.phone) { results.push({ accountId: accId, ok: false, reason: 'no phone on file' }); continue; }
    const text = String(template || '').replace(/\{name\}/gi, acc.name || '');
    const result = await sendSmsTwilio(acc.phone, text);
    const status = result.sent ? 'sent' : 'queued';
    const id = 'msg' + Date.now() + Math.random().toString(36).slice(2, 6);
    await sql`
      INSERT INTO messages (id, account_id, account_name, license_number, city, channel, purpose, body, recipient, direction, date, status, blast_id, user_id)
      VALUES (${id}, ${acc.id}, ${acc.name}, ${acc.license_number || ''}, ${acc.city || ''}, 'text', 'SMS blast', ${text}, ${acc.phone}, 'outbound', ${new Date().toISOString()}, ${status}, ${blastId}, ${user.id})`;
    results.push({ accountId: accId, ok: true, sent: result.sent, reason: result.reason });
  }
  const sentCount = results.filter((r) => r.sent).length;
  const queuedCount = results.filter((r) => r.ok && !r.sent).length;
  const skipped = results.filter((r) => !r.ok).length;
  return json(res, { blastId, sent: sentCount, queued: queuedCount, skipped, smsEnabled: smsConfigured(), results });
}));

/* ================= store portal ================= */
// Event price table + booking requests from the store portal. Owners manage
// requests here; approvals debit credits atomically; cancelling an approved
// booking refunds them. portal_users in this table are the portal logins.
const DEFAULT_EVENT_TYPES = [
  { name: 'Brand activation', description: 'In-store demo & sampling day', base_hours: 4, base_price_credits: 120, extra_hour_credits: 30 },
  { name: 'Budtender training', description: 'Staff education session', base_hours: 2, base_price_credits: 80, extra_hour_credits: 40 },
];

async function seedEventTypes(userId) {
  const existing = await sql`SELECT COUNT(*)::int AS n FROM event_types WHERE owner_user_id = ${userId}`;
  if (Number(existing[0].n) > 0) return;
  for (const t of DEFAULT_EVENT_TYPES) {
    await sql`INSERT INTO event_types (id, owner_user_id, name, description, base_hours, base_price_credits, extra_hour_credits, active)
      VALUES (${'et' + Date.now() + Math.random().toString(36).slice(2, 6)}, ${userId}, ${t.name}, ${t.description}, ${t.base_hours}, ${t.base_price_credits}, ${t.extra_hour_credits}, 1)`;
  }
}

const etView = (r) => ({ id: r.id, name: r.name, description: r.description, baseHours: r.base_hours, basePriceCredits: r.base_price_credits, extraHourCredits: r.extra_hour_credits, active: !!r.active });

app.get('/api/event-types', gate(async (req, res, user) => {
  await seedEventTypes(user.id);
  const rows = await sql`SELECT * FROM event_types WHERE owner_user_id = ${user.id} ORDER BY active DESC, name`;
  return json(res, rows.map(etView));
}));

app.post('/api/event-types', gate(async (req, res, user) => {
  const b = req.body || {};
  const id = 'et' + Date.now() + Math.random().toString(36).slice(2, 6);
  await sql`INSERT INTO event_types (id, owner_user_id, name, description, base_hours, base_price_credits, extra_hour_credits, active)
    VALUES (${id}, ${user.id}, ${b.name || 'New event'}, ${b.description || ''}, ${b.baseHours ?? 4}, ${b.basePriceCredits ?? 0}, ${b.extraHourCredits ?? 0}, ${b.active === false ? 0 : 1})`;
  return json(res, { id });
}));

app.put('/api/event-types/:id', gate(async (req, res, user) => {
  const b = req.body || {};
  const updated = await sql`UPDATE event_types SET name = ${b.name}, description = ${b.description || ''},
      base_hours = ${b.baseHours ?? 4}, base_price_credits = ${b.basePriceCredits ?? 0},
      extra_hour_credits = ${b.extraHourCredits ?? 0}, active = ${b.active === false ? 0 : 1}
    WHERE id = ${req.params.id} AND owner_user_id = ${user.id}
    RETURNING id`;
  if (!updated.length) return json(res, { error: 'not found', code: 'EVENT_TYPE_NOT_FOUND' }, 404);
  return json(res, { ok: true });
}));

app.delete('/api/event-types/:id', gate(async (req, res, user) => {
  const used = await sql`SELECT id FROM bookings WHERE event_type_id = ${req.params.id} AND owner_user_id = ${user.id} LIMIT 1`;
  if (used.length) {
    return json(res, {
      error: 'This event type is referenced by a booking and cannot be deleted.',
      code: 'EVENT_TYPE_IN_USE',
    }, 409);
  }
  const updated = await sql`UPDATE event_types SET active = 0 WHERE id = ${req.params.id} AND owner_user_id = ${user.id} RETURNING id`;
  if (!updated.length) return json(res, { error: 'not found', code: 'EVENT_TYPE_NOT_FOUND' }, 404);
  return json(res, { ok: true });
}));

/* portal users + invites */
const PORTAL_ROLES = ['store_manager', 'store_staff', 'brand_ambassador'];

function inviteRole(role) {
  return PORTAL_ROLES.includes(role) ? role : 'store_manager';
}
function invitePathFor(role) {
  return role === 'brand_ambassador' ? '/staff/invite/' : '/store/invite/';
}
function inviteLink(token, role) {
  const base = (process.env.PORTAL_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return base + invitePathFor(role) + token;
}

app.get('/api/portal-users', gate(async (req, res, user) => {
  const rows = await sql`
    SELECT pu.*, a.name AS account_name, a.license_number AS account_license
    FROM portal_users pu LEFT JOIN accounts a ON a.id = pu.account_id
    WHERE pu.owner_user_id = ${user.id} ORDER BY pu.created_at DESC`;
  return json(res, rows.map((r) => ({
    id: r.id, name: r.name, email: r.email, role: r.role, status: r.status,
    accountId: r.account_id, accountName: r.account_name, licenseNumber: r.account_license, createdAt: r.created_at,
  })));
}));

app.put('/api/portal-users/:id/status', gate(async (req, res, user) => {
  const status = (req.body || {}).status === 'suspended' ? 'suspended' : 'active';
  const updated = await sql`UPDATE portal_users SET status = ${status}
    WHERE id = ${req.params.id} AND owner_user_id = ${user.id}
    RETURNING id`;
  if (!updated.length) return json(res, { error: 'not found', code: 'PORTAL_USER_NOT_FOUND' }, 404);
  return json(res, { ok: true });
}));

app.post('/api/portal-invites', gate(async (req, res, user) => {
  const { email, role, accountId } = req.body || {};
  const r = inviteRole(role);
  if (!email || !String(email).includes('@')) return json(res, { error: 'A valid email is required.' }, 400);
  const e = String(email).toLowerCase();
  const clash = await sql`SELECT id FROM portal_users WHERE email = ${e}`;
  if (clash.length) return json(res, { error: 'That email is already a portal user.' }, 409);
  let account = null;
  if (r !== 'brand_ambassador' && accountId) {
    account = (await sql`SELECT * FROM accounts WHERE id = ${accountId} AND user_id = ${user.id}`)[0];
    if (!account) return json(res, { error: 'Pick a valid client account to link.' }, 400);
  }
  const token = crypto.randomBytes(24).toString('hex');
  const id = 'inv' + Date.now();
  const expires = new Date(Date.now() + 7 * 864e5).toISOString();
  await sql`INSERT INTO portal_invites (id, email, role, account_id, owner_user_id, token, expires, created_at)
    VALUES (${id}, ${e}, ${r}, ${account ? account.id : null}, ${user.id}, ${token}, ${expires}, ${new Date().toISOString()})`;
  return json(res, {
    id, email: e, role: r, accountId: account ? account.id : null,
    token, expires, link: inviteLink(token, r), needsPortalUrl: !inviteLink(token, r),
  });
}));

app.get('/api/portal-invites', gate(async (req, res, user) => {
  const rows = await sql`SELECT * FROM portal_invites WHERE owner_user_id = ${user.id} ORDER BY created_at DESC`;
  return json(res, rows.map((inv) => {
    const expired = inv.expires && new Date(inv.expires).getTime() < Date.now();
    const status = inv.used_at ? 'used' : (expired ? 'expired' : 'pending');
    return {
      id: inv.id, email: inv.email, role: inv.role, accountId: inv.account_id,
      token: inv.token, expires: inv.expires, usedAt: inv.used_at, createdAt: inv.created_at,
      status, link: inviteLink(inv.token, inv.role),
    };
  }));
}));

app.delete('/api/portal-invites/:id', gate(async (req, res, user) => {
  const deleted = await sql`DELETE FROM portal_invites
    WHERE id = ${req.params.id} AND owner_user_id = ${user.id} AND used_at IS NULL
    RETURNING id`;
  if (!deleted.length) return json(res, { error: 'not found', code: 'PORTAL_INVITE_NOT_FOUND' }, 404);
  return json(res, { ok: true });
}));

app.delete('/api/portal-users/:id', gate(async (req, res, user) => {
  try {
    const target = await sql`SELECT id FROM portal_users
      WHERE id = ${req.params.id} AND owner_user_id = ${user.id}`;
    if (!target.length) return json(res, { error: 'not found', code: 'PORTAL_USER_NOT_FOUND' }, 404);
    await sql.begin(async (tx) => {
      await removePortalUsersBookings(tx, {
        ownerUserId: user.id,
        portalUserIds: [req.params.id],
        actor: { type: HQ_ACTOR_TYPE, id: user.id },
        key: `portal-user-delete:${user.id}:${req.params.id}`,
        requestHash: `portal-user-delete:${user.id}:${req.params.id}`,
      });
    });
    return json(res, { ok: true });
  } catch (e) {
    return json(res, internalError('portal user deletion', e), 500);
  }
}));

app.put('/api/portal-users/:id/account', gate(async (req, res, user) => {
  const accountId = (req.body || {}).accountId || null;
  if (accountId) {
    const acc = (await sql`SELECT id FROM accounts WHERE id = ${accountId} AND user_id = ${user.id}`)[0];
    if (!acc) return json(res, { error: 'That account does not belong to you.' }, 400);
  }
  const updated = await sql`UPDATE portal_users SET account_id = ${accountId}
    WHERE id = ${req.params.id} AND owner_user_id = ${user.id}
    RETURNING id`;
  if (!updated.length) return json(res, { error: 'not found', code: 'PORTAL_USER_NOT_FOUND' }, 404);
  return json(res, { ok: true });
}));

/* bookings */
function bookingWithAmbassador(row, ambassador) {
  return {
    ...sharedBookingView(row),
    ambassadorName: ambassador ? ambassador.name : null,
    ambassadorEmail: ambassador ? ambassador.email : null,
  };
}

async function bookingAmbMap(rows, ownerUserId) {
  const ids = [...new Set(rows.map((r) => r.ambassador_user_id).filter(Boolean))];
  if (!ids.length) return {};
  const users = await sql`
    SELECT id, name, email
      FROM portal_users
     WHERE owner_user_id = ${ownerUserId}
       AND id = ANY(${ids})`;
  const map = {}; users.forEach((a) => { map[a.id] = a; });
  return map;
}

app.get('/api/bookings', gate(async (req, res, user) => {
  const rows = await sql`SELECT * FROM bookings WHERE owner_user_id = ${user.id} ORDER BY date ASC, start_time ASC`;
  const map = await bookingAmbMap(rows, user.id);
  let out = rows.map((r) => bookingWithAmbassador(r, map[r.ambassador_user_id]));
  if (req.query.status) out = out.filter((x) => x.status === req.query.status);
  return json(res, out);
}));

app.put('/api/bookings/:id/assign', gate(async (req, res, user) => {
  const context = commandContext(req, res, user, 'booking.assign', req.params.id);
  if (!context) return undefined;
  const result = await assignBooking(sql, {
    ownerUserId: user.id,
    bookingId: req.params.id,
    ambassadorUserId: (req.body || {}).ambassadorUserId || null,
    ...context,
  });
  return sendCommandResult(res, result);
}));

app.put('/api/bookings/:id/approve', gate(async (req, res, user) => {
  const context = commandContext(req, res, user, 'booking.approve', req.params.id);
  if (!context) return undefined;
  const result = await approveBooking(sql, {
    ownerUserId: user.id,
    bookingId: req.params.id,
    ambassadorUserId: (req.body || {}).ambassadorUserId || null,
    notes: (req.body || {}).notes,
    ...context,
  });
  return sendCommandResult(res, result);
}));

app.put('/api/bookings/:id/decline', gate(async (req, res, user) => {
  const context = commandContext(req, res, user, 'booking.decline', req.params.id);
  if (!context) return undefined;
  const result = await declineBooking(sql, {
    ownerUserId: user.id,
    bookingId: req.params.id,
    notes: (req.body || {}).notes,
    ...context,
  });
  return sendCommandResult(res, result);
}));

app.put('/api/bookings/:id/cancel', gate(async (req, res, user) => {
  const context = commandContext(req, res, user, 'booking.cancel', req.params.id);
  if (!context) return undefined;
  const result = await cancelBooking(sql, {
    ownerUserId: user.id,
    bookingId: req.params.id,
    ...context,
  });
  return sendCommandResult(res, result);
}));

/* ================= AI message generation ================= */
app.post('/api/generate-message', gate(async (req, res, user) => {
  const data = await proxyAnthropic((req.body || {}).prompt);
  return json(res, data);
}));

/* ================= catch-all ================= */
app.use('/api', (req, res) => json(res, { error: 'not found' }, 404));

/* ================= static frontend (production) ================= */
const WEB_DIST = path.resolve(__dirname, '../../web/dist');
if (process.env.SERVE_WEB !== 'false' && fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
}

/* ================= error handling ================= */
app.use(makeErrorHandler());

/* ================= start ================= */
const PORT = parseInt(process.env.PORT || '8080', 10);
const boot = process.env.SKIP_SCHEMA === '1'
  ? Promise.resolve()
  : ensureSchema();
boot
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Territory HQ API listening on http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('FATAL: could not reach the database (check DATABASE_URL).', e && e.message ? e.message : e);
    process.exit(1);
  });