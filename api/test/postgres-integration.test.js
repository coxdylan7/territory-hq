'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { makeEnsureSchema } = require('../src/schema');
const {
  approveBooking,
  cancelBooking,
  createBooking,
  removePortalUsersBookings,
} = require('../src/booking-service');
const { activatePortalInvite } = require('../../portal/api/src/invite-activation');
const { createBlastService } = require('../src/messages-blast');
const { canonicalRequestHash } = require('../src/idempotency');

const databaseUrl = process.env.TEST_DATABASE_URL;
const dbTest = databaseUrl ? test : test.skip;

async function setupDatabase(t, { connections = 1 } = {}) {
  const postgres = require('postgres');
  const schema = 'ledger_test_' + crypto.randomBytes(6).toString('hex');
  const admin = postgres(databaseUrl, { max: 1 });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);

  const makeClient = () => postgres(databaseUrl, {
    max: 1,
    connection: { search_path: schema },
  });
  const sql = makeClient();
  const clients = [sql];
  for (let i = 1; i < connections; i += 1) clients.push(makeClient());

  await makeEnsureSchema(sql, { schema })();
  await seed(sql);

  t.after(async () => {
    for (const client of clients) await client.end({ timeout: 2 });
    await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end({ timeout: 2 });
  });

  return { sql, clients, schema };
}

async function seed(sql) {
  await sql`INSERT INTO users (id, name, email, status) VALUES ('owner-1', 'Owner', 'owner@example.test', 'active')`;
  await sql`INSERT INTO accounts (id, user_id, name, license_number) VALUES ('acc-1', 'owner-1', 'Demo Store', 'LIC-1')`;
  await sql`
    INSERT INTO event_types (id, owner_user_id, name, base_hours, base_price_credits, extra_hour_credits, active)
    VALUES ('et-1', 'owner-1', 'Demo Event', 4, 100, 20, 1)`;
  await sql`
    INSERT INTO portal_users (id, owner_user_id, name, email, role, status)
    VALUES ('amb-1', 'owner-1', 'Ambassador', 'amb@example.test', 'brand_ambassador', 'active')`;
}

async function addBalance(sql, amount, id = crypto.randomUUID()) {
  await sql`
    INSERT INTO credits (id, user_id, account_id, account_name, amount, amount_numeric, entry_type, note, date)
    VALUES (${id}, 'owner-1', 'acc-1', 'Demo Store', ${amount}, ${amount}, 'adjustment', 'test grant', '2026-01-01')`;
}

async function addBooking(sql, id, quotedCredits = '40.00', status = 'requested', overrides = {}) {
  const durationHours = overrides.durationHours == null ? 4 : overrides.durationHours;
  const quote = overrides.quote === false
    ? [null, null, null, null]
    : [quotedCredits, '4.00', quotedCredits, '0.00'];
  await sql`
    INSERT INTO bookings (
      id, owner_user_id, account_id, account_name, event_type_id, event_type_name,
      date, start_time, duration_hours, duration_hours_numeric, status,
      quoted_credits, quote_base_hours, quote_base_credits, quote_extra_hour_credits,
      ambassador_user_id, approved_at, confirmed_at,
      version, notes_client
    ) VALUES (
      ${id}, 'owner-1', 'acc-1', 'Demo Store', 'et-1', 'Demo Event',
      ${overrides.date || '2026-12-01'}, ${overrides.startTime || '10:00'},
      ${durationHours}, ${String(durationHours)}, ${status},
      ${quote[0]}, ${quote[1]}, ${quote[2]}, ${quote[3]},
      ${overrides.ambassadorUserId || null},
      ${overrides.approvedAt || null}, ${overrides.confirmedAt || null},
      1, 'integration fixture'
    )`;
}

async function insertRefund(sql, options) {
  return sql`
    INSERT INTO credits (
      id, user_id, account_id, booking_id, amount, amount_numeric,
      entry_type, reverses_credit_id
    ) VALUES (
      ${options.id || crypto.randomUUID()},
      ${options.ownerUserId || 'owner-1'},
      ${options.accountId || 'acc-1'},
      ${options.bookingId},
      ${options.amount},
      ${options.amount},
      'booking_refund',
      ${options.reversesCreditId}
    ) RETURNING id`;
}

function command(name, bookingId, overrides = {}) {
  return {
    ownerUserId: 'owner-1',
    bookingId,
    actor: { type: 'hq_user', id: 'owner-1' },
    key: `${name}-${bookingId}`,
    requestHash: `${name}-hash-${bookingId}`,
    ...overrides,
  };
}

async function assertRejectsCode(sqlPromise, code, label = 'statement') {
  await assert.rejects(sqlPromise, (error) => error.code === code, `${label} must fail with ${code}`);
}

dbTest('real Postgres constraints protect the ledger, quote and state machine', async (t) => {
  const { sql } = await setupDatabase(t);
  await addBalance(sql, '100.00');
  await addBooking(sql, 'bk-constraints');

  const [entry] = await sql`
    INSERT INTO credits (id, user_id, account_id, amount, amount_numeric, entry_type, note)
    VALUES (${crypto.randomUUID()}, 'owner-1', 'acc-1', 1, 1, 'adjustment', 'immutability probe')
    RETURNING id`;

  await assertRejectsCode(sql`UPDATE credits SET note = 'changed' WHERE id = ${entry.id}`, '23514');
  await assertRejectsCode(sql`DELETE FROM credits WHERE id = ${entry.id}`, '23514');
  await assertRejectsCode(
    sql`UPDATE bookings SET quoted_credits = '99.00' WHERE id = 'bk-constraints'`,
    '23514'
  );
  await assertRejectsCode(
    sql`UPDATE bookings SET status = 'completed' WHERE id = 'bk-constraints'`,
    '23514'
  );
  await assertRejectsCode(
    sql`UPDATE bookings SET status = 'bogus' WHERE id = 'bk-constraints'`,
    '23514'
  );

  const [charge] = await sql`
    INSERT INTO credits (id, user_id, account_id, booking_id, amount, amount_numeric, entry_type)
    VALUES (${crypto.randomUUID()}, 'owner-1', 'acc-1', 'bk-constraints', -10, -10, 'booking_charge')
    RETURNING id`;
  await assertRejectsCode(sql`
    INSERT INTO credits (id, user_id, account_id, booking_id, amount, amount_numeric, entry_type)
    VALUES (${crypto.randomUUID()}, 'owner-1', 'acc-1', 'bk-constraints', -10, -10, 'booking_charge')`, '23505');

  await sql`
    INSERT INTO credits (id, user_id, account_id, booking_id, amount, amount_numeric, entry_type, reverses_credit_id)
    VALUES (${crypto.randomUUID()}, 'owner-1', 'acc-1', 'bk-constraints', 10, 10, 'booking_refund', ${charge.id})`;
  await assertRejectsCode(sql`
    INSERT INTO credits (id, user_id, account_id, booking_id, amount, amount_numeric, entry_type, reverses_credit_id)
    VALUES (${crypto.randomUUID()}, 'owner-1', 'acc-1', 'bk-constraints', 10, 10, 'booking_refund', ${charge.id})`, '23505');
});

dbTest('real Postgres approval persists one charge, audit row and replay', async (t) => {
  const { sql } = await setupDatabase(t);
  await addBalance(sql, '100.00');
  await addBooking(sql, 'bk-approve');

  const first = await approveBooking(sql, command('approve', 'bk-approve'));
  assert.equal(first.status, 200);
  assert.equal(first.body.booking.status, 'approved');
  assert.equal(first.body.balance, 60);

  const replay = await approveBooking(sql, command('approve', 'bk-approve'));
  assert.equal(replay.status, 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.ledgerEntryId, first.body.ledgerEntryId);

  const otherKey = await approveBooking(sql, command('approve-other', 'bk-approve'));
  assert.equal(otherKey.status, 409);
  assert.equal(otherKey.body.code, 'INVALID_TRANSITION');

  const charges = await sql`
    SELECT id FROM credits WHERE booking_id = 'bk-approve' AND entry_type = 'booking_charge'`;
  const events = await sql`
    SELECT id FROM booking_events WHERE booking_id = 'bk-approve'`;
  assert.equal(charges.length, 1);
  assert.equal(events.length, 1);
});

dbTest('real Postgres cancellation refunds exactly once', async (t) => {
  const { sql } = await setupDatabase(t);
  await addBalance(sql, '100.00');
  await addBooking(sql, 'bk-cancel');
  await approveBooking(sql, command('approve', 'bk-cancel'));

  const cancelled = await cancelBooking(sql, command('cancel', 'bk-cancel'));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.refundedCredits, 40);
  assert.equal(cancelled.body.balance, 100);

  const replay = await cancelBooking(sql, command('cancel', 'bk-cancel'));
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.ledgerEntryId, cancelled.body.ledgerEntryId);

  const anotherKey = await cancelBooking(sql, command('cancel-other', 'bk-cancel'));
  assert.equal(anotherKey.status, 409);

  const refunds = await sql`
    SELECT id, amount_numeric FROM credits
     WHERE booking_id = 'bk-cancel' AND entry_type = 'booking_refund'`;
  assert.equal(refunds.length, 1);
  assert.equal(Number(refunds[0].amount_numeric), 40);
});

dbTest('real Postgres concurrent approvals cannot overspend one account', async (t) => {
  const { clients } = await setupDatabase(t, { connections: 2 });
  await addBalance(clients[0], '50.00');
  await addBooking(clients[0], 'bk-race-1', '40.00', 'requested', { startTime: '10:00' });
  await addBooking(clients[0], 'bk-race-2', '40.00', 'requested', { startTime: '14:00' });

  const results = await Promise.all([
    approveBooking(clients[0], command('approve', 'bk-race-1')),
    approveBooking(clients[1], command('approve', 'bk-race-2')),
  ]);

  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.ok(results.some((result) => result.body.code === 'INSUFFICIENT_CREDITS'));
  const balance = await clients[0]`
    SELECT COALESCE(SUM(amount_numeric), 0)::text AS balance
      FROM credits WHERE user_id = 'owner-1' AND account_id = 'acc-1'`;
  assert.ok(Number(balance[0].balance) >= 0);
});

dbTest('real Postgres concurrent overlapping requests yield one overlap error', async (t) => {
  const { clients } = await setupDatabase(t, { connections: 2 });
  await addBalance(clients[0], '500.00');
  const input = {
    eventTypeId: 'et-1',
    date: '2026-12-01',
    startTime: '10:00',
    durationHours: 4,
  };
  const results = await Promise.all([
    createBooking(clients[0], command('create', 'bk-race-a', {
      accountId: 'acc-1',
      input,
    })),
    createBooking(clients[1], command('create', 'bk-race-b', {
      accountId: 'acc-1',
      input,
    })),
  ]);

  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.ok(results.some((result) => result.body.code === 'BOOKING_OVERLAP'));
});

dbTest('real Postgres overlap checks reject equal and contained bookings and allow adjacent bookings', async (t) => {
  const { sql } = await setupDatabase(t);
  await addBalance(sql, '500.00');
  await addBooking(sql, 'bk-base', '120.00', 'requested', { startTime: '10:00', durationHours: 4 });

  const attempts = [
    { id: 'bk-equal', startTime: '10:00', durationHours: 4, overlap: true, label: 'equal interval' },
    { id: 'bk-contained', startTime: '11:00', durationHours: 2, overlap: true, label: 'contained interval' },
    { id: 'bk-containing', startTime: '09:00', durationHours: 6, overlap: true, label: 'containing interval' },
    { id: 'bk-before', startTime: '06:00', durationHours: 4, overlap: false, label: 'adjacent before' },
    { id: 'bk-after', startTime: '14:00', durationHours: 3, overlap: false, label: 'adjacent after' },
  ];

  for (const attempt of attempts) {
    const result = await createBooking(sql, command('create', attempt.id, {
      accountId: 'acc-1',
      input: {
        eventTypeId: 'et-1',
        date: '2026-12-01',
        startTime: attempt.startTime,
        durationHours: attempt.durationHours,
      },
    }));
    if (attempt.overlap) {
      assert.equal(result.status, 409, `${attempt.label} must conflict`);
      assert.equal(result.body.code, 'BOOKING_OVERLAP', attempt.label);
    } else {
      assert.equal(result.status, 201, `${attempt.label} must be allowed`);
    }
  }
});

dbTest('real Postgres schema boot can be rerun with triggers already installed', async (t) => {
  const { sql, schema } = await setupDatabase(t);
  const postgres = require('postgres');
  const decoyAdmin = postgres(databaseUrl, { max: 1 });
  const decoySchema = `ledger_decoy_${crypto.randomBytes(6).toString('hex')}`;
  await decoyAdmin.unsafe(`CREATE SCHEMA "${decoySchema}"`);
  await decoyAdmin.unsafe(`CREATE TABLE "${decoySchema}".bookings (id TEXT PRIMARY KEY)`);
  t.after(async () => {
    await decoyAdmin.unsafe(`DROP SCHEMA "${decoySchema}" CASCADE`);
    await decoyAdmin.end({ timeout: 2 });
  });
  await makeEnsureSchema(sql, { schema })();

  const [bookings] = await sql`
    SELECT count(*)::int AS count
      FROM pg_trigger
     WHERE tgrelid = 'bookings'::regclass
       AND NOT tgisinternal
       AND tgname IN ('immutable_booking_quote', 'enforce_booking_transition')`;
  const [credits] = await sql`
    SELECT count(*)::int AS count
      FROM pg_trigger
     WHERE tgrelid = 'credits'::regclass
       AND NOT tgisinternal
       AND tgname IN ('immutable_credits', 'enforce_booking_refund')`;
  assert.equal(bookings.count, 2);
  assert.equal(credits.count, 2);

  const [selected] = await sql`
    SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relname = 'bookings'`;
  assert.equal(selected.relrowsecurity, true);
  assert.equal(selected.relforcerowsecurity, true);
  const [decoy] = await sql`
    SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${decoySchema} AND c.relname = 'bookings'`;
  assert.equal(decoy.relrowsecurity, false, 'an unrelated schema must not inherit protection');
  assert.equal(decoy.relforcerowsecurity, false);

  const functions = await sql`
    SELECT p.proname, p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ${schema}
       AND p.proname IN (
         'immutable_credits_guard', 'enforce_booking_refund_guard',
         'immutable_booking_quote_guard', 'fill_legacy_booking_total',
         'fill_legacy_booking_quote', 'enforce_booking_transition_guard'
       )`;
  assert.equal(functions.length, 6);
  for (const fn of functions) {
    assert.ok(
      (fn.proconfig || []).some((setting) => setting === `search_path=${schema}, pg_temp`),
      `${fn.proname} must use the selected schema as its fixed search_path`
    );
  }
});

dbTest('real Postgres legacy quote backfill runs once and then becomes immutable', async (t) => {
  const { sql } = await setupDatabase(t);
  await addBooking(sql, 'bk-legacy', '40.00', 'requested', { quote: false });
  await addBooking(sql, 'bk-charged-legacy', '40.00', 'requested', { quote: false });
  await addBooking(sql, 'bk-uncharged-legacy', '40.00', 'requested', {
    quote: false,
    durationHours: 6,
  });
  await sql`
    UPDATE bookings
       SET credits_charged = '40.00', credits_charged_numeric = '40.00'
     WHERE id = 'bk-charged-legacy'`;

  const [charged] = await sql`
    SELECT fill_legacy_booking_total('bk-charged-legacy', '40.00') AS filled`;
  assert.equal(charged.filled, true);
  const [chargedRow] = await sql`
    SELECT quoted_credits, quote_base_hours, quote_base_credits, quote_extra_hour_credits
      FROM bookings WHERE id = 'bk-charged-legacy'`;
  assert.equal(Number(chargedRow.quoted_credits), 40);
  assert.equal(chargedRow.quote_base_hours, null, 'charged components must not be fabricated');
  assert.equal(chargedRow.quote_base_credits, null);
  assert.equal(chargedRow.quote_extra_hour_credits, null);
  await assertRejectsCode(
    sql`UPDATE bookings SET quoted_credits = '41.00' WHERE id = 'bk-charged-legacy'`,
    '23514',
    'a different charged total'
  );
  await assertRejectsCode(sql`
    UPDATE bookings
       SET quote_base_hours = '4.00', quote_base_credits = '40.00', quote_extra_hour_credits = '0.00'
     WHERE id = 'bk-charged-legacy'`,
  '23514',
  'fabricated components on a charged booking'
  );

  await assertRejectsCode(sql`
    UPDATE bookings
       SET quoted_credits = '40.00', quote_base_hours = '4.00',
           quote_base_credits = '40.00', quote_extra_hour_credits = '10.00'
     WHERE id = 'bk-uncharged-legacy'`,
  '23514',
  'an uncharged mapping that ignores two extra hours'
  );

  const [filled] = await sql`
    SELECT fill_legacy_booking_quote('bk-legacy', '40.00', '4.00', '40.00', '0.00') AS filled`;
  assert.equal(filled.filled, true);

  const [row] = await sql`
    SELECT quoted_credits, quote_base_hours, quote_base_credits, quote_extra_hour_credits
      FROM bookings WHERE id = 'bk-legacy'`;
  assert.equal(Number(row.quoted_credits), 40);
  assert.equal(Number(row.quote_base_hours), 4);
  assert.equal(Number(row.quote_base_credits), 40);
  assert.equal(Number(row.quote_extra_hour_credits), 0);

  await assertRejectsCode(
    sql`UPDATE bookings SET quoted_credits = '41.00' WHERE id = 'bk-legacy'`,
    '23514',
    'quote mutation after backfill'
  );
  const [again] = await sql`
    SELECT fill_legacy_booking_quote('bk-legacy', '42.00', '4.00', '42.00', '0.00') AS filled`;
  assert.equal(again.filled, false);
});

dbTest('real Postgres refund trigger enforces the original charge owner, account, booking and amount', async (t) => {
  const { sql } = await setupDatabase(t);
  await addBooking(sql, 'bk-refund');
  const [charge] = await sql`
    INSERT INTO credits (id, user_id, account_id, booking_id, amount, amount_numeric, entry_type, source_id)
    VALUES (${crypto.randomUUID()}, 'owner-1', 'acc-1', 'bk-refund', '-40.00', '-40.00', 'booking_charge', 'integration-test')
    RETURNING id`;

  const invalidRefunds = [
    { label: 'wrong owner', ownerUserId: 'owner-2' },
    { label: 'wrong account', accountId: 'acc-foreign' },
    { label: 'wrong booking', bookingId: 'bk-other' },
    { label: 'wrong amount', amount: '39.00' },
  ];
  for (const invalid of invalidRefunds) {
    await assertRejectsCode(insertRefund(sql, {
      id: crypto.randomUUID(),
      reversesCreditId: charge.id,
      bookingId: 'bk-refund',
      amount: '40.00',
      ...invalid,
    }), '23514', invalid.label);
  }

  const [beforeValid] = await sql`
    SELECT count(*)::int AS count FROM credits
     WHERE booking_id = 'bk-refund' AND entry_type = 'booking_refund'`;
  assert.equal(beforeValid.count, 0);

  const [refund] = await insertRefund(sql, {
    reversesCreditId: charge.id,
    bookingId: 'bk-refund',
    amount: '40.00',
  });
  assert.ok(refund.id);
});

dbTest('real Postgres a rolled-back command can retry with the same key', async (t) => {
  const { sql } = await setupDatabase(t);
  await addBalance(sql, '100.00');
  await addBooking(sql, 'bk-retry');
  await sql.unsafe(`
    CREATE FUNCTION fail_retry_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.request_id = 'retry-fail-key' THEN
        RAISE EXCEPTION 'injected audit failure' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
    $fn$`);
  await sql.unsafe(`
    CREATE TRIGGER fail_retry_audit
      BEFORE INSERT ON booking_events
      FOR EACH ROW EXECUTE FUNCTION fail_retry_audit()`);

  const retryArgs = command('approve', 'bk-retry', {
    key: 'retry-fail-key',
    requestHash: 'retry-hash',
  });
  const failed = await approveBooking(sql, retryArgs);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, 'INTERNAL_ERROR');

  const [afterFailure] = await sql`
    SELECT status FROM bookings WHERE id = 'bk-retry'`;
  assert.equal(afterFailure.status, 'requested');
  const [chargesAfterFailure] = await sql`
    SELECT count(*)::int AS count FROM credits
     WHERE booking_id = 'bk-retry' AND entry_type = 'booking_charge'`;
  const [eventsAfterFailure] = await sql`
    SELECT count(*)::int AS count FROM booking_events WHERE booking_id = 'bk-retry'`;
  const [idemAfterFailure] = await sql`
    SELECT count(*)::int AS count FROM api_idempotency WHERE idempotency_key = 'retry-fail-key'`;
  assert.equal(chargesAfterFailure.count, 0);
  assert.equal(eventsAfterFailure.count, 0);
  assert.equal(idemAfterFailure.count, 0);

  await sql.unsafe('DROP TRIGGER fail_retry_audit ON booking_events');
  await sql.unsafe('DROP FUNCTION fail_retry_audit()');

  const retried = await approveBooking(sql, retryArgs);
  assert.equal(retried.status, 200);
  assert.notEqual(retried.replayed, true);
  assert.equal(retried.body.booking.status, 'approved');

  const [chargesAfterRetry] = await sql`
    SELECT count(*)::int AS count FROM credits
     WHERE booking_id = 'bk-retry' AND entry_type = 'booking_charge'`;
  const [eventsAfterRetry] = await sql`
    SELECT count(*)::int AS count FROM booking_events WHERE booking_id = 'bk-retry'`;
  const [idemAfterRetry] = await sql`
    SELECT response_status FROM api_idempotency WHERE idempotency_key = 'retry-fail-key'`;
  assert.equal(chargesAfterRetry.count, 1);
  assert.equal(eventsAfterRetry.count, 1);
  assert.equal(idemAfterRetry.response_status, 200);
});

dbTest('real Postgres invite activation isolates owners and accounts', async (t) => {
  const { sql } = await setupDatabase(t);
  await sql`
    INSERT INTO users (id, name, email, status)
    VALUES ('owner-2', 'Other Owner', 'owner2@example.test', 'active')`;
  await sql`
    INSERT INTO accounts (id, user_id, name, license_number)
    VALUES ('acc-other', 'owner-2', 'Other Store', 'LIC-2')`;
  await sql`
    INSERT INTO portal_invites (id, email, role, account_id, owner_user_id, token, expires, used_at)
    VALUES
      ('inv-bound', 'bound@example.test', 'store_manager', 'acc-1', 'owner-1', 'invite-bound', '2099-01-01T00:00:00.000Z', NULL),
      ('inv-wide', 'wide@example.test', 'store_manager', NULL, 'owner-1', 'invite-wide', '2099-01-01T00:00:00.000Z', NULL)`;

  let tokenCounter = 0;
  const deps = {
    now: () => new Date('2026-11-21T00:00:00.000Z'),
    hashPassword: () => 'test:hash',
    randomToken: () => `generated-${++tokenCounter}`,
    sessionDays: 30,
  };

  const bound = await activatePortalInvite(sql, {
    token: 'invite-bound',
    name: 'Manager',
    password: 'secret123',
    accountId: 'acc-other',
  }, deps);
  assert.equal(bound.status, 400);
  assert.equal(bound.body.code, 'ACCOUNT_MISMATCH');

  const wideForeign = await activatePortalInvite(sql, {
    token: 'invite-wide',
    name: 'Manager',
    password: 'secret123',
    accountId: 'acc-other',
  }, deps);
  assert.equal(wideForeign.status, 400);
  assert.equal(wideForeign.body.code, 'ACCOUNT_NOT_AVAILABLE');

  const [usersBefore] = await sql`
    SELECT count(*)::int AS count FROM portal_users
     WHERE email IN ('bound@example.test', 'wide@example.test')`;
  assert.equal(usersBefore.count, 0);
  const [boundInvite] = await sql`SELECT used_at FROM portal_invites WHERE id = 'inv-bound'`;
  assert.equal(boundInvite.used_at, null);

  const wideOwned = await activatePortalInvite(sql, {
    token: 'invite-wide',
    name: 'Manager',
    password: 'secret123',
    accountId: 'acc-1',
  }, deps);
  assert.equal(wideOwned.status, 200);
  const [created] = await sql`
    SELECT account_id, owner_user_id FROM portal_users WHERE email = 'wide@example.test'`;
  assert.equal(created.account_id, 'acc-1');
  assert.equal(created.owner_user_id, 'owner-1');
});

dbTest('real Postgres ambassador removal downgrades and audits a confirmed booking', async (t) => {
  const { sql } = await setupDatabase(t);
  await addBooking(sql, 'bk-removal', '40.00', 'confirmed', {
    ambassadorUserId: 'amb-1',
    approvedAt: '2026-11-20T10:00:00.000Z',
    confirmedAt: '2026-11-20T12:00:00.000Z',
  });

  const args = {
    ownerUserId: 'owner-1',
    portalUserIds: ['amb-1'],
    actor: { type: 'hq_user', id: 'owner-1' },
    key: 'remove-amb-1',
    requestHash: 'remove-amb-hash',
  };
  const result = await removePortalUsersBookings(sql, args);
  assert.equal(result.status, 200);

  const [booking] = await sql`
    SELECT status, confirmed_at, ambassador_user_id, approved_at
      FROM bookings WHERE id = 'bk-removal'`;
  assert.equal(booking.status, 'approved');
  assert.equal(booking.confirmed_at, null);
  assert.equal(booking.ambassador_user_id, null);
  assert.ok(booking.approved_at);

  const [audits] = await sql`
    SELECT count(*)::int AS count FROM booking_events
     WHERE booking_id = 'bk-removal' AND action = 'ambassador_removed'`;
  assert.equal(audits.count, 1);
  const [user] = await sql`SELECT count(*)::int AS count FROM portal_users WHERE id = 'amb-1'`;
  assert.equal(user.count, 0);

  const replay = await removePortalUsersBookings(sql, args);
  assert.equal(replay.status, 200);
  const [auditsAfterReplay] = await sql`
    SELECT count(*)::int AS count FROM booking_events
     WHERE booking_id = 'bk-removal' AND action = 'ambassador_removed'`;
  assert.equal(auditsAfterReplay.count, 1);
});

dbTest('real Postgres blast replay reuses batch and recipient idempotency without duplicate SMS', async (t) => {
  const { sql } = await setupDatabase(t);
  await sql`UPDATE accounts SET phone = '+15551234567' WHERE id = 'acc-1'`;

  let sends = 0;
  const service = createBlastService({
    sql,
    smsConfigured: () => true,
    sendSmsTwilio: async () => { sends += 1; return { sent: true, sid: `sm-${sends}` }; },
  });
  const args = {
    ownerUserId: 'owner-1',
    actor: { type: 'hq_user', id: 'owner-1' },
    key: 'blast-pg-key',
    accountIds: ['acc-1'],
    template: 'Hi {name}',
  };

  const first = await service.sendBlast(args);
  assert.equal(first.status, 200);
  assert.equal(first.body.sent, 1);
  assert.equal(sends, 1);

  const replay = await service.sendBlast(args);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.equal(sends, 1);

  // Simulate a batch response that was lost after a recipient reservation was
  // committed. Clearing the batch record leaves the recipient claim intact, so
  // the retry must rebuild the result from that persisted recipient.
  await sql`
    UPDATE api_idempotency
       SET completed_at = NULL, response_status = NULL, response_body = NULL
     WHERE operation = 'messages.blast' AND idempotency_key = 'blast-pg-key'`;
  const recipientHash = canonicalRequestHash({
    operation: 'messages.blast.recipient',
    resourceId: 'acc-1',
    actor: args.actor,
    body: { batchKey: args.key, accountId: 'acc-1', phone: '+15551234567', text: 'Hi Account One' },
  });
  await sql`
    UPDATE api_idempotency
       SET response_body = ${JSON.stringify({
         accountId: 'acc-1', ok: true, sent: true, status: 'sent', reason: 'sent', messageId: first.body.results[0].messageId,
       })}::jsonb
     WHERE operation = 'messages.blast.recipient' AND request_hash = ${recipientHash}`;
  const retry = await service.sendBlast(args);
  assert.equal(retry.replayed, false);
  assert.equal(retry.body.sent, 1);
  assert.equal(sends, 1, 'a lost batch response must never cause a second Twilio send');

  const [messageCount] = await sql`
    SELECT count(*)::int AS count FROM messages
     WHERE user_id = 'owner-1' AND blast_id = ${first.body.blastId}`;
  assert.equal(messageCount.count, 1);
  const [batchRows] = await sql`
    SELECT count(*)::int AS count FROM api_idempotency
     WHERE operation = 'messages.blast' AND idempotency_key = 'blast-pg-key'`;
  assert.equal(batchRows.count, 1);
  const [recipientRows] = await sql`
    SELECT count(*)::int AS count FROM api_idempotency
     WHERE operation = 'messages.blast.recipient'`;
  assert.equal(recipientRows.count, 1);
});
