'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  approveBooking,
  cancelBooking,
  createBooking,
} = require('../src/booking-service');
const { createBookingDb } = require('./helpers/fake-booking-db');

const hqActor = { type: 'hq_user', id: 'owner-1' };
const baseArgs = {
  ownerUserId: 'owner-1',
  bookingId: 'bk-1',
  actor: hqActor,
  key: 'rollback-key',
  requestHash: 'rollback-hash',
};

test('createBooking returns a stable validation result when the key is missing', async () => {
  const { sql, state } = createBookingDb();
  const result = await createBooking(sql, {
    ...baseArgs,
    key: '',
    ownerUserId: 'owner-1',
    accountId: 'acc-1',
    input: {
      eventTypeId: 'et-1',
      date: '2026-12-01',
      startTime: '10:00',
      durationHours: 4,
    },
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(state.bookingsInserted.length, 0);
});

test('an unexpected approval failure rolls back the charge and does not persist a 500 replay', async () => {
  const { sql, state, calls } = createBookingDb({
    balance: '200.00',
    throwOn: 'UPDATE bookings',
  });
  const result = await approveBooking(sql, baseArgs);

  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'INTERNAL_ERROR');
  assert.equal(state.booking.status, 'requested');
  assert.equal(state.events.length, 0);
  assert.ok(calls.some((call) => call.kind === 'rollback'));
  assert.ok(!calls.some((call) => call.text && /UPDATE api_idempotency/.test(call.text)));
  assert.equal(state.idem.get('rollback-key').response_status, null);
});

test('an unexpected refund failure rolls back with no persisted replay response', async () => {
  const { sql, state, calls } = createBookingDb({
    booking: { status: 'approved', credits_charged: '100.00', credits_charged_numeric: '100.00' },
    balance: '100.00',
    charge: { id: 'charge-1', amount: '-100.00', amount_numeric: '-100.00' },
    throwOn: 'UPDATE bookings',
  });
  const result = await cancelBooking(sql, baseArgs);

  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'INTERNAL_ERROR');
  assert.equal(state.booking.status, 'approved');
  assert.equal(state.events.length, 0);
  assert.ok(calls.some((call) => call.kind === 'rollback'));
  assert.ok(!calls.some((call) => call.text && /UPDATE api_idempotency/.test(call.text)));
  assert.equal(state.idem.get('rollback-key').response_status, null);
});
