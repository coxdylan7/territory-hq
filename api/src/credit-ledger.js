'use strict';

const crypto = require('node:crypto');
const { ServiceError, mapDatabaseError } = require('./service-errors');
const { withIdempotency } = require('./idempotency');

function parseMoney(value, { allowZero = false } = {}) {
  const text = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new ServiceError(400, 'VALIDATION_ERROR', 'Amount must be a number with at most two decimal places.');
  }
  const cents = Math.round(Number(text) * 100);
  if (cents === 0 && !allowZero) {
    throw new ServiceError(400, 'VALIDATION_ERROR', 'Amount must not be zero.');
  }
  return cents;
}

function parseLedgerAmount(value) {
  return parseMoney(value);
}

function money(cents) {
  return (cents / 100).toFixed(2);
}

async function lockAccount(sql, ownerUserId, accountId) {
  const rows = await sql`
    SELECT id, user_id
      FROM accounts
     WHERE id = ${accountId}
       AND user_id = ${ownerUserId}
     FOR UPDATE`;
  if (!rows.length) {
    throw new ServiceError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
  }
  return rows[0];
}

async function readBalance(sql, ownerUserId, accountId) {
  const rows = await sql`
    SELECT COALESCE(SUM(COALESCE(amount_numeric, round(amount::numeric, 2))), 0)::text AS balance
      FROM credits
     WHERE user_id = ${ownerUserId}
       AND account_id = ${accountId}`;
  return rows[0] ? String(rows[0].balance) : '0';
}

async function lockedBalance(sql, ownerUserId, accountId) {
  await lockAccount(sql, ownerUserId, accountId);
  return readBalance(sql, ownerUserId, accountId);
}

function ledgerView(row) {
  if (!row) return null;
  const view = {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    licenseNumber: row.license_number,
    city: row.city,
    amount: Number(row.amount_numeric == null ? row.amount : row.amount_numeric),
    note: row.note,
    date: row.date,
    entryType: row.entry_type || null,
    bookingId: row.booking_id || null,
    actorType: row.actor_type || null,
    actorId: row.actor_id || null,
    createdAt: row.created_at || null,
  };
  if (row.amount_numeric != null) view.amountNumeric = row.amount_numeric;
  if (row.source_id != null) view.sourceId = row.source_id;
  if (row.idempotency_key != null) view.idempotencyKey = row.idempotency_key;
  if (row.reverses_credit_id != null) view.reversesCreditId = row.reverses_credit_id;
  return view;
}

async function insertLedgerEntry(sql, options) {
  const cents = parseLedgerAmount(options.amount);
  const amount = money(cents);
  try {
    const rows = await sql`
      INSERT INTO credits (
        id, user_id, account_id, account_name, license_number, city,
        amount, amount_numeric, note, date, entry_type, booking_id,
        source_id, idempotency_key, reverses_credit_id,
        actor_type, actor_id, created_at, metadata
      )
      VALUES (
        ${crypto.randomUUID()}, ${options.ownerUserId}, ${options.accountId},
        ${options.accountName || null}, ${options.licenseNumber || null}, ${options.city || null},
        ${amount}, ${amount}, ${options.note || null}, ${options.date || null},
        ${options.entryType}, ${options.bookingId || null}, ${options.sourceId || null},
        ${options.idempotencyKey || null}, ${options.reversesCreditId || null},
        ${options.actor.type}, ${options.actor.id}, now(),
        ${JSON.stringify(options.metadata || {})}::jsonb
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *`;
    if (!rows.length) {
      throw new ServiceError(409, 'INVALID_TRANSITION', 'The ledger entry already exists.');
    }
    return ledgerView(rows[0]);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw mapDatabaseError(error);
  }
}

async function insertBookingCharge(sql, options) {
  const quoteCents = parseLedgerAmount(options.quotedCredits);
  return insertLedgerEntry(sql, {
    ...options,
    entryType: 'booking_charge',
    amount: money(-quoteCents),
    note: options.note || `Booking charge — ${options.bookingId}`,
    date: options.date || null,
    metadata: { quotedCredits: money(quoteCents), ...(options.metadata || {}) },
  });
}

async function findBookingCharge(sql, ownerUserId, bookingId) {
  const rows = await sql`
    SELECT id, amount, amount_numeric, booking_id
      FROM credits
     WHERE user_id = ${ownerUserId}
       AND booking_id = ${bookingId}
       AND entry_type = 'booking_charge'
     LIMIT 1`;
  return rows[0] || null;
}

async function insertBookingRefund(sql, options) {
  const charge = options.charge;
  if (!charge) {
    throw new ServiceError(409, 'INVALID_TRANSITION', 'No original charge exists for this booking.');
  }
  const chargedCents = parseLedgerAmount(charge.amount_numeric == null ? charge.amount : charge.amount_numeric);
  return insertLedgerEntry(sql, {
    ...options,
    entryType: 'booking_refund',
    amount: money(-chargedCents),
    reversesCreditId: charge.id,
    note: options.note || `Booking refund — ${options.bookingId}`,
    date: options.date || null,
    metadata: { reversesCreditId: charge.id, ...(options.metadata || {}) },
  });
}

async function adjustCredits(sql, options) {
  return sql.begin(async (tx) => withIdempotency({
    sql: tx,
    ownerUserId: options.ownerUserId,
    actor: options.actor,
    operation: 'credits.adjust',
    resourceId: options.accountId,
    key: options.key,
    requestHash: options.requestHash,
    handler: async (actionTx) => {
      const amount = options.amount;
      parseLedgerAmount(amount);
      await lockAccount(actionTx, options.ownerUserId, options.accountId);
      const entry = await insertLedgerEntry(actionTx, {
        ownerUserId: options.ownerUserId,
        accountId: options.accountId,
        accountName: options.accountName,
        licenseNumber: options.licenseNumber,
        city: options.city,
        amount,
        note: options.note,
        date: options.date || null,
        entryType: 'adjustment',
        idempotencyKey: options.key,
        actor: options.actor,
        metadata: { source: 'manual_adjustment' },
      });
      const balance = await readBalance(actionTx, options.ownerUserId, options.accountId);
      return { status: 201, body: { entry, balance: Number(balance) } };
    },
  }));
}

module.exports = {
  parseLedgerAmount,
  parseMoney,
  money,
  lockAccount,
  readBalance,
  lockedBalance,
  ledgerView,
  insertLedgerEntry,
  insertBookingCharge,
  findBookingCharge,
  insertBookingRefund,
  adjustCredits,
};
