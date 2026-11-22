'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBooking } = require('../src/booking-service');
const { createBookingDb } = require('./helpers/fake-booking-db');
const { queryTexts } = require('./helpers/fake-sql');

const baseArgs = {
  ownerUserId: 'owner-1',
  accountId: 'acc-1',
  actor: { type: 'portal_user', id: 'mgr-1', role: 'store_manager' },
  key: 'create-key-1',
  requestHash: 'create-hash-1',
  input: {
    eventTypeId: 'et-1',
    date: '2026-12-01',
    startTime: '10:00',
    durationHours: 6,
    notes: 'setup',
  },
};

test('request creation has no zero-price fallback when the event type is missing or inactive', async () => {
  for (const eventType of [null, { active: 0 }]) {
    const { sql, state, calls } = createBookingDb({ eventType });
    const result = await createBooking(sql, { ...baseArgs, key: `create-key-${eventType ? 'inactive' : 'missing'}` });

    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'EVENT_TYPE_NOT_FOUND');
    assert.equal(state.bookingsInserted.length, 0);
    assert.equal(state.ledger.length, 0);
    assert.ok(!queryTexts(calls).some((text) => /INSERT INTO bookings/.test(text)));
  }
});

test('request creation stores a positive immutable quote computed from the locked event type', async () => {
  const { sql, state, calls } = createBookingDb({ balance: '200.00' });
  const result = await createBooking(sql, baseArgs);

  assert.equal(result.status, 201);
  assert.equal(result.body.booking.status, 'requested');
  assert.equal(result.body.quotedCredits, '140.00');
  assert.equal(result.body.estimatedCost, '140.00');
  assert.equal(state.bookingsInserted.length, 1);
  const inserted = state.bookingsInserted[0];
  assert.equal(inserted[12], '140.00');
  assert.equal(inserted[13], '4.00');
  assert.equal(inserted[14], '100.00');
  assert.equal(inserted[15], '20.00');
  assert.equal(state.events.length, 1);

  const texts = queryTexts(calls);
  const accountLock = texts.findIndex((text) => /FROM accounts[\s\S]*FOR UPDATE/.test(text));
  const eventLock = texts.findIndex((text) => /FROM event_types[\s\S]*FOR UPDATE/.test(text));
  assert.ok(accountLock >= 0 && accountLock < eventLock, 'account must be locked before reading pricing');
});

test('request creation rejects zero and malformed quotes without inserting a booking', async () => {
  const zero = createBookingDb({ eventType: { base_price_credits: 0, extra_hour_credits: 0 } });
  const zeroResult = await createBooking(zero.sql, { ...baseArgs, key: 'create-key-zero' });
  assert.equal(zeroResult.status, 400);
  assert.equal(zeroResult.body.code, 'VALIDATION_ERROR');
  assert.equal(zero.state.bookingsInserted.length, 0);

  const malformed = createBookingDb();
  const malformedResult = await createBooking(malformed.sql, {
    ...baseArgs,
    key: 'create-key-malformed',
    input: { ...baseArgs.input, date: '12/01/2026' },
  });
  assert.equal(malformedResult.status, 400);
  assert.equal(malformedResult.body.code, 'VALIDATION_ERROR');
  assert.equal(malformed.state.bookingsInserted.length, 0);
});

test('request creation may reject insufficient current balance without reserving credits', async () => {
  const { sql, state } = createBookingDb({ balance: '50.00' });
  const result = await createBooking(sql, { ...baseArgs, key: 'create-key-poor' });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'INSUFFICIENT_CREDITS');
  assert.equal(state.bookingsInserted.length, 0);
  assert.equal(state.ledger.length, 0);
});
