'use strict';

const crypto = require('node:crypto');
const { ServiceError, errorBody, mapDatabaseError } = require('./service-errors');
const { withIdempotency } = require('./idempotency');
const {
  parseLedgerAmount,
  parseMoney,
  money,
  lockAccount,
  readBalance,
  insertBookingCharge,
  findBookingCharge,
  insertBookingRefund,
  ledgerView,
} = require('./credit-ledger');

const LIVE_STATUSES = ['requested', 'approved', 'confirmed'];
const TERMINAL_STATUSES = ['declined', 'cancelled', 'completed'];

function failResult(error) {
  return { status: error.status || 500, body: errorBody(error) };
}

function knownDatabaseError(error) {
  return Boolean(error && ['23P01', '23505', '23514'].includes(error.code));
}

async function scopedBookingLookup(sql, bookingId, ownerUserId) {
  const rows = await sql`
    SELECT id, account_id, owner_user_id, status, version, ambassador_user_id
      FROM bookings
     WHERE id = ${bookingId}
       AND owner_user_id = ${ownerUserId}
     LIMIT 1`;
  return rows[0] || null;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function advisoryKeys(...parts) {
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

function bookingDurationHours(booking) {
  const raw = booking.duration_hours_numeric == null ? booking.duration_hours : booking.duration_hours_numeric;
  const hours = Number(raw);
  return Number.isFinite(hours) ? hours : 0;
}

function computeQuote(eventType, durationHours) {
  const hours = parseLedgerAmount(durationHours);
  const baseHours = parseLedgerAmount(eventType.base_hours);
  if (hours <= 0 || hours > 2400 || baseHours <= 0 || baseHours > 2400) {
    throw new ServiceError(400, 'VALIDATION_ERROR', 'Duration and base hours must be between 0 and 24.');
  }
  const baseCredits = parseLedgerAmount(eventType.base_price_credits);
  const extraRate = parseLedgerAmount(eventType.extra_hour_credits);
  const extraUnits = Math.max(0, hours - baseHours);
  const extraCredits = Math.round((extraUnits * extraRate) / 100);
  const quote = baseCredits + extraCredits;
  if (quote <= 0) {
    throw new ServiceError(400, 'VALIDATION_ERROR', 'The event quote must be greater than zero.');
  }
  return {
    baseHours: money(baseHours),
    baseCredits: money(baseCredits),
    extraHourCredits: money(extraRate),
    quotedCredits: money(quote),
  };
}

function bookingView(row) {
  if (!row) return null;
  const view = {
    id: row.id,
    eventTypeId: row.event_type_id,
    eventTypeName: row.event_type_name,
    accountId: row.account_id,
    accountName: row.account_name,
    licenseNumber: row.license_number,
    date: row.date,
    startTime: row.start_time,
    durationHours: Number(row.duration_hours_numeric == null ? row.duration_hours : row.duration_hours_numeric),
    quotedCredits: row.quoted_credits,
    quoteBaseHours: row.quote_base_hours,
    quoteBaseCredits: row.quote_base_credits,
    quoteExtraHourCredits: row.quote_extra_hour_credits,
    creditsCharged: row.credits_charged_numeric == null ? row.credits_charged : row.credits_charged_numeric,
    status: row.status,
    ambassadorUserId: row.ambassador_user_id,
    notesClient: row.notes_client,
    notesAdmin: row.notes_admin,
    requestedByPortalUserId: row.requested_by_portal_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    approvedAt: row.approved_at,
    confirmedAt: row.confirmed_at,
    declinedAt: row.declined_at,
    cancelledAt: row.cancelled_at,
    completedAt: row.completed_at,
  };
  for (const key of Object.keys(view)) {
    if (view[key] === undefined) delete view[key];
  }
  return view;
}

async function insertAudit(sql, { ownerUserId, bookingId, fromStatus, toStatus, action, actor, requestId, metadata }) {
  await sql`
    INSERT INTO booking_events (
      id, owner_user_id, booking_id, from_status, to_status,
      action, actor_type, actor_id, request_id, metadata
    )
    VALUES (
      ${crypto.randomUUID()}, ${ownerUserId}, ${bookingId}, ${fromStatus || null}, ${toStatus},
      ${action}, ${actor.type}, ${actor.id}, ${requestId || null},
      ${JSON.stringify(metadata || {})}::jsonb
    )
    ON CONFLICT DO NOTHING`;
}

const UPDATE_BOOKING_COLUMNS = [
  ['status', 'status'],
  ['notesAdmin', 'notes_admin'],
  ['approvedAt', 'approved_at'],
  ['confirmedAt', 'confirmed_at'],
  ['declinedAt', 'declined_at'],
  ['cancelledAt', 'cancelled_at'],
  ['completedAt', 'completed_at'],
  ['creditsCharged', 'credits_charged'],
  ['creditsChargedNumeric', 'credits_charged_numeric'],
  ['ambassadorUserId', 'ambassador_user_id'],
];

async function updateBooking(sql, options) {
  const values = [];
  const assignments = [];
  const add = (column, value) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  for (const [optionName, column] of UPDATE_BOOKING_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(options, optionName)) add(column, options[optionName]);
  }
  add('status_changed_at', options.statusChangedAt || new Date().toISOString());
  add('updated_at', options.updatedAt || new Date().toISOString());
  assignments.push('version = version + 1');

  values.push(options.bookingId, options.ownerUserId, options.version, options.fromStatus);
  const whereOffset = values.length - 3;
  const statement = `
    UPDATE bookings
       SET ${assignments.join(', ')}
     WHERE id = $${whereOffset}
       AND owner_user_id = $${whereOffset + 1}
       AND version = $${whereOffset + 2}
       AND status = $${whereOffset + 3}
     RETURNING *`;

  const rows = await sql.unsafe(statement, values);
  if (!rows.length) {
    throw new ServiceError(409, 'INVALID_TRANSITION', 'The booking changed while the request was being processed.');
  }
  return rows[0];
}

async function createBooking(sql, options) {
  const input = options.input || {};
  if (!options.key) {
    return failResult(new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required.'));
  }
  if (!validDate(input.date) || !validTime(input.startTime)) {
    return failResult(new ServiceError(400, 'VALIDATION_ERROR', 'A strict YYYY-MM-DD date and HH:MM start time are required.'));
  }
  try {
    parseLedgerAmount(input.durationHours);
  } catch (error) {
    return failResult(error);
  }

  try {
    return await sql.begin(async (tx) => withIdempotency({
      sql: tx,
      ownerUserId: options.ownerUserId,
      actor: options.actor,
      operation: 'booking.create',
      resourceId: input.eventTypeId || null,
      key: options.key,
      requestHash: options.requestHash,
      handler: async (actionTx) => {
        try {
          await lockAccount(actionTx, options.ownerUserId, options.accountId);
          const [key1, key2] = advisoryKeys(options.ownerUserId, options.accountId, input.date);
          await actionTx`SELECT pg_advisory_xact_lock(${key1}, ${key2})`;

          const eventRows = await actionTx`
            SELECT id, name, base_hours, base_price_credits, extra_hour_credits, active
              FROM event_types
             WHERE id = ${input.eventTypeId}
               AND owner_user_id = ${options.ownerUserId}
               AND active = 1
             FOR UPDATE`;
          if (!eventRows.length) {
            return failResult(new ServiceError(404, 'EVENT_TYPE_NOT_FOUND', 'Event type not found.'));
          }

          let quote;
          try {
            quote = computeQuote(eventRows[0], input.durationHours);
          } catch (error) {
            return failResult(error);
          }

          const balance = await readBalance(actionTx, options.ownerUserId, options.accountId);
          if (parseMoney(balance, { allowZero: true }) < parseLedgerAmount(quote.quotedCredits)) {
            return failResult(new ServiceError(409, 'INSUFFICIENT_CREDITS', 'Insufficient credits.'));
          }

          const candidateStart = `${input.startTime}:00`;
          const candidateHours = parseLedgerAmount(input.durationHours) / 100;
          const overlap = await actionTx`
            SELECT id
              FROM bookings
             WHERE owner_user_id = ${options.ownerUserId}
               AND account_id = ${options.accountId}
               AND date = ${input.date}
               AND status IN ('requested', 'approved', 'confirmed')
               AND start_time < (${candidateStart}::time + ${candidateHours} * interval '1 hour')
               AND ${candidateStart}::time < (start_time::time + COALESCE(duration_hours_numeric, duration_hours::numeric) * interval '1 hour')
             LIMIT 1`;
          if (overlap.length) {
            return failResult(new ServiceError(409, 'BOOKING_OVERLAP', 'The event time overlaps an existing booking.'));
          }

          const accountRows = await actionTx`
            SELECT name, license_number
              FROM accounts
             WHERE id = ${options.accountId}
               AND user_id = ${options.ownerUserId}`;
          const account = accountRows[0] || {};
          const id = crypto.randomUUID();
          const createdRows = await actionTx`
            INSERT INTO bookings (
              id, owner_user_id, account_id, account_name, license_number,
              event_type_id, event_type_name, date, start_time,
              duration_hours, duration_hours_numeric, credits_charged,
              quoted_credits, quote_base_hours, quote_base_credits,
              quote_extra_hour_credits, requested_by_portal_user_id,
              created_by_actor_type, created_by_actor_id, notes_client,
              status, created_at, updated_at, version
            )
            VALUES (
              ${id}, ${options.ownerUserId}, ${options.accountId}, ${account.name || null},
              ${account.license_number || null}, ${eventRows[0].id}, ${eventRows[0].name},
              ${input.date}, ${input.startTime}, ${input.durationHours}, ${money(parseLedgerAmount(input.durationHours))},
              ${null}, ${quote.quotedCredits}, ${quote.baseHours}, ${quote.baseCredits},
              ${quote.extraHourCredits}, ${options.actor.id}, ${options.actor.type}, ${options.actor.id},
              ${input.notes || null}, ${'requested'}, now(), now(), ${1}
            )
            RETURNING *`;
          await insertAudit(actionTx, {
            ownerUserId: options.ownerUserId,
            bookingId: id,
            toStatus: 'requested',
            action: 'requested',
            actor: options.actor,
            requestId: options.key,
            metadata: { quotedCredits: quote.quotedCredits },
          });

          return {
            status: 201,
            body: {
              booking: bookingView(createdRows[0]),
              balance: Number(balance),
              quotedCredits: quote.quotedCredits,
              estimatedCost: quote.quotedCredits,
            },
          };
        } catch (error) {
          if (error instanceof ServiceError) return failResult(error);
          if (knownDatabaseError(error)) return failResult(mapDatabaseError(error));
          throw error;
        }
      },
    }));
  } catch (error) {
    if (error instanceof ServiceError) return failResult(error);
    return failResult(mapDatabaseError(error));
  }
}

function isHqOwner(actor, ownerUserId) {
  return Boolean(actor && actor.type === 'hq_user' && String(actor.id) === String(ownerUserId));
}

function isAssignedAmbassador(actor, ownerUserId, booking) {
  return Boolean(actor
    && actor.type === 'portal_user'
    && actor.role === 'brand_ambassador'
    && String(actor.id) === String(booking.ambassador_user_id)
    && String(actor.ownerUserId ?? ownerUserId) === String(ownerUserId));
}

async function lockActiveAmbassador(sql, ownerUserId, ambassadorUserId) {
  const rows = await sql`
    SELECT id
      FROM portal_users
     WHERE id = ${ambassadorUserId}
       AND owner_user_id = ${ownerUserId}
       AND role = 'brand_ambassador'
       AND status = 'active'
     LIMIT 1
     FOR UPDATE`;
  if (!rows.length) {
    throw new ServiceError(404, 'AMBASSADOR_NOT_FOUND', 'Assigned ambassador is not active.');
  }
  return rows[0];
}

async function ensureAmbassadorOverlap(sql, ownerUserId, booking, ambassadorUserId) {
  const candidateStart = `${booking.start_time}:00`;
  const candidateHours = bookingDurationHours(booking);
  const rows = await sql`
    SELECT id
      FROM bookings
     WHERE owner_user_id = ${ownerUserId}
       AND ambassador_user_id = ${ambassadorUserId}
       AND date = ${booking.date}
       AND id <> ${booking.id}
       AND status IN ('approved', 'confirmed')
       AND start_time < (${candidateStart}::time + ${candidateHours} * interval '1 hour')
       AND ${candidateStart}::time < (start_time::time + COALESCE(duration_hours_numeric, duration_hours::numeric) * interval '1 hour')
     LIMIT 1`;
  if (rows.length) {
    throw new ServiceError(409, 'BOOKING_OVERLAP', 'The ambassador is already booked at this time.');
  }
}

async function runBookingCommand(sql, options, config) {
  try {
    const scope = await scopedBookingLookup(sql, options.bookingId, options.ownerUserId);
    if (!scope) {
      return failResult(new ServiceError(404, 'BOOKING_NOT_FOUND', 'Booking not found.'));
    }
    if (config.authorize && !config.authorize(options.actor, options.ownerUserId, scope)) {
      return failResult(new ServiceError(403, 'FORBIDDEN_ACTOR', 'You cannot perform this action on the booking.'));
    }

    return await sql.begin(async (tx) => withIdempotency({
      sql: tx,
      ownerUserId: options.ownerUserId,
      actor: options.actor,
      operation: config.operation,
      resourceId: options.bookingId,
      key: options.key,
      requestHash: options.requestHash,
      handler: async (actionTx) => {
        try {
          await lockAccount(actionTx, options.ownerUserId, scope.account_id);
          const bookingRows = await actionTx`
            SELECT *
              FROM bookings
             WHERE id = ${options.bookingId}
               AND owner_user_id = ${options.ownerUserId}
               AND account_id = ${scope.account_id}
             FOR UPDATE`;
          const booking = bookingRows[0];
          if (!booking) {
            return failResult(new ServiceError(404, 'BOOKING_NOT_FOUND', 'Booking not found.'));
          }
          if (!config.statuses.includes(booking.status)) {
            return failResult(new ServiceError(409, 'INVALID_TRANSITION', 'The booking is not in a valid state for this action.'));
          }
          if (config.authorize && !config.authorize(options.actor, options.ownerUserId, booking)) {
            return failResult(new ServiceError(403, 'FORBIDDEN_ACTOR', 'You cannot perform this action on the booking.'));
          }

          const change = await config.apply(actionTx, booking, scope);
          const updated = await updateBooking(actionTx, {
            bookingId: options.bookingId,
            ownerUserId: options.ownerUserId,
            version: booking.version,
            fromStatus: booking.status,
            ...change.update,
          });
          await insertAudit(actionTx, {
            ownerUserId: options.ownerUserId,
            bookingId: options.bookingId,
            fromStatus: booking.status,
            toStatus: change.update.status,
            action: change.action,
            actor: options.actor,
            requestId: options.key,
            metadata: change.metadata || {},
          });
          return {
            status: 200,
            body: { booking: bookingView(updated), ...(change.extra || {}) },
          };
        } catch (error) {
          if (error instanceof ServiceError) return failResult(error);
          if (knownDatabaseError(error)) return failResult(mapDatabaseError(error));
          throw error;
        }
      },
    }));
  } catch (error) {
    if (error instanceof ServiceError) return failResult(error);
    return failResult(mapDatabaseError(error));
  }
}

function authorizeCancellation(actor, ownerUserId, accountId) {
  if (!actor) return false;
  if (actor.type === 'hq_user') {
    return String(actor.id) === String(ownerUserId);
  }
  if (actor.type === 'portal_user' && actor.role === 'store_manager') {
    return String(actor.accountId) === String(accountId);
  }
  return false;
}

async function approveBooking(sql, options) {
  try {
    const scope = await scopedBookingLookup(sql, options.bookingId, options.ownerUserId);
    if (!scope) {
      return failResult(new ServiceError(404, 'BOOKING_NOT_FOUND', 'Booking not found.'));
    }

    return await sql.begin(async (tx) => withIdempotency({
      sql: tx,
      ownerUserId: options.ownerUserId,
      actor: options.actor,
      operation: 'booking.approve',
      resourceId: options.bookingId,
      key: options.key,
      requestHash: options.requestHash,
      handler: async (actionTx) => {
        try {
          await lockAccount(actionTx, options.ownerUserId, scope.account_id);

          const bookingRows = await actionTx`
            SELECT *
              FROM bookings
             WHERE id = ${options.bookingId}
               AND owner_user_id = ${options.ownerUserId}
               AND account_id = ${scope.account_id}
             FOR UPDATE`;
          const booking = bookingRows[0];
          if (!booking) {
            return failResult(new ServiceError(404, 'BOOKING_NOT_FOUND', 'Booking not found.'));
          }
          if (booking.status !== 'requested') {
            return failResult(new ServiceError(409, 'INVALID_TRANSITION', 'Only requested bookings can be approved.'));
          }
          if (String(booking.owner_user_id) !== String(options.ownerUserId)
              || String(booking.account_id) !== String(scope.account_id)) {
            return failResult(new ServiceError(404, 'BOOKING_NOT_FOUND', 'Booking not found.'));
          }

          const quotedCents = parseLedgerAmount(booking.quoted_credits);
          if (quotedCents <= 0) {
            return failResult(new ServiceError(400, 'VALIDATION_ERROR', 'The stored quote is invalid.'));
          }

          const [key1, key2] = advisoryKeys(options.ownerUserId, scope.account_id, booking.date);
          await actionTx`SELECT pg_advisory_xact_lock(${key1}, ${key2})`;

          const candidateStart = `${booking.start_time}:00`;
          const candidateHours = bookingDurationHours(booking);
          const overlaps = await actionTx`
            SELECT id
              FROM bookings
             WHERE owner_user_id = ${options.ownerUserId}
               AND account_id = ${scope.account_id}
               AND date = ${booking.date}
               AND id <> ${options.bookingId}
               AND status IN ('requested', 'approved', 'confirmed')
               AND start_time < (${candidateStart}::time + ${candidateHours} * interval '1 hour')
               AND ${candidateStart}::time < (start_time::time + COALESCE(duration_hours_numeric, duration_hours::numeric) * interval '1 hour')
             LIMIT 1`;
          if (overlaps.length) {
            return failResult(new ServiceError(409, 'BOOKING_OVERLAP', 'The event time overlaps an existing booking.'));
          }

          const ambassadorUserId = options.ambassadorUserId || booking.ambassador_user_id || null;
          if (ambassadorUserId) {
            await lockActiveAmbassador(actionTx, options.ownerUserId, ambassadorUserId);
            await ensureAmbassadorOverlap(actionTx, options.ownerUserId, booking, ambassadorUserId);
          }

          const balance = await readBalance(actionTx, options.ownerUserId, scope.account_id);
          if (parseMoney(balance, { allowZero: true }) < quotedCents) {
            return failResult(new ServiceError(409, 'INSUFFICIENT_CREDITS', 'Insufficient credits.'));
          }

          const charge = await insertBookingCharge(actionTx, {
            ownerUserId: options.ownerUserId,
            accountId: scope.account_id,
            bookingId: options.bookingId,
            quotedCredits: booking.quoted_credits,
            accountName: booking.account_name,
            licenseNumber: booking.license_number,
            date: booking.date,
            actor: options.actor,
            metadata: { quotedCredits: booking.quoted_credits },
          });
          const update = {
            bookingId: options.bookingId,
            ownerUserId: options.ownerUserId,
            version: booking.version,
            fromStatus: 'requested',
            status: 'approved',
            approvedAt: new Date().toISOString(),
            creditsCharged: booking.quoted_credits,
            creditsChargedNumeric: booking.quoted_credits,
            ambassadorUserId,
          };
          if (options.notes != null) update.notesAdmin = String(options.notes);
          const updated = await updateBooking(actionTx, update);
          await insertAudit(actionTx, {
            ownerUserId: options.ownerUserId,
            bookingId: options.bookingId,
            fromStatus: 'requested',
            toStatus: 'approved',
            action: 'approved',
            actor: options.actor,
            requestId: options.key,
            metadata: {
              quotedCredits: booking.quoted_credits,
              ledgerEntryId: charge.id,
              balanceAfter: money(parseMoney(balance, { allowZero: true }) - quotedCents),
            },
          });

          return {
            status: 200,
            body: {
              booking: bookingView(updated),
              balance: Number(money(parseMoney(balance, { allowZero: true }) - quotedCents)),
              ledgerEntryId: charge.id,
            },
          };
        } catch (error) {
          if (error instanceof ServiceError) return failResult(error);
          if (knownDatabaseError(error)) return failResult(mapDatabaseError(error));
          throw error;
        }
      },
    }));
  } catch (error) {
    if (error instanceof ServiceError) return failResult(error);
    return failResult(mapDatabaseError(error));
  }
}

async function cancelBooking(sql, options) {
  try {
    const scope = await scopedBookingLookup(sql, options.bookingId, options.ownerUserId);
    if (!scope) {
      return failResult(new ServiceError(404, 'BOOKING_NOT_FOUND', 'Booking not found.'));
    }
    if (!authorizeCancellation(options.actor, options.ownerUserId, scope.account_id)) {
      return failResult(new ServiceError(403, 'FORBIDDEN_ACTOR', 'You cannot cancel this booking.'));
    }

    return await sql.begin(async (tx) => withIdempotency({
      sql: tx,
      ownerUserId: options.ownerUserId,
      actor: options.actor,
      operation: 'booking.cancel',
      resourceId: options.bookingId,
      key: options.key,
      requestHash: options.requestHash,
      handler: async (actionTx) => {
        try {
          await lockAccount(actionTx, options.ownerUserId, scope.account_id);
          const bookingRows = await actionTx`
            SELECT *
              FROM bookings
             WHERE id = ${options.bookingId}
               AND owner_user_id = ${options.ownerUserId}
               AND account_id = ${scope.account_id}
             FOR UPDATE`;
          const booking = bookingRows[0];
          if (!booking) {
            return failResult(new ServiceError(404, 'BOOKING_NOT_FOUND', 'Booking not found.'));
          }
          if (!['requested', 'approved', 'confirmed'].includes(booking.status)) {
            return failResult(new ServiceError(409, 'INVALID_TRANSITION', 'This booking cannot be cancelled now.'));
          }

          const balance = await readBalance(actionTx, options.ownerUserId, scope.account_id);
          let refund = null;
          if (booking.status !== 'requested') {
            const charge = await findBookingCharge(actionTx, options.ownerUserId, options.bookingId);
            if (!charge) {
              return failResult(new ServiceError(409, 'INVALID_TRANSITION', 'No original charge exists for this booking.'));
            }
            refund = await insertBookingRefund(actionTx, {
              ownerUserId: options.ownerUserId,
              accountId: scope.account_id,
              bookingId: options.bookingId,
              charge,
              accountName: booking.account_name,
              licenseNumber: booking.license_number,
              date: booking.date,
              actor: options.actor,
              metadata: { originalStatus: booking.status },
            });
          }

          const updated = await updateBooking(actionTx, {
            bookingId: options.bookingId,
            ownerUserId: options.ownerUserId,
            version: booking.version,
            fromStatus: booking.status,
            status: 'cancelled',
            cancelledAt: new Date().toISOString(),
          });
          await insertAudit(actionTx, {
            ownerUserId: options.ownerUserId,
            bookingId: options.bookingId,
            fromStatus: booking.status,
            toStatus: 'cancelled',
            action: 'cancelled',
            actor: options.actor,
            requestId: options.key,
            metadata: {
              refundedCredits: refund ? Number(refund.amount) : 0,
              ledgerEntryId: refund ? refund.id : null,
            },
          });

          const refundedCents = refund ? parseLedgerAmount(refund.amount) : 0;
          return {
            status: 200,
            body: {
              booking: bookingView(updated),
              balance: Number(money(parseMoney(balance, { allowZero: true }) + refundedCents)),
              refundedCredits: Number(money(refundedCents)),
              ledgerEntryId: refund ? refund.id : null,
            },
          };
        } catch (error) {
          if (error instanceof ServiceError) return failResult(error);
          if (knownDatabaseError(error)) return failResult(mapDatabaseError(error));
          throw error;
        }
      },
    }));
  } catch (error) {
    if (error instanceof ServiceError) return failResult(error);
    return failResult(mapDatabaseError(error));
  }
}

function declineBooking(sql, options) {
  return runBookingCommand(sql, options, {
    operation: 'booking.decline',
    statuses: ['requested'],
    authorize: isHqOwner,
    apply: async () => ({
      update: {
        status: 'declined',
        notesAdmin: String(options.notes ?? ''),
        declinedAt: new Date().toISOString(),
      },
      action: 'declined',
      metadata: { reason: options.notes || null },
    }),
  });
}

function assignBooking(sql, options) {
  return runBookingCommand(sql, options, {
    operation: 'booking.assign',
    statuses: ['approved', 'confirmed'],
    authorize: isHqOwner,
    apply: async (tx, booking) => {
      const ambassadorUserId = options.ambassadorUserId || null;
      if (ambassadorUserId) {
        await lockActiveAmbassador(tx, options.ownerUserId, ambassadorUserId);
        await ensureAmbassadorOverlap(tx, options.ownerUserId, booking, ambassadorUserId);
      }
      const replacing = booking.status === 'confirmed' || Boolean(booking.ambassador_user_id);
      const update = {
        status: 'approved',
        ambassadorUserId,
      };
      if (booking.status === 'confirmed') update.confirmedAt = null;
      return {
        update,
        action: replacing ? 'reassigned' : 'assigned',
        metadata: {
          fromAmbassadorUserId: booking.ambassador_user_id || null,
          toAmbassadorUserId: ambassadorUserId,
          revokedConfirmation: booking.status === 'confirmed',
        },
      };
    },
  });
}

function acceptBooking(sql, options) {
  return runBookingCommand(sql, options, {
    operation: 'booking.accept',
    statuses: ['approved'],
    authorize: isAssignedAmbassador,
    apply: async (tx, booking) => {
      await lockActiveAmbassador(tx, options.ownerUserId, booking.ambassador_user_id);
      return {
        update: {
          status: 'confirmed',
          confirmedAt: new Date().toISOString(),
        },
        action: 'confirmed',
        metadata: { actorType: 'brand_ambassador' },
      };
    },
  });
}

function declineAssignmentBooking(sql, options) {
  return runBookingCommand(sql, options, {
    operation: 'booking.declineAssignment',
    statuses: ['approved'],
    authorize: isAssignedAmbassador,
    apply: async (tx, booking) => ({
      update: {
        status: 'approved',
        ambassadorUserId: null,
      },
      action: 'assignment_declined',
      metadata: { fromAmbassadorUserId: booking.ambassador_user_id },
    }),
  });
}

function completeBooking(sql, options) {
  return runBookingCommand(sql, options, {
    operation: 'booking.complete',
    statuses: ['confirmed'],
    authorize: isAssignedAmbassador,
    apply: async (tx, booking) => {
      await lockActiveAmbassador(tx, options.ownerUserId, booking.ambassador_user_id);
      return {
        update: {
          status: 'completed',
          completedAt: new Date().toISOString(),
        },
        action: 'completed',
        metadata: { actorType: 'brand_ambassador' },
      };
    },
  });
}

async function removePortalUsersBookings(sql, options) {
  const ownerUserId = options.ownerUserId;
  const portalUserIds = [...new Set((options.portalUserIds || []).map(String))].sort();
  if (!portalUserIds.length) return { status: 200, removed: 0, bookings: [] };

  // Lock order is always account -> booking -> portal_user. The same order is
  // used by booking commands, so deletion cannot deadlock with them.
  const accountRows = await sql`
    SELECT DISTINCT account_id
      FROM bookings
     WHERE owner_user_id = ${ownerUserId}
       AND ambassador_user_id = ANY(${portalUserIds}::text[])
     ORDER BY account_id`;
  for (const row of accountRows) {
    await lockAccount(sql, ownerUserId, row.account_id);
  }

  const bookingRows = await sql`
    SELECT *
      FROM bookings
     WHERE owner_user_id = ${ownerUserId}
       AND ambassador_user_id = ANY(${portalUserIds}::text[])
     ORDER BY id
     FOR UPDATE`;
  const userRows = await sql`
    SELECT id
      FROM portal_users
     WHERE owner_user_id = ${ownerUserId}
       AND id = ANY(${portalUserIds}::text[])
     ORDER BY id
     FOR UPDATE`;

  const changed = [];
  for (const booking of bookingRows) {
    const revokedConfirmation = booking.status === 'confirmed';
    const toStatus = revokedConfirmation ? 'approved' : booking.status;
    const update = {
      bookingId: booking.id,
      ownerUserId,
      version: booking.version,
      fromStatus: booking.status,
      status: toStatus,
      ambassadorUserId: null,
    };
    if (revokedConfirmation) update.confirmedAt = null;
    const updated = await updateBooking(sql, update);
    await insertAudit(sql, {
      ownerUserId,
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus,
      action: 'ambassador_removed',
      actor: options.actor,
      requestId: options.key || null,
      metadata: {
        fromAmbassadorUserId: booking.ambassador_user_id,
        revokedConfirmation,
      },
    });
    changed.push(bookingView(updated));
  }

  await sql`DELETE FROM portal_sessions WHERE user_id = ANY(${portalUserIds}::text[])`;
  await sql`DELETE FROM portal_users
     WHERE owner_user_id = ${ownerUserId}
       AND id = ANY(${portalUserIds}::text[])`;
  if (options.deleteInvites) {
    await sql`DELETE FROM portal_invites WHERE owner_user_id = ${ownerUserId}`;
  }
  if (options.deleteOwnerUser) {
    await sql`DELETE FROM sessions WHERE user_id = ${ownerUserId}`;
    await sql`DELETE FROM users WHERE id = ${ownerUserId}`;
  }

  return { status: 200, removed: userRows.length, bookings: changed };
}

module.exports = {
  updateBooking,
  createBooking,
  approveBooking,
  cancelBooking,
  declineBooking,
  assignBooking,
  acceptBooking,
  declineAssignmentBooking,
  completeBooking,
  removePortalUsersBookings,
  computeQuote,
  bookingView,
  LIVE_STATUSES,
  TERMINAL_STATUSES,
};
