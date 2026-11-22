'use strict';

const { createFakeSql } = require('./fake-sql');

function defaultBooking(overrides = {}) {
  return {
    id: 'bk-1',
    owner_user_id: 'owner-1',
    account_id: 'acc-1',
    account_name: 'Demo Store',
    license_number: 'LIC-1',
    event_type_id: 'et-1',
    event_type_name: 'Demo Event',
    date: '2026-12-01',
    start_time: '10:00',
    duration_hours: 4,
    duration_hours_numeric: '4.00',
    credits_charged: null,
    credits_charged_numeric: null,
    quoted_credits: '100.00',
    quote_base_hours: '4.00',
    quote_base_credits: '100.00',
    quote_extra_hour_credits: '20.00',
    status: 'requested',
    ambassador_user_id: 'amb-1',
    notes_client: 'please',
    notes_admin: null,
    version: 1,
    ...overrides,
  };
}

function defaultEventType(overrides = {}) {
  return {
    id: 'et-1',
    owner_user_id: 'owner-1',
    name: 'Demo Event',
    base_hours: 4,
    base_price_credits: 100,
    extra_hour_credits: 20,
    active: 1,
    ...overrides,
  };
}

function createBookingDb(options = {}) {
  const state = {
    booking: defaultBooking(options.booking),
    account: options.account === null ? null : { id: 'acc-1', user_id: 'owner-1', name: 'Demo Store', license_number: 'LIC-1', ...options.account },
    eventType: options.eventType === null ? null : defaultEventType(options.eventType),
    ambassador: options.ambassador === null ? null : { id: 'amb-1', owner_user_id: 'owner-1', role: 'brand_ambassador', status: 'active', name: 'Amb', ...options.ambassador },
    balance: options.balance == null ? '100.00' : String(options.balance),
    charge: options.charge || null,
    overlaps: options.overlaps || [],
    idem: new Map(),
    ledger: [],
    events: [],
    bookingUpdates: [],
    bookingsInserted: [],
    throwOn: options.throwOn || null,
  };

  const handler = (text, values) => {
    if (state.throwOn && text.includes(state.throwOn)) {
      throw new Error('injected database failure');
    }

    if (/INSERT INTO api_idempotency/.test(text)) {
      const key = values[5];
      if (state.idem.has(key)) return [];
      state.idem.set(key, {
        id: `idem-${state.idem.size + 1}`,
        request_hash: values[6],
        response_status: null,
        response_body: null,
        completed_at: null,
      });
      return [{ id: `idem-${state.idem.size}` }];
    }
    if (/SELECT[\s\S]*FROM api_idempotency/.test(text)) {
      const key = values[4];
      const row = state.idem.get(key);
      return row ? [row] : [];
    }
    if (/UPDATE api_idempotency/.test(text)) {
      const key = values[2];
      const row = state.idem.get(key);
      if (row) {
        row.response_status = values[0];
        row.response_body = typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1];
        row.completed_at = 'now';
      }
      return [{}];
    }
    if (/FROM accounts[\s\S]*FOR UPDATE/.test(text)) {
      return state.account ? [state.account] : [];
    }
    if (/SELECT name, license_number[\s\S]*FROM accounts/.test(text)) {
      return state.account ? [{ name: state.account.name, license_number: state.account.license_number }] : [];
    }
    if (/FROM event_types[\s\S]*FOR UPDATE/.test(text)) {
      return state.eventType && Number(state.eventType.active) === 1 ? [state.eventType] : [];
    }
    if (/FROM portal_users[\s\S]*FOR UPDATE/.test(text)) {
      const ambassador = state.ambassador;
      if (!ambassador
          || String(values[0]) !== String(ambassador.id)
          || String(values[1]) !== String(ambassador.owner_user_id)
          || String(ambassador.status) !== 'active') {
        return [];
      }
      return [ambassador];
    }
    if (/SELECT id FROM bookings[\s\S]*status IN/.test(text)) {
      return state.overlaps;
    }
    if (/FROM bookings[\s\S]*LIMIT 1/.test(text)) {
      if (String(values[1]) !== String(state.booking.owner_user_id)) return [];
      return [{
        id: state.booking.id,
        account_id: state.booking.account_id,
        owner_user_id: state.booking.owner_user_id,
        status: state.booking.status,
        version: state.booking.version,
        ambassador_user_id: state.booking.ambassador_user_id,
      }];
    }
    if (/FROM bookings[\s\S]*FOR UPDATE/.test(text)) {
      return [state.booking];
    }
    if (/COALESCE\(SUM/.test(text)) {
      return [{ balance: state.balance }];
    }
    if (/pg_advisory_xact_lock/.test(text)) {
      return [];
    }
    if (/FROM credits[\s\S]*booking_charge/.test(text)) {
      return state.charge ? [state.charge] : [];
    }
    if (/INSERT INTO credits/.test(text)) {
      const entry = {
        id: `credit-${state.ledger.length + 1}`,
        user_id: values[1],
        account_id: values[2],
        amount: values[6],
        amount_numeric: values[7],
        entry_type: values[10],
        booking_id: values[11],
        reverses_credit_id: values[14],
        actor_type: values[15],
        actor_id: values[16],
      };
      state.ledger.push(entry);
      if (entry.entry_type === 'booking_charge') state.charge = { id: entry.id, amount_numeric: entry.amount_numeric };
      return [entry];
    }
    if (/UPDATE bookings/.test(text)) {
      state.bookingUpdates.push([...values]);
      const setClause = text.match(/SET ([\s\S]*?) WHERE/)[1];
      const assignments = [...setClause.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/g)];
      assignments.forEach((match) => {
        const column = match[1];
        const index = Number(match[2]) - 1;
        if (column !== 'version') state.booking[column] = values[index] == null ? null : values[index];
      });
      state.booking.version += 1;
      return [state.booking];
    }
    if (/INSERT INTO bookings/.test(text)) {
      state.bookingsInserted.push([...values]);
      return [{
        ...defaultBooking(),
        id: values[0],
        date: values[7],
        start_time: values[8],
        status: values[20],
        quoted_credits: values[12],
        quote_base_hours: values[13],
        quote_base_credits: values[14],
        quote_extra_hour_credits: values[15],
      }];
    }
    if (/INSERT INTO booking_events/.test(text)) {
      state.events.push([...values]);
      return [{}];
    }
    return [];
  };

  return { ...createFakeSql(handler), state };
}

module.exports = { createBookingDb, defaultBooking, defaultEventType };
