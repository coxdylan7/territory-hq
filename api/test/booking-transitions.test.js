'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  declineBooking,
  assignBooking,
  acceptBooking,
  declineAssignmentBooking,
  completeBooking,
} = require('../src/booking-service');
const { createBookingDb } = require('./helpers/fake-booking-db');
const { queryTexts } = require('./helpers/fake-sql');

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
    key: `${command}-key-1`,
    requestHash: `${command}-hash-1`,
    ...overrides,
  };
}

test('HQ decline moves requested to declined with reason, audit and no ledger entry', async () => {
  const { sql, state } = createBookingDb();
  const result = await declineBooking(sql, args('decline', { notes: 'Not available' }));

  assert.equal(result.status, 200);
  assert.equal(result.body.booking.status, 'declined');
  assert.equal(result.body.booking.notesAdmin, 'Not available');
  assert.equal(state.booking.status, 'declined');
  assert.equal(state.booking.notes_admin, 'Not available');
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0][5], 'declined');
  assert.equal(state.ledger.length, 0);
});

test('HQ assignment validates an active owner-scoped ambassador and audits assignment', async () => {
  const { sql, state, calls } = createBookingDb({ booking: { status: 'approved', ambassador_user_id: null } });
  const result = await assignBooking(sql, args('assign', { ambassadorUserId: 'amb-1' }));

  assert.equal(result.status, 200);
  assert.equal(result.body.booking.status, 'approved');
  assert.equal(result.body.booking.ambassadorUserId, 'amb-1');
  assert.equal(state.booking.ambassador_user_id, 'amb-1');
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0][5], 'assigned');
  assert.match(queryTexts(calls).find((text) => /FROM portal_users/.test(text)), /owner_user_id/);
  assert.equal(state.ledger.length, 0);
});

test('confirmed reassignment clears confirmation and records reassigned audit metadata', async () => {
  const { sql, state } = createBookingDb({
    booking: { status: 'confirmed', confirmed_at: '2026-01-01T00:00:00Z' },
    ambassador: { id: 'amb-2' },
  });
  const result = await assignBooking(sql, args('assign', {
    ambassadorUserId: 'amb-2',
    actor: { ...hqActor, id: 'owner-1' },
  }));

  assert.equal(result.status, 200);
  assert.equal(state.booking.status, 'approved');
  assert.equal(state.booking.confirmed_at, null);
  assert.equal(state.booking.ambassador_user_id, 'amb-2');
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0][5], 'reassigned');
});

test('assignment rejects an inactive or foreign ambassador without changing the booking', async () => {
  for (const ambassador of [null, { id: 'amb-2', owner_user_id: 'owner-2' }, { status: 'inactive' }]) {
    const { sql, state } = createBookingDb({ booking: { status: 'approved' }, ambassador });
    const result = await assignBooking(sql, args('assign', { ambassadorUserId: 'amb-1' }));
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'AMBASSADOR_NOT_FOUND');
    assert.equal(state.booking.ambassador_user_id, 'amb-1');
    assert.equal(state.events.length, 0);
  }
});

test('only the assigned active ambassador can accept an approved booking', async () => {
  const allowed = createBookingDb({ booking: { status: 'approved' } });
  const accepted = await acceptBooking(allowed.sql, args('accept', { actor: ambassadorActor }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.booking.status, 'confirmed');
  assert.equal(allowed.state.booking.status, 'confirmed');
  assert.equal(allowed.state.events[0][5], 'confirmed');

  for (const actor of [
    hqActor,
    { ...ambassadorActor, id: 'amb-2' },
    { ...ambassadorActor, role: 'store_manager' },
    { ...ambassadorActor, ownerUserId: 'owner-2' },
  ]) {
    const denied = createBookingDb({ booking: { status: 'approved' } });
    const result = await acceptBooking(denied.sql, args('accept', { actor }));
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'FORBIDDEN_ACTOR');
    assert.equal(denied.state.booking.status, 'approved');
    assert.equal(denied.state.events.length, 0);
  }
});

test('assigned ambassador can clear its assignment without changing status or credits', async () => {
  const { sql, state } = createBookingDb({ booking: { status: 'approved' } });
  const result = await declineAssignmentBooking(sql, args('decline-assignment', { actor: ambassadorActor }));

  assert.equal(result.status, 200);
  assert.equal(result.body.booking.status, 'approved');
  assert.equal(result.body.booking.ambassadorUserId, null);
  assert.equal(state.booking.ambassador_user_id, null);
  assert.equal(state.events[0][5], 'assignment_declined');
  assert.equal(state.ledger.length, 0);
});

test('only a confirmed assigned ambassador can complete a booking', async () => {
  const allowed = createBookingDb({ booking: { status: 'confirmed' } });
  const result = await completeBooking(allowed.sql, args('complete', { actor: ambassadorActor }));
  assert.equal(result.status, 200);
  assert.equal(result.body.booking.status, 'completed');
  assert.equal(allowed.state.booking.status, 'completed');
  assert.equal(allowed.state.events[0][5], 'completed');

  const approved = createBookingDb({ booking: { status: 'approved' } });
  const tooEarly = await completeBooking(approved.sql, args('complete', { actor: ambassadorActor }));
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.code, 'INVALID_TRANSITION');
  assert.equal(approved.state.booking.status, 'approved');
  assert.equal(approved.state.ledger.length, 0);
});

test('terminal statuses and representative forbidden transitions are rejected', async () => {
  const cases = [
    [declineBooking, { status: 'declined' }, 'decline', hqActor, {}],
    [assignBooking, { status: 'cancelled' }, 'assign', hqActor, { ambassadorUserId: 'amb-1' }],
    [acceptBooking, { status: 'completed' }, 'accept', ambassadorActor, {}],
    [completeBooking, { status: 'declined' }, 'complete', ambassadorActor, {}],
  ];
  for (const [command, booking, name, actor, extra] of cases) {
    const { sql, state } = createBookingDb({ booking });
    const result = await command(sql, args(name, { actor, ...extra }));
    assert.equal(result.status, 409, `${name} should reject ${booking.status}`);
    assert.equal(result.body.code, 'INVALID_TRANSITION');
    assert.equal(state.events.length, 0);
  }
});

test('state commands reject out-of-owner bookings before taking locks', async () => {
  const { sql, state, calls } = createBookingDb({ booking: { owner_user_id: 'owner-2' } });
  const result = await declineBooking(sql, args('decline'));

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'BOOKING_NOT_FOUND');
  assert.equal(state.booking.status, 'requested');
  assert.ok(!queryTexts(calls).some((text) => /FOR UPDATE/.test(text)));
});
