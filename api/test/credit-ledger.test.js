'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseLedgerAmount,
  lockedBalance,
  insertBookingCharge,
  insertBookingRefund,
  findBookingCharge,
  adjustCredits,
  ledgerView,
} = require('../src/credit-ledger');
const { createFakeSql, queryTexts } = require('./helpers/fake-sql');

function accountRow(text) {
  return /FROM accounts[\s\S]*FOR UPDATE/.test(text)
    ? [{ id: 'acc-1', user_id: 'owner-1' }]
    : [];
}

test('ledger amounts must be finite, nonzero and have at most two decimals', () => {
  assert.equal(parseLedgerAmount('12.30'), 1230);
  assert.equal(parseLedgerAmount(-42), -4200);
  for (const bad of [0, '0.00', '', 'abc', '1.234', Infinity, NaN, null, undefined]) {
    assert.throws(
      () => parseLedgerAmount(bad),
      (error) => error.status === 400 && error.code === 'VALIDATION_ERROR'
    );
  }
});

test('balance is read only after locking the owner-scoped account', async () => {
  const { sql, calls } = createFakeSql((text) => {
    if (/FROM accounts[\s\S]*FOR UPDATE/.test(text)) return accountRow(text);
    if (/COALESCE\(SUM/.test(text)) return [{ balance: '12.34' }];
    return [];
  });

  const balance = await lockedBalance(sql, 'owner-1', 'acc-1');

  assert.equal(balance, '12.34');
  const texts = queryTexts(calls);
  assert.match(texts[0], /FROM accounts[\s\S]*WHERE[\s\S]*id[\s\S]*user_id[\s\S]*FOR UPDATE/i);
  assert.match(texts[1], /COALESCE\(SUM[\s\S]*FROM credits/);
  assert.deepEqual(calls[0].values, ['acc-1', 'owner-1']);
  assert.deepEqual(calls[1].values, ['owner-1', 'acc-1']);
});

test('a charge is exactly negative the immutable quote and is append-only', async () => {
  const { sql, calls } = createFakeSql(() => [{
    id: 'credit-charge-1',
    user_id: 'owner-1',
    account_id: 'acc-1',
    amount_numeric: '-12.34',
    entry_type: 'booking_charge',
    booking_id: 'bk-1',
  }]);

  const entry = await insertBookingCharge(sql, {
    ownerUserId: 'owner-1',
    accountId: 'acc-1',
    bookingId: 'bk-1',
    quotedCredits: '12.34',
    actor: { type: 'hq_user', id: 'owner-1' },
    requestId: 'req-1',
  });

  const insert = calls.find((call) => /INSERT INTO credits/.test(call.text));
  assert.ok(insert, 'expected an append-only ledger insert');
  assert.match(insert.text, /INSERT INTO credits/);
  assert.ok(insert.text.includes('amount_numeric'));
  assert.ok(insert.text.includes('entry_type'));
  assert.ok(insert.values.includes('-12.34'));
  assert.ok(insert.values.includes('booking_charge'));
  assert.equal(entry.amountNumeric, '-12.34');
  assert.equal(entry.entryType, 'booking_charge');
});

test('a refund is positive, linked to the original charge and unique per booking', async () => {
  const { sql, calls } = createFakeSql((text) => {
    if (/SELECT[\s\S]*FROM credits[\s\S]*booking_charge/.test(text)) {
      return [{ id: 'credit-charge-1', amount_numeric: '-12.34' }];
    }
    return [{
      id: 'credit-refund-1',
      user_id: 'owner-1',
      account_id: 'acc-1',
      amount_numeric: '12.34',
      entry_type: 'booking_refund',
      booking_id: 'bk-1',
      reverses_credit_id: 'credit-charge-1',
    }];
  });

  const charge = await findBookingCharge(sql, 'owner-1', 'bk-1');
  const refund = await insertBookingRefund(sql, {
    ownerUserId: 'owner-1',
    accountId: 'acc-1',
    bookingId: 'bk-1',
    charge,
    actor: { type: 'hq_owner', id: 'owner-1' },
    requestId: 'req-1',
  });

  assert.match(queryTexts(calls)[0], /FROM credits[\s\S]*booking_charge/);
  const insert = calls.find((call) => /INSERT INTO credits/.test(call.text));
  assert.ok(insert.values.includes('12.34'));
  assert.ok(insert.values.includes('booking_refund'));
  assert.ok(insert.values.includes('credit-charge-1'));
  assert.equal(refund.reversesCreditId, 'credit-charge-1');
  assert.match(insert.text, /ON CONFLICT/i);
});

test('ledger views preserve legacy fields and expose typed metadata', () => {
  assert.deepEqual(ledgerView({
    id: 'c1',
    user_id: 'owner-1',
    account_id: 'acc-1',
    account_name: 'Store',
    license_number: 'L1',
    city: 'Town',
    amount: -12.34,
    note: 'note',
    date: '2026-01-01',
    amount_numeric: '-12.34',
    entry_type: 'booking_charge',
    booking_id: 'bk-1',
    actor_type: 'hq_user',
    actor_id: 'owner-1',
    created_at: '2026-01-01T00:00:00Z',
  }), {
    id: 'c1',
    accountId: 'acc-1',
    accountName: 'Store',
    licenseNumber: 'L1',
    city: 'Town',
    amount: -12.34,
    amountNumeric: '-12.34',
    note: 'note',
    date: '2026-01-01',
    entryType: 'booking_charge',
    bookingId: 'bk-1',
    actorType: 'hq_user',
    actorId: 'owner-1',
    createdAt: '2026-01-01T00:00:00Z',
  });
});

test('manual adjustment locks the owner account, appends once and replays its key', async () => {
  const entries = [];
  let idemInserted = false;
  const completed = [];
  const { sql, calls } = createFakeSql((text, values) => {
    if (/INSERT INTO api_idempotency/.test(text)) {
      if (idemInserted) return [];
      idemInserted = true;
      return [{ id: 'idem-adjust-1' }];
    }
    if (/SELECT[\s\S]*FROM api_idempotency/.test(text)) return completed;
    if (/UPDATE api_idempotency/.test(text)) {
      completed.push({
        id: 'idem-adjust-1',
        request_hash: 'adjust-hash',
        response_status: 201,
        response_body: { entry: { id: 'credit-adjust-1' } },
        completed_at: 'now',
      });
      return [{}];
    }
    if (/FROM accounts[\s\S]*FOR UPDATE/.test(text)) return [{ id: 'acc-1', user_id: 'owner-1' }];
    if (/INSERT INTO credits/.test(text)) {
      entries.push(values);
      return [{
        id: 'credit-adjust-1',
        user_id: 'owner-1',
        account_id: 'acc-1',
        amount_numeric: '5.00',
        entry_type: 'adjustment',
      }];
    }
    if (/COALESCE\(SUM/.test(text)) return [{ balance: '17.34' }];
    return [];
  });

  const args = {
    ownerUserId: 'owner-1',
    accountId: 'acc-1',
    amount: '5.00',
    note: 'manual grant',
    actor: { type: 'hq_user', id: 'owner-1' },
    key: 'adjust-key',
    requestHash: 'adjust-hash',
  };
  const first = await adjustCredits(sql, args);
  const replay = await adjustCredits(sql, args);

  assert.equal(first.status, 201);
  assert.equal(replay.replayed, true);
  assert.equal(entries.length, 1);
  const accountLock = calls.findIndex((call) => /FROM accounts[\s\S]*FOR UPDATE/.test(call.text));
  const ledgerInsert = calls.findIndex((call) => /INSERT INTO credits/.test(call.text));
  assert.ok(accountLock >= 0 && accountLock < ledgerInsert);
});

test('manual adjustment rejects a foreign account without writing to the ledger', async () => {
  const { sql, calls } = createFakeSql((text) => {
    if (/INSERT INTO api_idempotency/.test(text)) return [{ id: 'idem-adjust-2' }];
    if (/FROM accounts[\s\S]*FOR UPDATE/.test(text)) return [];
    return [];
  });

  await assert.rejects(
    adjustCredits(sql, {
      ownerUserId: 'owner-a',
      accountId: 'foreign-account',
      amount: '5.00',
      actor: { type: 'hq_user', id: 'owner-a' },
      key: 'adjust-key-2',
      requestHash: 'adjust-hash-2',
    }),
    (error) => error.status === 404 && error.code === 'ACCOUNT_NOT_FOUND'
  );
  assert.ok(!queryTexts(calls).some((text) => /INSERT INTO credits/.test(text)));
});
