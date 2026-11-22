'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BLAST_LIMITS,
  worstCaseBlastDurationMs,
} = require('../../shared/blast-limits.cjs');
const { createBlastService } = require('../src/messages-blast');
const { createFakeBlastDb } = require('./helpers/fake-blast-db');

function unusableDeps() {
  let twilioCalls = 0;
  return {
    twilioCalls: () => twilioCalls,
    sendSmsTwilio: async () => { twilioCalls += 1; throw new Error('Twilio must not be called'); },
    sql: () => { throw new Error('database must not be touched'); },
  };
}

test('central blast limits make the worst-case Twilio wall time fit the Netlify budget', () => {
  assert.equal(BLAST_LIMITS.maxRecipients, 10);
  assert.equal(BLAST_LIMITS.concurrency, 5);
  assert.equal(BLAST_LIMITS.twilioTimeoutMs, 8000);
  assert.equal(BLAST_LIMITS.netlifySyncLimitMs, 60000);
  assert.equal(worstCaseBlastDurationMs(), 2 * 8000);
  assert.ok(worstCaseBlastDurationMs() <= BLAST_LIMITS.netlifySyncLimitMs - 12000);
});

test('the blast service rejects an oversize request before Twilio or the database are touched', async () => {
  const deps = unusableDeps();
  const service = createBlastService(deps);
  await assert.rejects(
    () => service.sendBlast({
      ownerUserId: 'owner-1',
      actor: { type: 'hq_user', id: 'owner-1' },
      key: 'batch-1',
      accountIds: Array.from({ length: BLAST_LIMITS.maxRecipients + 1 }, (_, i) => `acc-${i + 1}`),
      template: 'Hello {name}',
    }),
    (error) => error.status === 413 && error.code === 'BLAST_TOO_MANY_RECIPIENTS'
  );
  assert.equal(deps.twilioCalls(), 0);
});

test('the blast service rejects malformed recipients, duplicates and templates', async () => {
  const deps = unusableDeps();
  const service = createBlastService(deps);
  const base = {
    ownerUserId: 'owner-1',
    actor: { type: 'hq_user', id: 'owner-1' },
    key: 'batch-1',
    template: 'Hello {name}',
  };

  for (const accountIds of [null, [], 'acc-1', ['acc-1', 7], ['acc-1', ''], ['acc-1', 'acc-1']]) {
    await assert.rejects(
      () => service.sendBlast({ ...base, accountIds }),
      (error) => error.status === 400 && error.code === 'BLAST_INVALID_REQUEST'
    );
  }
  for (const template of ['', '   ', 42]) {
    await assert.rejects(
      () => service.sendBlast({ ...base, accountIds: ['acc-1'], template }),
      (error) => error.status === 400 && error.code === 'BLAST_INVALID_REQUEST'
    );
  }
  assert.equal(deps.twilioCalls(), 0);
});

function accounts(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `acc-${i + 1}`,
    user_id: 'owner-1',
    name: `Store ${i + 1}`,
    license_number: `LIC-${i + 1}`,
    city: 'Testville',
    phone: `+1555000${String(i + 1).padStart(4, '0')}`,
  }));
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 2000; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('delivery uses the configured concurrency and gives every Twilio call the central timeout', async () => {
  const db = createFakeBlastDb({ accounts: accounts(BLAST_LIMITS.maxRecipients) });
  let active = 0;
  let maxActive = 0;
  const waiting = [];
  const sendCalls = [];
  const sendSmsTwilio = (to, text, options) => new Promise((resolve) => {
    sendCalls.push({ to, text, options });
    active += 1;
    maxActive = Math.max(maxActive, active);
    waiting.push(() => { active -= 1; resolve({ sent: true, sid: `sm-${to}` }); });
  });
  const service = createBlastService({ sql: db.sql, sendSmsTwilio });

  const pending = service.sendBlast({
    ownerUserId: 'owner-1',
    actor: { type: 'hq_user', id: 'owner-1' },
    key: 'batch-concurrency',
    accountIds: accounts(BLAST_LIMITS.maxRecipients).map((a) => a.id),
    template: 'Hi {name}',
  });

  await waitFor(() => waiting.length === BLAST_LIMITS.concurrency, 'the first wave');
  assert.equal(maxActive, BLAST_LIMITS.concurrency, 'a wave must never exceed the cap');
  waiting.splice(0, BLAST_LIMITS.concurrency).forEach((release) => release());
  await waitFor(() => sendCalls.length === BLAST_LIMITS.maxRecipients, 'the second wave');
  assert.equal(waiting.length, BLAST_LIMITS.concurrency, 'only one wave may be in flight');
  assert.equal(maxActive, BLAST_LIMITS.concurrency, 'the second wave must not overlap beyond the cap');
  waiting.splice(0).forEach((release) => release());

  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.body.sent, BLAST_LIMITS.maxRecipients);
  assert.equal(sendCalls.length, BLAST_LIMITS.maxRecipients);
  assert.ok(sendCalls.every((call) => call.options.timeoutMs === BLAST_LIMITS.twilioTimeoutMs));
  assert.equal(db.messages.size, BLAST_LIMITS.maxRecipients);
});

test('partial failures are reported explicitly and never mark an unconfirmed SMS as sent', async () => {
  const db = createFakeBlastDb({
    accounts: [
      { ...accounts(1)[0], id: 'acc-ok' },
      { ...accounts(2)[1], id: 'acc-error' },
      { ...accounts(3)[2], id: 'acc-no-phone', phone: '' },
      { ...accounts(4)[3], id: 'acc-timeout' },
      { id: 'acc-other-owner', user_id: 'owner-2', name: 'Other', phone: '+15559999999' },
    ],
  });
  const sendSmsTwilio = async (to) => {
    if (to.endsWith('0002')) return { sent: false, reason: 'carrier rejected' };
    if (to.endsWith('0004')) return { sent: false, reason: 'timeout after 8000ms' };
    return { sent: true, sid: 'sm-ok' };
  };
  const service = createBlastService({ sql: db.sql, sendSmsTwilio });

  const result = await service.sendBlast({
    ownerUserId: 'owner-1',
    actor: { type: 'hq_user', id: 'owner-1' },
    key: 'batch-partial',
    accountIds: ['acc-ok', 'acc-error', 'acc-no-phone', 'acc-timeout', 'acc-other-owner'],
    template: 'Hi {name}',
  });

  assert.equal(result.status, 207);
  assert.deepEqual(
    {
      sent: result.body.sent,
      queued: result.body.queued,
      skipped: result.body.skipped,
      failed: result.body.failed,
    },
    { sent: 1, queued: 2, skipped: 2, failed: 0 }
  );
  assert.equal(result.body.total, 5);
  const byAccount = Object.fromEntries(result.body.results.map((r) => [r.accountId, r]));
  assert.equal(byAccount['acc-ok'].status, 'sent');
  assert.equal(byAccount['acc-error'].status, 'queued');
  assert.match(byAccount['acc-error'].reason, /carrier rejected/);
  assert.equal(byAccount['acc-no-phone'].status, 'skipped');
  assert.equal(byAccount['acc-timeout'].status, 'queued');
  assert.equal(byAccount['acc-other-owner'].status, 'skipped', "another owner's account must never be selected");
  assert.deepEqual(
    [...db.messages.values()].map((m) => m.status).sort(),
    ['queued', 'queued', 'sent']
  );
});

const idempotentAccounts = () => [
  { id: 'acc-1', user_id: 'owner-1', name: 'One', license_number: 'L1', city: 'Town', phone: '+15550000001' },
  { id: 'acc-2', user_id: 'owner-1', name: 'Two', license_number: 'L2', city: 'Town', phone: '+15550000002' },
];
const idempotentRequest = {
  ownerUserId: 'owner-1',
  actor: { type: 'hq_user', id: 'owner-1' },
  key: 'batch-retry-key',
  accountIds: ['acc-1', 'acc-2'],
  template: 'Hi {name}',
};

test('a replayed batch key returns the stored result without sending again', async () => {
  const db = createFakeBlastDb({ accounts: idempotentAccounts() });
  let sends = 0;
  const service = createBlastService({
    sql: db.sql,
    sendSmsTwilio: async () => { sends += 1; return { sent: true, sid: `sm-${sends}` }; },
  });

  const first = await service.sendBlast(idempotentRequest);
  const replay = await service.sendBlast(idempotentRequest);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.equal(sends, 2, 'an automatic retry must never duplicate SMS');
  assert.equal(db.messages.size, 2);
});

test('retry after an interrupted batch persist reuses per-recipient outcomes and never resends', async () => {
  const db = createFakeBlastDb({ accounts: idempotentAccounts(), failBatchPersistOnce: true });
  let sends = 0;
  const service = createBlastService({
    sql: db.sql,
    sendSmsTwilio: async () => { sends += 1; return { sent: true, sid: `sm-${sends}` }; },
  });

  await assert.rejects(() => service.sendBlast(idempotentRequest), /injected batch persist failure/);
  assert.equal(sends, 2);
  assert.equal(db.messages.size, 2);

  const retry = await service.sendBlast(idempotentRequest);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.sent, 2);
  assert.equal(sends, 2, 'no Twilio call may be repeated after a partial failure');
  assert.equal(db.messages.size, 2);
});

test('a replayed key with a different request fails closed without sending', async () => {
  const db = createFakeBlastDb({ accounts: idempotentAccounts() });
  let sends = 0;
  const service = createBlastService({
    sql: db.sql,
    sendSmsTwilio: async () => { sends += 1; return { sent: true }; },
  });

  await service.sendBlast(idempotentRequest);
  await assert.rejects(
    () => service.sendBlast({ ...idempotentRequest, template: 'Different message' }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED' && error.status === 409
  );
  assert.equal(sends, 2, 'the second send belongs to a different, unauthorized replay attempt and is rejected before delivery');
});
