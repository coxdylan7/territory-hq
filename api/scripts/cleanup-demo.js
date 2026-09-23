// Removes ALL TEST data created by scripts/seed-demo.js. Run from api/:
//   SEED_DEMO=1 DATABASE_URL=$DATABASE_URL node scripts/cleanup-demo.js
// Deletes: demo portal users, TEST stores (+ their credits) created by the seed,
// booking fixtures, and unused demo invites. Console 'sales' user is removed too.
// Idempotent — safe to re-run.
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

const DEMO_PORTAL_EMAILS = [
  'store-manager@test.local',
  'store-staff@test.local',
  'ambassador@test.local',
];
const DEMO_SALES_EMAIL = 'sales@test.local';

async function main() {
  const a = await sql`
    DELETE FROM bookings WHERE account_id IN (
      SELECT id FROM accounts WHERE name IN ('TEST — Store A', 'TEST — Store B') AND notes = 'TEST DATA — created by scripts/seed-demo.js'
    )
  `;
  console.log('bookings removed:', a.length);

  const b = await sql`DELETE FROM portal_users WHERE email = ANY(${DEMO_PORTAL_EMAILS})`;
  console.log('portal users removed:', b.length);

  const c = await sql`
    DELETE FROM portal_invites WHERE email = ANY(${DEMO_PORTAL_EMAILS})
  `;
  console.log('demo invites removed:', c.length);

  const d = await sql`
    DELETE FROM credits WHERE account_id IN (
      SELECT id FROM accounts WHERE name IN ('TEST — Store A', 'TEST — Store B') AND notes = 'TEST DATA — created by scripts/seed-demo.js'
    )
  `;
  console.log('demo credits removed:', d.length);

  const e = await sql`
    DELETE FROM accounts WHERE name IN ('TEST — Store A', 'TEST — Store B') AND notes = 'TEST DATA — created by scripts/seed-demo.js'
  `;
  console.log('TEST stores removed:', e.length);

  const f = await sql`DELETE FROM users WHERE email = ${DEMO_SALES_EMAIL}`;
  console.log('demo sales user removed:', f.length);

  console.log('\nDone. Event types/pricing and real accounts were left untouched.');
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });