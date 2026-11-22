'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  updateBooking,
  approveBooking,
  cancelBooking,
  declineBooking,
  assignBooking,
  acceptBooking,
  declineAssignmentBooking,
  completeBooking,
} = require('../src/booking-service');
const { createFakeSql } = require('./helpers/fake-sql');
const { createBookingDb } = require('./helpers/fake-booking-db');

const hqActor = { type: 'hq_user', id: 'owner-1' };
const ambassadorActor = {
  type: 'portal_user',
  id: 'amb-1',
  role: 'brand_ambassador',
  ownerUserId: 'owner-1',
};

function args(command, overrides = {}) {
  return {
    ownerUserId: 'owner-1',
    bookingId: 'bk-1',
    actor: hqActor,
    key: `${command}-preserve-1`,
    requestHash: `${command}-preserve-hash-1`,
    ...overrides,
  };
}

function historicalBooking(overrides = {}) {
  return {
    status: 'confirmed',
    version: 3,
    approved_at: '2026-01-01T10:00:00.000Z',
    confirmed_at: '2026-01-02T10:00:00.000Z',
    declined_at: '2025-12-01T10:00:00.000Z',
    cancelled_at: '2025-12-02T10:00:00.000Z',
    completed_at: '2025-12-03T10:00:00.000Z',
    credits_charged: 100,
    credits_charged_numeric: '100.00',
    ambassador_user_id: 'amb-1',
    notes_client: 'client note',
    notes_admin: 'admin note',
    quoted_credits: '100.00',
    quote_base_hours: '4.00',
    quote_base_credits: '100.00',
    quote_extra_hour_credits: '20.00',
    requested_by_portal_user_id: 'pu-1',
    created_by_actor_type: 'portal_user',
    created_by_actor_id: 'pu-1',
    created_at: '2025-12-01T09:00:00.000Z',
    status_changed_at: '2026-01-02T10:00:00.000Z',
    ...overrides,
  };
}

function updateOnlyDb(initial) {
  const row = { id: 'bk-1', owner_user_id: 'owner-1', ...initial };
  const updates = [];
  const handler = (text, values) => {
    if (!/UPDATE bookings/.test(text)) return [];
    updates.push({ text, values });
    const setClause = text.match(/SET ([\s\S]*?) WHERE/)[1];
    const columns = [...setClause.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/g)]
      .map((m) => ({ column: m[1], index: Number(m[2]) - 1 }));
    columns.forEach(({ column, index }) => { row[column] = values[index]; });
    row.version = initial.version + 1;
    return [{ ...row }];
  };
  return { ...createFakeSql(handler), row, updates };
}

test('updateBooking writes only explicitly supplied columns', async () => {
  const initial = historicalBooking({ status: 'confirmed' });
  const { sql, row, updates } = updateOnlyDb(initial);

  const updated = await updateBooking(sql, {
    bookingId: 'bk-1',
    ownerUserId: 'owner-1',
    version: 3,
    fromStatus: 'confirmed',
    status: 'cancelled',
    cancelledAt: '2026-02-01T10:00:00.000Z',
  });

  assert.equal(updated.status, 'cancelled');
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancelled_at, '2026-02-01T10:00:00.000Z');
  for (const field of [
    'approved_at', 'confirmed_at', 'declined_at', 'completed_at',
    'credits_charged', 'credits_charged_numeric', 'ambassador_user_id',
    'notes_client', 'notes_admin', 'quoted_credits', 'quote_base_hours',
    'quote_base_credits', 'quote_extra_hour_credits', 'created_at',
  ]) {
    assert.equal(row[field], initial[field], `${field} must be preserved`);
  }
  assert.doesNotMatch(updates[0].text, /notes_admin\s*=/);
  assert.doesNotMatch(updates[0].text, /credits_charged\s*=/);
  assert.doesNotMatch(updates[0].text, /quoted_credits\s*=/);
});

test('cancellation preserves all historical timestamps, credits, ambassador, notes and quote', async () => {
  const initial = historicalBooking({ status: 'confirmed' });
  const { sql, state } = createBookingDb({
    booking: initial,
    charge: { id: 'cr-1', amount: -100, amount_numeric: '-100.00' },
  });
  const result = await cancelBooking(sql, args('cancel'));

  assert.equal(result.status, 200);
  for (const field of [
    'approved_at', 'confirmed_at', 'declined_at', 'completed_at',
    'credits_charged', 'credits_charged_numeric', 'ambassador_user_id',
    'notes_client', 'notes_admin', 'quoted_credits', 'quote_base_hours',
    'quote_base_credits', 'quote_extra_hour_credits', 'created_at',
  ]) {
    assert.equal(state.booking[field], initial[field], `${field} must survive cancellation`);
  }
});

test('assignment preserves historical fields except the deliberately changed ambassador/confirmation', async () => {
  const initial = historicalBooking({ status: 'confirmed' });
  const { sql, state } = createBookingDb({
    booking: initial,
    ambassador: { id: 'amb-2', owner_user_id: 'owner-1', role: 'brand_ambassador', status: 'active' },
  });
  const result = await assignBooking(sql, args('assign', { ambassadorUserId: 'amb-2' }));

  assert.equal(result.status, 200);
  assert.equal(state.booking.ambassador_user_id, 'amb-2');
  assert.equal(state.booking.confirmed_at, null);
  for (const field of [
    'approved_at', 'declined_at', 'cancelled_at', 'completed_at',
    'credits_charged', 'credits_charged_numeric', 'notes_client', 'notes_admin',
    'quoted_credits', 'quote_base_hours', 'quote_base_credits',
    'quote_extra_hour_credits', 'created_at',
  ]) {
    assert.equal(state.booking[field], initial[field], `${field} must survive assignment`);
  }
});

test('acceptance preserves historical fields and only sets confirmation', async () => {
  const initial = historicalBooking({
    status: 'approved',
    confirmed_at: null,
    declined_at: null,
    cancelled_at: null,
    completed_at: null,
  });
  const { sql, state } = createBookingDb({ booking: initial });
  const result = await acceptBooking(sql, args('accept', { actor: ambassadorActor }));

  assert.equal(result.status, 200);
  assert.notEqual(state.booking.confirmed_at, null);
  for (const field of [
    'approved_at', 'declined_at', 'cancelled_at', 'completed_at',
    'credits_charged', 'credits_charged_numeric', 'ambassador_user_id',
    'notes_client', 'notes_admin', 'quoted_credits', 'quote_base_hours',
    'quote_base_credits', 'quote_extra_hour_credits', 'created_at',
  ]) {
    assert.equal(state.booking[field], initial[field], `${field} must survive acceptance`);
  }
});

test('declining an assignment preserves history and only clears the ambassador', async () => {
  const initial = historicalBooking({
    status: 'approved',
    confirmed_at: null,
    declined_at: null,
    cancelled_at: null,
    completed_at: null,
  });
  const { sql, state } = createBookingDb({ booking: initial });
  const result = await declineAssignmentBooking(sql, args('decline-assignment', { actor: ambassadorActor }));

  assert.equal(result.status, 200);
  assert.equal(state.booking.ambassador_user_id, null);
  for (const field of [
    'approved_at', 'confirmed_at', 'declined_at', 'cancelled_at', 'completed_at',
    'credits_charged', 'credits_charged_numeric', 'notes_client', 'notes_admin',
    'quoted_credits', 'quote_base_hours', 'quote_base_credits',
    'quote_extra_hour_credits', 'created_at',
  ]) {
    assert.equal(state.booking[field], initial[field], `${field} must survive assignment decline`);
  }
});

test('completion preserves history and only sets completed_at', async () => {
  const initial = historicalBooking({
    status: 'confirmed',
    declined_at: null,
    cancelled_at: null,
    completed_at: null,
  });
  const { sql, state } = createBookingDb({ booking: initial });
  const result = await completeBooking(sql, args('complete', { actor: ambassadorActor }));

  assert.equal(result.status, 200);
  assert.notEqual(state.booking.completed_at, null);
  for (const field of [
    'approved_at', 'confirmed_at', 'declined_at', 'cancelled_at',
    'credits_charged', 'credits_charged_numeric', 'ambassador_user_id',
    'notes_client', 'notes_admin', 'quoted_credits', 'quote_base_hours',
    'quote_base_credits', 'quote_extra_hour_credits', 'created_at',
  ]) {
    assert.equal(state.booking[field], initial[field], `${field} must survive completion`);
  }
});

test('approval preserves quote, notes, historical timestamps and only sets approval/charge fields', async () => {
  const initial = historicalBooking({
    status: 'requested',
    approved_at: null,
    confirmed_at: null,
    declined_at: null,
    cancelled_at: null,
    completed_at: null,
    credits_charged: null,
    credits_charged_numeric: null,
  });
  const { sql, state } = createBookingDb({ booking: initial, balance: '500.00' });
  const result = await approveBooking(sql, args('approve'));

  assert.equal(result.status, 200);
  assert.notEqual(state.booking.approved_at, null);
  assert.equal(state.booking.credits_charged_numeric, initial.quoted_credits);
  for (const field of [
    'declined_at', 'cancelled_at', 'completed_at', 'ambassador_user_id',
    'notes_client', 'notes_admin', 'quoted_credits', 'quote_base_hours',
    'quote_base_credits', 'quote_extra_hour_credits', 'created_at',
  ]) {
    assert.equal(state.booking[field], initial[field], `${field} must survive approval`);
  }
});
