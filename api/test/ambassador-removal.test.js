'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { removePortalUsersBookings } = require('../src/booking-service');
const { createFakeSql } = require('./helpers/fake-sql');

function removalDb(options = {}) {
  const state = {
    account: { id: 'acc-1', user_id: 'owner-1' },
    booking: {
      id: 'bk-1', owner_user_id: 'owner-1', account_id: 'acc-1',
      status: options.status || 'confirmed',
      version: 2,
      ambassador_user_id: 'amb-1',
      confirmed_at: '2026-01-02T10:00:00.000Z',
      approved_at: '2026-01-01T10:00:00.000Z',
    },
    portalUser: { id: 'amb-1', owner_user_id: 'owner-1' },
    locks: [],
    audits: [],
    updates: [],
    deletes: [],
  };

  const handler = (text, values) => {
    if (/FROM accounts[\s\S]*FOR UPDATE/.test(text)) {
      state.locks.push('account');
      return [state.account];
    }
    if (/SELECT DISTINCT account_id FROM bookings/.test(text)) {
      return [{ account_id: 'acc-1' }];
    }
    if (/SELECT \* FROM bookings[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/.test(text)) {
      state.locks.push('booking');
      return state.booking.ambassador_user_id ? [state.booking] : [];
    }
    if (/FROM portal_users[\s\S]*FOR UPDATE/.test(text)) {
      state.locks.push('portal_user');
      return [state.portalUser];
    }
    if (/UPDATE bookings/.test(text)) {
      const setClause = text.match(/SET ([\s\S]*?) WHERE/)[1];
      const assignments = [...setClause.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/g)];
      const changes = {};
      assignments.forEach((match) => { changes[match[1]] = values[Number(match[2]) - 1]; });
      state.updates.push(changes);
      Object.assign(state.booking, changes);
      return [{ ...state.booking }];
    }
    if (/INSERT INTO booking_events/.test(text)) {
      state.audits.push(values);
      return [{}];
    }
    if (/DELETE FROM/.test(text)) {
      state.deletes.push(text);
      return [];
    }
    if (/SELECT id FROM portal_users/.test(text)) return [state.portalUser];
    return [];
  };

  return { ...createFakeSql(handler), state };
}

function removalArgs(overrides = {}) {
  return {
    ownerUserId: 'owner-1',
    portalUserIds: ['amb-1'],
    actor: { type: 'hq_user', id: 'owner-1' },
    key: 'portal-user-delete:owner-1:amb-1',
    requestHash: 'hash-1',
    ...overrides,
  };
}

test('ambassador removal locks account, then booking, then portal user', async () => {
  const { sql, state } = removalDb();
  const result = await removePortalUsersBookings(sql, removalArgs());

  assert.equal(result.status, 200);
  assert.deepEqual(state.locks, ['account', 'booking', 'portal_user']);
});

test('removing an ambassador from a confirmed booking downgrades and audits it', async () => {
  const { sql, state } = removalDb();
  const result = await removePortalUsersBookings(sql, removalArgs());

  assert.equal(result.status, 200);
  assert.equal(state.booking.status, 'approved');
  assert.equal(state.booking.confirmed_at, null);
  assert.equal(state.booking.ambassador_user_id, null);
  assert.equal(state.booking.approved_at, '2026-01-01T10:00:00.000Z');
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0][5], 'ambassador_removed');
  assert.equal(JSON.parse(state.audits[0][9]).revokedConfirmation, true);
});

test('repeated ambassador removal with the same key is a no-op', async () => {
  const { sql, state } = removalDb();
  const first = await removePortalUsersBookings(sql, removalArgs());
  const second = await removePortalUsersBookings(sql, removalArgs());

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(state.audits.length, 1);
  assert.equal(state.updates.length, 1);
});

test('HQ portal-user and admin deletion routes use the shared audited command', () => {
  const hq = readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const uses = hq.match(/removePortalUsersBookings\(/g) || [];
  assert.ok(uses.length >= 2, 'both deletion routes must call the shared helper');
  assert.doesNotMatch(
    hq,
    /UPDATE bookings SET ambassador_user_id = NULL/,
    'HQ must not clear ambassadors with a bare update'
  );
  const portal = readFileSync(path.join(__dirname, '../../portal/api/src/server.js'), 'utf8');
  assert.doesNotMatch(
    portal,
    /UPDATE bookings SET ambassador_user_id = NULL/,
    'portal API must not clear ambassadors with a bare update'
  );
});
