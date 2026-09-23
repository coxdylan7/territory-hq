// Demo/test provisioning for the Territory portal — run from api/ (has postgres installed):
//   SEED_DEMO=1 DATABASE_URL=$DATABASE_URL node scripts/seed-demo.js
// Creates clearly-labeled TEST data (accounts, credits, portal users, booking fixtures)
// owned by the first active admin. Safe to re-run: existing demo accounts are skipped.
// Clean up with SEED_DEMO=1 node scripts/cleanup-demo.js
const crypto = require('crypto');
const postgres = require('postgres');

if (!process.env.SEED_DEMO) {
  console.error('Refusing to run without SEED_DEMO=1 (this script mutates the shared database).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 4, prepare: false });

// console users password hash (PBKDF2 100k, sha256) — matches api/src/helpers.js
function consoleHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
}
// portal users password hash (PBKDF2 310k, sha256) — matches portal/api/src/server.js
function portalHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.pbkdf2Sync(String(pw), salt, 310000, 32, 'sha256').toString('hex');
}
const rid = (p) => p + Date.now() + Math.random().toString(36).slice(2, 7);
const iso = (d) => d.toISOString().slice(0, 10);
const days = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

const DEMO_PASSWORD = 'Demo1234';
const DEMO = {
  sales: 'sales@test.local',
  storeManager: 'store-manager@test.local',
  storeStaff: 'store-staff@test.local',
  ambassador: 'ambassador@test.local',
};

async function main() {
  const [owner] = await sql`SELECT * FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1`;
  if (!owner) { console.error('No active admin found to own the demo data.'); process.exit(1); }

  // 1. console 'sales' user (active)
  const sales = await sql`SELECT id FROM users WHERE email = ${DEMO.sales}`;
  if (!sales.length) {
    await sql`INSERT INTO users (id, name, email, pass_hash, role, status, created_at)
      VALUES (${rid('u')}, 'Demo Sales', ${DEMO.sales}, ${consoleHash(DEMO_PASSWORD)}, 'sales', 'active', ${new Date().toISOString()})`;
    console.log('+ console sales user');
  }

  // 2. event types (skip if owner already has any)
  const ets = await sql`SELECT id, name FROM event_types WHERE owner_user_id = ${owner.id} ORDER BY base_hours`;
  if (!ets.length) {
    const defs = [
      ['Brand activation', 4, 120, 30],
      ['Budtender training', 2, 80, 40],
    ];
    for (const [name, bh, bp, ex] of defs) {
      await sql`INSERT INTO event_types (id, owner_user_id, name, description, base_hours, base_price_credits, extra_hour_credits, active)
        VALUES (${rid('et')}, ${owner.id}, ${name}, '', ${bh}, ${bp}, ${ex}, 1)`;
      console.log('+ event type: ' + name);
    }
  }

  // 3. TEST stores + credits
  const mkStore = async (name, credits) => {
    const ex = await sql`SELECT id FROM accounts WHERE name = ${name} AND user_id = ${owner.id}`;
    if (ex.length) { console.log('= store exists: ' + name); return ex[0].id; }
    const id = rid('a');
    await sql`INSERT INTO accounts (id, user_id, name, dba, address, city, county, phone, email, contact_name, status, priority, priority_rank, notes, lat, lng, source, license_number, last_visited, created_at)
      VALUES (${id}, ${owner.id}, ${name}, '', '1 Demo Way', 'Albany', 'Albany', '(555) 000-0000', '', 'Demo Manager', 'Prospect', 0, 1, 'TEST DATA — created by scripts/seed-demo.js', null, null, 'manual', 'TEST-' + (name.includes('A') ? 'A' : 'B'), null, ${new Date().toISOString()})`;
    await sql`INSERT INTO credits (id, user_id, account_id, account_name, license_number, city, amount, note, date)
      VALUES (${rid('cr')}, ${owner.id}, ${id}, ${name}, 'TEST-' + (name.includes('A') ? 'A' : 'B'), 'Albany', ${credits}, 'Demo credit grant (TEST data)', ${iso(new Date())})`;
    console.log('+ store: ' + name + ' with ' + credits + ' cr');
    return id;
  };
  const storeA = await mkStore('TEST — Store A', 250);
  const storeB = await mkStore('TEST — Store B', 120);

  // 4. portal users
  const mkPortal = async (email, name, role, accountId) => {
    const ex = await sql`SELECT id FROM portal_users WHERE email = ${email}`;
    if (ex.length) { console.log('= portal user exists: ' + email); return ex[0].id; }
    const id = rid('pu');
    await sql`INSERT INTO portal_users (id, name, email, role, account_id, owner_user_id, pass_hash, status, created_at)
      VALUES (${id}, ${name}, ${email}, ${role}, ${accountId}, ${owner.id}, ${portalHash(DEMO_PASSWORD)}, 'active', ${new Date().toISOString()})`;
    console.log('+ portal user: ' + email + ' (' + role + ')');
    return id;
  };
  await mkPortal(DEMO.storeManager, 'Store Manager', 'store_manager', storeA);
  await mkPortal(DEMO.storeStaff, 'Store Staff', 'store_staff', storeA);
  const ambId = await mkPortal(DEMO.ambassador, 'Brand Ambassador', 'brand_ambassador', null);

  // 5. booking fixtures across statuses
  const etList = (await sql`SELECT id, name FROM event_types WHERE owner_user_id = ${owner.id}`).slice(0, 2);
  const etA = etList[0] || { id: null, name: 'Brand activation' };
  const mkBooking = async ({ date, status, accountId, ambId: a, charged, eventTypeId, notes }) => {
    const id = rid('bk');
    await sql`INSERT INTO bookings (id, owner_user_id, account_id, account_name, license_number, event_type_id, event_type_name, date, start_time, duration_hours, credits_charged, status, ambassador_user_id, notes_client, notes_admin, created_at, updated_at)
      VALUES (${id}, ${owner.id}, ${accountId}, ${'TEST — Store A'}, 'TEST-A', ${eventTypeId}, ${etA.name}, ${date}, '10:00', 4, ${charged !== undefined ? charged : null}, ${status}, ${a || null}, null, ${notes || null}, ${new Date().toISOString()}, null)`;
  };
  const seed = await sql`SELECT COUNT(*)::int AS n FROM bookings WHERE owner_user_id = ${owner.id} AND account_id = ${storeA} AND notes_admin LIKE '%seed-demo%'`;
  if (Number(seed[0].n) === 0) {
    await mkBooking({ date: iso(days(+1)), status: 'requested', accountId: storeA, eventTypeId: etA.id, notes: 'seed-demo' });
    await mkBooking({ date: iso(days(+3)), status: 'approved', accountId: storeB, eventTypeId: etA.id, charged: 120, a: ambId, notes: 'seed-demo' });
    await mkBooking({ date: iso(days(+5)), status: 'confirmed', accountId: storeA, eventTypeId: etA.id, charged: 120, a: ambId, notes: 'seed-demo' });
    await mkBooking({ date: iso(days(-3)), status: 'completed', accountId: storeA, eventTypeId: etA.id, charged: 80, a: ambId, notes: 'seed-demo' });
    await mkBooking({ date: iso(days(-6)), status: 'declined', accountId: storeA, eventTypeId: etA.id, notes: 'seed-demo' });
    await mkBooking({ date: iso(days(-2)), status: 'cancelled', accountId: storeB, eventTypeId: etA.id, charged: 120, notes: 'seed-demo' });
    console.log('+ 6 booking fixtures');
  } else {
    console.log('= booking fixtures already present');
  }

  console.log('\n===== TEST credentials (password: ' + DEMO_PASSWORD + ') =====');
  console.log('Console  — ' + DEMO.sales + '  (sales)');
  console.log('Store    — ' + DEMO.storeManager + '  (store manager, TEST — Store A)');
  console.log('Store    — ' + DEMO.storeStaff + '  (store staff, read-only, TEST — Store A)');
  console.log('Ambassad — ' + DEMO.ambassador + '  (brand ambassador)');
  console.log('Login base URL: https://<portals>/store/  and  /staff/');
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });