// Territory HQ — Netlify Functions backend (multi-tenant, Turso/libSQL)
const crypto = require('crypto');

/* ================= Turso (libSQL over HTTP) ================= */
async function sql(query, args = []) {
  let url = (process.env.TURSO_DATABASE_URL || '').trim();
  if (!url) throw new Error('TURSO_DATABASE_URL not set');
  url = url.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '').split('?')[0];
  const typed = args.map(v => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'number') {
      return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    }
    return { type: 'text', value: String(v) };
  });
  const res = await fetch(url + '/v2/pipeline', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + (process.env.TURSO_AUTH_TOKEN || '').trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: query, args: typed } }, { type: 'close' }] })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('db http ' + res.status + (text ? ': ' + text.slice(0, 200) : ''));
  }
  const data = await res.json();
  const r = data.results && data.results[0];
  if (!r) throw new Error('db: no result');
  if (r.type === 'error') throw new Error('db: ' + (r.error && r.error.message));
  const resp = r.response && r.response.result;
  const cols = ((resp && resp.cols) || []).map(c => c.name);
  return ((resp && resp.rows) || []).map(row => {
    const o = {};
    row.forEach((cell, i) => {
      o[cols[i]] = cell.value === undefined || cell.type === 'null' ? null :
        (cell.type === 'integer' || cell.type === 'float') ? Number(cell.value) : cell.value;
    });
    return o;
  });
}

let schemaDone = false;
async function ensureSchema() {
  if (schemaDone) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, pass_hash TEXT, role TEXT DEFAULT 'user', status TEXT DEFAULT 'pending', sub_expires TEXT, plan TEXT DEFAULT 'standard', created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT, expires TEXT)`,
    `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, dba TEXT, address TEXT, city TEXT, county TEXT, phone TEXT, email TEXT, contact_name TEXT, status TEXT, priority INTEGER DEFAULT 0, priority_rank INTEGER DEFAULT 1, notes TEXT, lat REAL, lng REAL, source TEXT, license_number TEXT, last_visited TEXT, created_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, category TEXT, amount REAL, miles REAL, notes TEXT)`,
    `CREATE TABLE IF NOT EXISTS settings (user_id TEXT PRIMARY KEY, home_address TEXT, home_lat REAL, home_lng REAL, counties TEXT DEFAULT '[]', work_days TEXT DEFAULT '["Mon","Tue","Wed","Thu","Fri"]', mileage_rate REAL DEFAULT 0.70, gmaps_key TEXT DEFAULT '', default_credit REAL DEFAULT 0, alert_email TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS ocm_seen (user_id TEXT, license_number TEXT, PRIMARY KEY (user_id, license_number))`,
    `CREATE TABLE IF NOT EXISTS kv (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY (user_id, key))`,
    `CREATE TABLE IF NOT EXISTS route_log (id TEXT PRIMARY KEY, user_id TEXT, date TEXT, day TEXT, stops TEXT, miles REAL, minutes REAL, dismissed INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS credits (id TEXT PRIMARY KEY, user_id TEXT, account_id TEXT, account_name TEXT, license_number TEXT, city TEXT, amount REAL, note TEXT, date TEXT)`,
    `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user_id TEXT, account_id TEXT, account_name TEXT, license_number TEXT, city TEXT, channel TEXT, purpose TEXT, body TEXT, recipient TEXT, direction TEXT, date TEXT)`
  ];
  for (const s of stmts) await sql(s);
  // idempotent migrations for columns added after initial release
  const migrations = [
    `ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'logged'`,
    `ALTER TABLE messages ADD COLUMN blast_id TEXT`
  ];
  for (const m of migrations) { try { await sql(m); } catch (e) { /* column already exists */ } }
  schemaDone = true;
}

/* ================= Twilio (optional; falls back gracefully if unset) ================= */
function smsConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}
async function sendSmsTwilio(to, bodyText) {
  if (!smsConfigured()) return { sent: false, reason: 'not_configured' };
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM_NUMBER;
  const auth = Buffer.from(sid + ':' + token).toString('base64');
  const params = new URLSearchParams({ To: to, From: from, Body: bodyText });
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) return { sent: false, reason: data.message || ('http ' + res.status) };
    return { sent: true, sid: data.sid };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

/* ================= auth helpers ================= */
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
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function getBearer(event) {
  const h = event.headers.authorization || event.headers.Authorization || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}
async function currentUser(event) {
  const token = getBearer(event);
  if (!token) return null;
  const rows = await sql(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?`,
    [token, new Date().toISOString()]);
  return rows[0] || null;
}
function userView(u) {
  const today = new Date().toISOString().slice(0, 10);
  let status = u.status;
  if (status === 'active' && u.role !== 'admin' && u.sub_expires && u.sub_expires < today) status = 'expired';
  return { id: u.id, name: u.name, email: u.email, role: u.role, status, subExpires: u.sub_expires, plan: u.plan, createdAt: u.created_at };
}
function isUsable(u) {
  const v = userView(u);
  return v.status === 'active';
}

/* ================= response helpers ================= */
const SEC = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains'
};
function json(obj, status) {
  return { statusCode: status || 200, headers: { 'content-type': 'application/json', ...SEC }, body: JSON.stringify(obj) };
}
function jsonCors(obj, event, status) {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'content-type': 'application/json', vary: 'Origin', ...SEC };
  if (allow.length && (allow.includes('*') || allow.includes(origin))) {
    h['access-control-allow-origin'] = allow.includes('*') ? '*' : origin;
    h['access-control-allow-methods'] = 'GET, OPTIONS';
    h['access-control-allow-headers'] = 'authorization, content-type';
  }
  return { statusCode: status || 200, headers: h, body: JSON.stringify(obj) };
}
function readToken(event) {
  return crypto.timingSafeEqual
    ? safeEq(getBearer(event), process.env.READ_TOKEN || '')
    : getBearer(event) === (process.env.READ_TOKEN || '');
}
function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/* ================= main handler ================= */
exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method === 'OPTIONS') return jsonCors({}, event, 204);

  try {
    // path after /.netlify/functions/api/
    const m = event.path.match(/\/api\/?(.*)$/);
    const parts = (m ? m[1] : '').split('/').filter(Boolean); // e.g. ['accounts','a123']
    const q = event.queryStringParameters || {};
    let body = {};
    if (event.body) {
      let raw = event.body;
      if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
      try { body = raw ? JSON.parse(raw) : {}; }
      catch (e) { return json({ error: 'invalid JSON body' }, 400); }
    }

    await ensureSchema();

    /* ---------- public: auth ---------- */
    if (parts[0] === 'auth' && parts[1] === 'signup' && method === 'POST') {
      const { name, email, password } = body;
      if (!name || !email || !password || password.length < 8) return json({ error: 'Name, email, and an 8+ character password are required.' }, 400);
      const existing = await sql('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
      if (existing.length) return json({ error: 'An account with that email already exists.' }, 409);
      const count = await sql('SELECT COUNT(*) as n FROM users');
      const isFirst = Number(count[0].n) === 0;
      const isBootstrapAdmin = isFirst || (process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase());
      const id = 'u' + Date.now();
      await sql('INSERT INTO users (id,name,email,pass_hash,role,status,created_at) VALUES (?,?,?,?,?,?,?)',
        [id, name, email.toLowerCase(), hashPassword(password), isBootstrapAdmin ? 'admin' : 'user', isBootstrapAdmin ? 'active' : 'pending', new Date().toISOString()]);
      if (isBootstrapAdmin) {
        const token = newToken();
        const exp = new Date(Date.now() + 30 * 864e5).toISOString();
        await sql('INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)', [token, id, exp]);
        return json({ ok: true, token });
      }
      return json({ ok: true, pending: true });
    }
    if (parts[0] === 'auth' && parts[1] === 'login' && method === 'POST') {
      const { email, password } = body;
      const rows = await sql('SELECT * FROM users WHERE email = ?', [(email || '').toLowerCase()]);
      const u = rows[0];
      if (!u || !verifyPassword(password || '', u.pass_hash)) return json({ error: 'Invalid email or password.' }, 401);
      const token = newToken();
      const exp = new Date(Date.now() + 30 * 864e5).toISOString();
      await sql('INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)', [token, u.id, exp]);
      return json({ ok: true, token, user: userView(u) });
    }
    if (parts[0] === 'auth' && parts[1] === 'logout' && method === 'POST') {
      const token = getBearer(event);
      if (token) await sql('DELETE FROM sessions WHERE token = ?', [token]);
      return json({ ok: true });
    }

    /* ---------- public: cross-app reads (READ_TOKEN) ---------- */
    if (parts[0] === 'credits' && parts[1] === 'balances' && method === 'GET') {
      if (!safeEq(getBearer(event), process.env.READ_TOKEN || '')) return jsonCors({ error: 'unauthorized' }, event, 401);
      const rows = await sql('SELECT account_id, account_name, license_number, city, SUM(amount) as balance FROM credits GROUP BY account_id');
      let out = rows.map(r => ({ accountId: r.account_id, accountName: r.account_name, licenseNumber: r.license_number, city: r.city, balance: r.balance }));
      if (q.license) out = out.filter(x => x.licenseNumber === q.license);
      return jsonCors(out, event);
    }
    if (parts[0] === 'messages' && parts[1] === 'shared' && method === 'GET') {
      if (!safeEq(getBearer(event), process.env.READ_TOKEN || '')) return jsonCors({ error: 'unauthorized' }, event, 401);
      const rows = await sql('SELECT * FROM messages ORDER BY date DESC');
      let out = rows.map(r => ({ id: r.id, accountId: r.account_id, accountName: r.account_name, licenseNumber: r.license_number, city: r.city, channel: r.channel, purpose: r.purpose, body: r.body, to: r.recipient, direction: r.direction, date: r.date }));
      if (q.license) out = out.filter(x => x.licenseNumber === q.license);
      return jsonCors(out, event);
    }

    /* ---------- everything below requires a signed-in user ---------- */
    const user = await currentUser(event);
    if (!user) return json({ error: 'unauthorized' }, 401);

    if (parts[0] === 'me' && method === 'GET') return json({ ...userView(user), smsEnabled: smsConfigured() });

    /* ---------- admin ---------- */
    if (parts[0] === 'admin') {
      if (user.role !== 'admin') return json({ error: 'forbidden' }, 403);
      if (parts[1] === 'users' && parts.length === 2 && method === 'GET') {
        const rows = await sql('SELECT * FROM users ORDER BY created_at DESC');
        return json(rows.map(userView));
      }
      if (parts[1] === 'users' && parts.length === 3 && method === 'PUT') {
        const id = parts[2];
        const target = (await sql('SELECT * FROM users WHERE id=?', [id]))[0];
        if (!target) return json({ error: 'not found' }, 404);
        const status = body.status !== undefined ? body.status : target.status;
        const role = body.role !== undefined ? body.role : target.role;
        const subExpires = body.subExpires !== undefined ? body.subExpires : target.sub_expires;
        await sql('UPDATE users SET status=?, role=?, sub_expires=? WHERE id=?', [status, role, subExpires, id]);
        if (status === 'suspended') await sql('DELETE FROM sessions WHERE user_id=?', [id]);
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    }

    // active-subscription gate for all data routes
    if (!isUsable(user)) return json({ error: 'inactive', reason: userView(user).status }, 402);
    const uid = user.id;

    /* ---------- settings (per user) ---------- */
    if (parts[0] === 'settings') {
      if (method === 'GET') {
        const r = (await sql('SELECT * FROM settings WHERE user_id=?', [uid]))[0];
        return json({
          homeAddress: (r && r.home_address) || '', homeLat: r ? r.home_lat : null, homeLng: r ? r.home_lng : null,
          counties: JSON.parse((r && r.counties) || '[]'), workDays: JSON.parse((r && r.work_days) || '["Mon","Tue","Wed","Thu","Fri"]'),
          mileageRate: r && r.mileage_rate != null ? r.mileage_rate : 0.70, gmapsKey: (r && r.gmaps_key) || '',
          defaultCredit: (r && r.default_credit) || 0, alertEmail: (r && r.alert_email) || ''
        });
      }
      if (method === 'PUT') {
        const s = body;
        await sql(`INSERT INTO settings (user_id,home_address,home_lat,home_lng,counties,work_days,mileage_rate,gmaps_key,default_credit,alert_email)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET home_address=excluded.home_address, home_lat=excluded.home_lat, home_lng=excluded.home_lng,
          counties=excluded.counties, work_days=excluded.work_days, mileage_rate=excluded.mileage_rate, gmaps_key=excluded.gmaps_key,
          default_credit=excluded.default_credit, alert_email=excluded.alert_email`,
          [uid, s.homeAddress || '', s.homeLat ?? null, s.homeLng ?? null, JSON.stringify(s.counties || []), JSON.stringify(s.workDays || []),
            s.mileageRate ?? 0.70, s.gmapsKey || '', s.defaultCredit || 0, s.alertEmail || '']);
        return json({ ok: true });
      }
    }

    /* ---------- accounts ---------- */
    const accToView = r => ({ id: r.id, name: r.name, dba: r.dba, address: r.address, city: r.city, county: r.county, phone: r.phone, email: r.email, contactName: r.contact_name, status: r.status, priority: !!r.priority, priorityRank: r.priority_rank, notes: r.notes, lat: r.lat, lng: r.lng, source: r.source, licenseNumber: r.license_number, lastVisited: r.last_visited });
    if (parts[0] === 'accounts') {
      if (parts.length === 1 && method === 'GET') {
        return json((await sql('SELECT * FROM accounts WHERE user_id=? ORDER BY created_at DESC', [uid])).map(accToView));
      }
      if (parts.length === 1 && method === 'POST') {
        const a = body; const id = a.id || 'a' + Date.now();
        if (!a.licenseNumber) return json({ error: 'OCM license number is required.' }, 400);
        const clash = await sql('SELECT id FROM accounts WHERE user_id=? AND license_number=?', [uid, a.licenseNumber]);
        if (clash.length) return json({ error: 'An account with this license number already exists.' }, 409);
        await sql(`INSERT INTO accounts (id,user_id,name,dba,address,city,county,phone,email,contact_name,status,priority,priority_rank,notes,lat,lng,source,license_number,last_visited,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, uid, a.name, a.dba || '', a.address || '', a.city || '', a.county || '', a.phone || '', a.email || '', a.contactName || '', a.status || 'Prospect', a.priority ? 1 : 0, a.priorityRank || 1, a.notes || '', a.lat ?? null, a.lng ?? null, a.source || 'manual', a.licenseNumber, a.lastVisited || null, new Date().toISOString()]);
        return json({ id });
      }
      if (parts.length === 2 && method === 'PUT') {
        const a = body;
        if (!a.licenseNumber) return json({ error: 'OCM license number is required.' }, 400);
        const clash = await sql('SELECT id FROM accounts WHERE user_id=? AND license_number=? AND id!=?', [uid, a.licenseNumber, parts[1]]);
        if (clash.length) return json({ error: 'An account with this license number already exists.' }, 409);
        await sql(`UPDATE accounts SET name=?,dba=?,address=?,city=?,county=?,phone=?,email=?,contact_name=?,status=?,priority=?,priority_rank=?,notes=?,lat=?,lng=?,last_visited=?,license_number=? WHERE id=? AND user_id=?`,
          [a.name, a.dba || '', a.address || '', a.city || '', a.county || '', a.phone || '', a.email || '', a.contactName || '', a.status || 'Prospect', a.priority ? 1 : 0, a.priorityRank || 1, a.notes || '', a.lat ?? null, a.lng ?? null, a.lastVisited || null, a.licenseNumber, parts[1], uid]);
        return json({ ok: true });
      }
      if (parts.length === 2 && method === 'DELETE') {
        await sql('DELETE FROM accounts WHERE id=? AND user_id=?', [parts[1], uid]);
        return json({ ok: true });
      }
    }

    /* ---------- expenses ---------- */
    if (parts[0] === 'expenses') {
      if (parts.length === 1 && method === 'GET') return json(await sql('SELECT id,date,category,amount,miles,notes FROM expenses WHERE user_id=? ORDER BY date DESC', [uid]));
      if (parts.length === 1 && method === 'POST') {
        const e2 = body; const id = e2.id || 'e' + Date.now();
        await sql('INSERT INTO expenses (id,user_id,date,category,amount,miles,notes) VALUES (?,?,?,?,?,?,?)', [id, uid, e2.date, e2.category, e2.amount || 0, e2.miles || 0, e2.notes || '']);
        return json({ id });
      }
      if (parts.length === 2 && method === 'DELETE') {
        await sql('DELETE FROM expenses WHERE id=? AND user_id=?', [parts[1], uid]);
        return json({ ok: true });
      }
    }

    /* ---------- ocm-seen ---------- */
    if (parts[0] === 'ocm-seen') {
      if (method === 'GET') return json((await sql('SELECT license_number FROM ocm_seen WHERE user_id=?', [uid])).map(r => r.license_number));
      if (method === 'POST') {
        for (const ln of (body.licenseNumbers || [])) await sql('INSERT OR IGNORE INTO ocm_seen (user_id,license_number) VALUES (?,?)', [uid, ln]);
        return json({ ok: true });
      }
    }

    /* ---------- week plan ---------- */
    if (parts[0] === 'week-plan') {
      if (method === 'GET') {
        const r = (await sql(`SELECT value FROM kv WHERE user_id=? AND key='week_plan'`, [uid]))[0];
        return json(r ? JSON.parse(r.value) : {});
      }
      if (method === 'PUT') {
        await sql(`INSERT INTO kv (user_id,key,value) VALUES (?,'week_plan',?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value`, [uid, JSON.stringify(body)]);
        return json({ ok: true });
      }
    }

    /* ---------- route log ---------- */
    if (parts[0] === 'route-log') {
      if (method === 'GET') return json((await sql('SELECT * FROM route_log WHERE user_id=? ORDER BY date DESC', [uid])).map(r => ({ id: r.id, date: r.date, day: r.day, stops: JSON.parse(r.stops || '[]'), miles: r.miles, minutes: r.minutes, dismissed: !!r.dismissed })));
      if (method === 'POST') {
        const l = body; const id = l.id || 'log' + Date.now();
        await sql('INSERT INTO route_log (id,user_id,date,day,stops,miles,minutes,dismissed) VALUES (?,?,?,?,?,?,?,?)', [id, uid, l.date, l.day || '', JSON.stringify(l.stops || []), l.miles || 0, l.minutes || 0, l.dismissed ? 1 : 0]);
        return json({ id });
      }
    }

    /* ---------- credits ---------- */
    if (parts[0] === 'credits') {
      if (parts.length === 1 && method === 'GET') return json((await sql('SELECT * FROM credits WHERE user_id=? ORDER BY date DESC', [uid])).map(r => ({ id: r.id, accountId: r.account_id, accountName: r.account_name, licenseNumber: r.license_number, city: r.city, amount: r.amount, note: r.note, date: r.date })));
      if (parts.length === 1 && method === 'POST') {
        const c = body; const id = c.id || 'cr' + Date.now();
        await sql('INSERT INTO credits (id,user_id,account_id,account_name,license_number,city,amount,note,date) VALUES (?,?,?,?,?,?,?,?,?)', [id, uid, c.accountId, c.accountName || '', c.licenseNumber || '', c.city || '', c.amount || 0, c.note || '', c.date]);
        return json({ id });
      }
    }

    /* ---------- messages ---------- */
    if (parts[0] === 'messages') {
      const msgToView = r => ({ id: r.id, accountId: r.account_id, accountName: r.account_name, licenseNumber: r.license_number, city: r.city, channel: r.channel, purpose: r.purpose, body: r.body, to: r.recipient, direction: r.direction, date: r.date, status: r.status || 'logged', blastId: r.blast_id || null });
      if (parts.length === 1 && method === 'GET') {
        const rows = await sql('SELECT * FROM messages WHERE user_id=? ORDER BY date DESC', [uid]);
        return json(rows.map(msgToView));
      }
      if (parts.length === 1 && method === 'POST') {
        const m2 = body; const id = m2.id || 'msg' + Date.now();
        await sql('INSERT INTO messages (id,user_id,account_id,account_name,license_number,city,channel,purpose,body,recipient,direction,date,status,blast_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, uid, m2.accountId, m2.accountName || '', m2.licenseNumber || '', m2.city || '', m2.channel || '', m2.purpose || '', m2.body || '', m2.to || '', m2.direction || 'outbound', m2.date, m2.status || 'logged', m2.blastId || null]);
        return json({ id });
      }
      if (parts.length === 2 && method === 'DELETE') {
        await sql('DELETE FROM messages WHERE id=? AND user_id=?', [parts[1], uid]);
        return json({ ok: true });
      }
      // send (or resend) a single SMS/email — sends via Twilio if configured, otherwise just logs it
      if (parts[1] === 'send' && method === 'POST') {
        const { accountId, accountName, licenseNumber, city, channel, purpose, to, text } = body;
        let result = { sent: false, reason: 'not_configured' };
        if (channel === 'text' && to) result = await sendSmsTwilio(to, text);
        const status = channel !== 'text' ? 'logged' : (result.sent ? 'sent' : 'queued');
        const id = 'msg' + Date.now();
        await sql('INSERT INTO messages (id,user_id,account_id,account_name,license_number,city,channel,purpose,body,recipient,direction,date,status,blast_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, uid, accountId || '', accountName || '', licenseNumber || '', city || '', channel || 'text', purpose || '', text || '', to || '', 'outbound', new Date().toISOString(), status, null]);
        return json({ id, sent: result.sent, reason: result.reason });
      }
      // bulk SMS blast — same message to many accounts; sends via Twilio if configured, else logs as queued for future integration
      if (parts[1] === 'blast' && method === 'POST') {
        const { accountIds, template } = body;
        if (!Array.isArray(accountIds) || !accountIds.length) return json({ error: 'No recipients selected.' }, 400);
        const blastId = 'blast' + Date.now();
        const results = [];
        for (const accId of accountIds) {
          const rows = await sql('SELECT * FROM accounts WHERE id=? AND user_id=?', [accId, uid]);
          const acc = rows[0];
          if (!acc || !acc.phone) { results.push({ accountId: accId, ok: false, reason: 'no phone on file' }); continue; }
          const text = String(template || '').replace(/\{name\}/gi, acc.name || '');
          let result = { sent: false, reason: 'not_configured' };
          result = await sendSmsTwilio(acc.phone, text);
          const status = result.sent ? 'sent' : 'queued';
          const id = 'msg' + Date.now() + Math.random().toString(36).slice(2, 6);
          await sql('INSERT INTO messages (id,user_id,account_id,account_name,license_number,city,channel,purpose,body,recipient,direction,date,status,blast_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [id, uid, acc.id, acc.name, acc.license_number || '', acc.city || '', 'text', 'SMS blast', text, acc.phone, 'outbound', new Date().toISOString(), status, blastId]);
          results.push({ accountId: accId, ok: true, sent: result.sent, reason: result.reason });
        }
        const sentCount = results.filter(r => r.sent).length;
        const queuedCount = results.filter(r => r.ok && !r.sent).length;
        const skipped = results.filter(r => !r.ok).length;
        return json({ blastId, sent: sentCount, queued: queuedCount, skipped, smsEnabled: smsConfigured(), results });
      }
    }

    /* ---------- AI message generation ---------- */
    if (parts[0] === 'generate-message' && method === 'POST') {
      if (!process.env.ANTHROPIC_API_KEY) return json({ content: [{ type: 'text', text: '(No ANTHROPIC_API_KEY configured on this site.)' }] });
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1000, messages: [{ role: 'user', content: body.prompt }] })
      });
      return json(await res.json());
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    console.error('API ERROR:', e && e.stack ? e.stack : e);
    return json({ error: e.message }, 500);
  }
};
