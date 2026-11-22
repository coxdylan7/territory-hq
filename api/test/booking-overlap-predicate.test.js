'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBooking,
  approveBooking,
  assignBooking,
} = require('../src/booking-service');
const { createBookingDb } = require('./helpers/fake-booking-db');
const { queryTexts } = require('./helpers/fake-sql');

const hqActor = { type: 'hq_user', id: 'owner-1' };

function command(name, overrides = {}) {
  return {
    ownerUserId: 'owner-1',
    bookingId: 'bk-1',
    actor: hqActor,
    key: `${name}-overlap-1`,
    requestHash: `${name}-overlap-hash-1`,
    ...overrides,
  };
}

function overlapQuery(calls) {
  return queryTexts(calls).find((text) => /SELECT id FROM bookings/.test(text) && /status IN/.test(text));
}

function assertCompleteIntervalPredicate(text, label) {
  assert.ok(text, `${label}: overlap query must exist`);
  assert.match(
    text,
    /AND start_time < \(\?::time \+ \? \* interval '1 hour'\) AND \?::time < \(start_time::time \+ COALESCE\(duration_hours_numeric, duration_hours::numeric\) \* interval '1 hour'\)/,
    `${label}: must use existing_start < candidate_end AND candidate_start < existing_end`
  );
  assert.doesNotMatch(
    text,
    /\(start_time::time \+ COALESCE\(duration_hours_numeric, duration_hours::numeric\) \* interval '1 hour'\) >/,
    `${label}: the reversed legacy comparison must be removed`
  );
}

test('booking creation uses the complete half-open interval predicate', async () => {
  const { sql, calls } = createBookingDb({ balance: '500.00' });
  const result = await createBooking(sql, command('create', {
    accountId: 'acc-1',
    input: { eventTypeId: 'et-1', date: '2026-12-01', startTime: '10:00', durationHours: 4 },
  }));
  assert.equal(result.status, 201);
  assertCompleteIntervalPredicate(overlapQuery(calls), 'create');
});

test('booking approval uses the complete half-open interval predicate', async () => {
  const { sql, calls } = createBookingDb({ balance: '500.00' });
  const result = await approveBooking(sql, command('approve'));
  assert.equal(result.status, 200);
  assertCompleteIntervalPredicate(overlapQuery(calls), 'approve');
});

test('ambassador assignment uses the complete half-open interval predicate', async () => {
  const { sql, calls } = createBookingDb({
    booking: { status: 'approved' },
    ambassador: { id: 'amb-1', owner_user_id: 'owner-1', role: 'brand_ambassador', status: 'active' },
  });
  const result = await assignBooking(sql, command('assign', { ambassadorUserId: 'amb-1' }));
  assert.equal(result.status, 200);
  assertCompleteIntervalPredicate(overlapQuery(calls), 'assign');
});
