'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cancelBooking } = require('../src/booking-service');
const { createBookingDb } = require('./helpers/fake-booking-db');
const { queryTexts } = require('./helpers/fake-sql');

const hqActor = { type: 'hq_user', id: 'owner-1' };
const managerActor = {
  type: 'portal_user',
  id: 'mgr-1',
  role: 'store_manager',
  accountId: 'acc-1',
};

function args(overrides = {}) {
  return {
    ownerUserId: 'owner-1',
    bookingId: 'bk-1',
    actor: hqActor,
    key: 'cancel-key-1',
    requestHash: 'cancel-hash-1',
    ...overrides,
  };
}

test('requested cancellation changes status, writes an audit row and creates no ledger entry', async () => {
  const { sql, state, calls } = createBookingDb({ balance: '100.00' });
  const result = await cancelBooking(sql, args());

  assert.equal(result.status, 200);
  assert.equal(result.body.booking.status, 'cancelled');
  assert.equal(result.body.refundedCredits, 0);
  assert.equal(result.body.ledgerEntryId, null);
  assert.equal(state.booking.status, 'cancelled');
  assert.equal(state.ledger.length, 0);
  assert.equal(state.events.length, 1);
  assert.ok(!queryTexts(calls).some((text) => /INSERT INTO credits/.test(text)));
});

test('charged cancellation appends one refund equal to the original charge and atomically cancels', async () => {
  const { sql, state, calls } = createBookingDb({
    booking: { status: 'confirmed' },
    balance: '0.00',
    charge: { id: 'credit-charge-1', amount_numeric: '-100.00' },
  });
  const result = await cancelBooking(sql, args());

  assert.equal(result.status, 200);
  assert.equal(result.body.booking.status, 'cancelled');
  assert.equal(result.body.balance, 100);
  assert.equal(result.body.refundedCredits, 100);
  assert.equal(result.body.ledgerEntryId, 'credit-1');

  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0].entry_type, 'booking_refund');
  assert.equal(state.ledger[0].amount_numeric, '100.00');
  assert.equal(state.ledger[0].reverses_credit_id, 'credit-charge-1');
  assert.equal(state.booking.status, 'cancelled');
  assert.equal(state.events.length, 1);

  const texts = queryTexts(calls);
  const accountLock = texts.findIndex((text) => /FROM accounts[\s\S]*FOR UPDATE/.test(text));
  const bookingLock = texts.findIndex((text) => /FROM bookings[\s\S]*FOR UPDATE/.test(text));
  const chargeLookup = texts.findIndex((text) => /FROM credits[\s\S]*booking_charge/.test(text));
  const refund = texts.findIndex((text) => /INSERT INTO credits/.test(text));
  const update = texts.findIndex((text) => /UPDATE bookings/.test(text));
  assert.ok(accountLock < bookingLock);
  assert.ok(bookingLock < chargeLookup);
  assert.ok(chargeLookup < refund);
  assert.ok(refund < update);
  assert.match(texts[refund], /ON CONFLICT/i);
});

test('cancellation replay returns the original response; a new key cannot refund twice', async () => {
  const { sql, state } = createBookingDb({
    booking: { status: 'approved' },
    balance: '0.00',
    charge: { id: 'credit-charge-1', amount_numeric: '-100.00' },
  });
  const first = await cancelBooking(sql, args());
  const replay = await cancelBooking(sql, args());
  const second = await cancelBooking(sql, args({
    key: 'cancel-key-2',
    requestHash: 'cancel-hash-2',
  }));

  assert.equal(first.status, 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'INVALID_TRANSITION');
  assert.equal(state.ledger.length, 1);
  assert.equal(state.events.length, 1);
  assert.equal(state.booking.status, 'cancelled');
});

test('Portal store manager may cancel only a linked account booking', async () => {
  const allowed = createBookingDb();
  const allowedResult = await cancelBooking(allowed.sql, args({ actor: managerActor }));
  assert.equal(allowedResult.status, 200);
  assert.equal(allowed.state.booking.status, 'cancelled');

  const foreign = createBookingDb();
  const foreignResult = await cancelBooking(foreign.sql, args({
    actor: { ...managerActor, accountId: 'acc-2' },
  }));
  assert.equal(foreignResult.status, 403);
  assert.equal(foreignResult.body.code, 'FORBIDDEN_ACTOR');
  assert.equal(foreign.state.booking.status, 'requested');
  assert.equal(foreign.state.ledger.length, 0);
});

test('store staff and ambassadors cannot cancel bookings', async () => {
  for (const actor of [
    { type: 'portal_user', id: 'staff-1', role: 'store_staff', accountId: 'acc-1' },
    { type: 'portal_user', id: 'amb-1', role: 'brand_ambassador', accountId: 'acc-1' },
  ]) {
    const { sql, state } = createBookingDb();
    const result = await cancelBooking(sql, args({ actor }));
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'FORBIDDEN_ACTOR');
    assert.equal(state.booking.status, 'requested');
    assert.equal(state.ledger.length, 0);
  }
});

test('cancellation rejects an out-of-scope booking before taking locks', async () => {
  const { sql, state, calls } = createBookingDb({ booking: { owner_user_id: 'owner-2' } });
  const result = await cancelBooking(sql, args());

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'BOOKING_NOT_FOUND');
  assert.equal(state.booking.status, 'requested');
  assert.ok(!queryTexts(calls).some((text) => /FOR UPDATE/.test(text)));
});
