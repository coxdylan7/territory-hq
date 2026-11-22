'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { approveBooking } = require('../src/booking-service');
const { createBookingDb } = require('./helpers/fake-booking-db');
const { queryTexts } = require('./helpers/fake-sql');

const baseArgs = {
  ownerUserId: 'owner-1',
  bookingId: 'bk-1',
  actor: { type: 'hq_user', id: 'owner-1' },
  key: 'approve-key-1',
  requestHash: 'approve-hash-1',
};

test('approval commits one exact charge, one transition and one audit row in lock order', async () => {
  const { sql, state, calls } = createBookingDb({ balance: '100.00' });
  const result = await approveBooking(sql, baseArgs);

  assert.equal(result.status, 200);
  assert.equal(result.body.booking.status, 'approved');
  assert.equal(result.body.booking.creditsCharged, '100.00');
  assert.equal(result.body.balance, 0);
  assert.equal(result.body.ledgerEntryId, 'credit-1');

  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0].entry_type, 'booking_charge');
  assert.equal(state.ledger[0].amount_numeric, '-100.00');
  assert.equal(state.ledger[0].booking_id, 'bk-1');
  assert.equal(state.booking.status, 'approved');
  assert.equal(state.booking.credits_charged_numeric, '100.00');
  assert.equal(state.events.length, 1);

  const texts = queryTexts(calls);
  const accountLock = texts.findIndex((text) => /FROM accounts[\s\S]*FOR UPDATE/.test(text));
  const bookingLock = texts.findIndex((text) => /FROM bookings[\s\S]*FOR UPDATE/.test(text));
  const balance = texts.findIndex((text) => /COALESCE\(SUM/.test(text));
  const charge = texts.findIndex((text) => /INSERT INTO credits/.test(text));
  assert.ok(accountLock >= 0 && accountLock < bookingLock, 'account must be locked before booking');
  assert.ok(bookingLock < balance, 'balance must be read after both locks');
  assert.ok(balance < charge, 'balance must be authoritative before charging');
  assert.ok(!texts.some((text) => /FROM event_types/.test(text)), 'approval must not recompute pricing');
});

test('insufficient funds is an idempotent business failure with no state change', async () => {
  const { sql, state } = createBookingDb({ balance: '50.00' });
  const first = await approveBooking(sql, baseArgs);

  assert.equal(first.status, 409);
  assert.equal(first.body.code, 'INSUFFICIENT_CREDITS');
  assert.equal(first.replayed, false);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.events.length, 0);
  assert.equal(state.booking.status, 'requested');

  state.balance = '500.00';
  const replay = await approveBooking(sql, baseArgs);
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, 'INSUFFICIENT_CREDITS');
  assert.equal(state.ledger.length, 0);
  assert.equal(state.booking.status, 'requested');
});

test('approval uses the stored quote after the event type is edited or deactivated', async () => {
  const { sql, state, calls } = createBookingDb({
    balance: '100.00',
    eventType: { base_price_credits: 999, extra_hour_credits: 999, active: 0 },
  });
  const result = await approveBooking(sql, baseArgs);

  assert.equal(result.status, 200);
  assert.equal(state.ledger[0].amount_numeric, '-100.00');
  assert.ok(!queryTexts(calls).some((text) => /FROM event_types/.test(text)));
});

test('a different key cannot approve a booking that is already approved', async () => {
  const { sql, state } = createBookingDb({ balance: '100.00' });
  const first = await approveBooking(sql, baseArgs);
  const second = await approveBooking(sql, {
    ...baseArgs,
    key: 'approve-key-2',
    requestHash: 'approve-hash-2',
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'INVALID_TRANSITION');
  assert.equal(state.ledger.length, 1);
  assert.equal(state.events.length, 1);
});

test('approval can assign an active owner ambassador in the same transaction', async () => {
  const { sql, state } = createBookingDb({
    balance: '100.00',
    booking: { ambassador_user_id: null },
  });
  const result = await approveBooking(sql, {
    ...baseArgs,
    key: 'approve-assign-key',
    requestHash: 'approve-assign-hash',
    ambassadorUserId: 'amb-1',
    notes: 'Bring sampler kit',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.booking.ambassadorUserId, 'amb-1');
  assert.equal(result.body.booking.notesAdmin, 'Bring sampler kit');
  assert.equal(state.booking.ambassador_user_id, 'amb-1');
  assert.equal(state.ledger.length, 1);
  assert.equal(state.events.length, 1);
});

test('approval rejects an out-of-scope booking before locking or charging', async () => {
  const { sql, state, calls } = createBookingDb({
    balance: '100.00',
    booking: { owner_user_id: 'owner-2' },
  });
  const result = await approveBooking(sql, baseArgs);

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'BOOKING_NOT_FOUND');
  assert.equal(state.ledger.length, 0);
  assert.ok(!queryTexts(calls).some((text) => /FOR UPDATE/.test(text)));
});
