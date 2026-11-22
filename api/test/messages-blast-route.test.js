'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { BLAST_LIMITS } = require('../../shared/blast-limits.cjs');
const { createFakeBlastDb } = require('./helpers/fake-blast-db');

const ORIGINAL_ENV = {
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
  FIRST_PARTY_ORIGINS: process.env.FIRST_PARTY_ORIGINS,
};

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function withApp(t, options, run) {
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.FIRST_PARTY_ORIGINS;
  const server = await listen(createApp({ serveWeb: false, ...options }));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await close(server);
    for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return run(base);
}

async function post(base, body, { cookie = false, origin = base, idempotencyKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = 'thq_session=session-1';
  if (origin !== null) headers.Origin = origin;
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
  return fetch(`${base}/api/messages/blast`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function appDb() {
  return createFakeBlastDb({
    users: [{ id: 'owner-1', email: 'owner@example.test', status: 'active', role: 'user' }],
    sessions: [{ token: 'session-1', user_id: 'owner-1', expires: '2099-01-01T00:00:00.000Z' }],
    accounts: [
      { id: 'mine', user_id: 'owner-1', name: 'Mine', license_number: 'L1', city: 'Town', phone: '+15550000001' },
      { id: 'theirs', user_id: 'owner-2', name: 'Theirs', license_number: 'L2', city: 'Town', phone: '+15550000002' },
    ],
  });
}

test('blast route requires an active session and a first-party browser origin', async (t) => {
  const db = appDb();
  await withApp(t, { sql: db.sql, sendSmsTwilio: async () => ({ sent: true }) }, async (base) => {
    const noSession = await post(base, { accountIds: ['mine'], template: 'Hi' }, { cookie: false, origin: null });
    assert.equal(noSession.status, 401);

    const crossOrigin = await post(base, { accountIds: ['mine'], template: 'Hi' }, {
      cookie: true, origin: 'https://evil.example', idempotencyKey: 'csrf-key',
    });
    assert.equal(crossOrigin.status, 403);
  });
});

test('blast route requires a valid Idempotency-Key before any delivery', async (t) => {
  const db = appDb();
  await withApp(t, { sql: db.sql, sendSmsTwilio: async () => ({ sent: true }) }, async (base) => {
    const missing = await post(base, { accountIds: ['mine'], template: 'Hi' }, { cookie: true });
    assert.equal(missing.status, 400);
    const body = await missing.json();
    assert.equal(body.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });
});

test('blast route rejects an oversize request even when a client tried to chunk', async (t) => {
  const db = appDb();
  let sends = 0;
  await withApp(t, {
    sql: db.sql,
    sendSmsTwilio: async () => { sends += 1; return { sent: true }; },
  }, async (base) => {
    const response = await post(base, {
      accountIds: Array.from({ length: BLAST_LIMITS.maxRecipients + 1 }, (_, i) => `acc-${i}`),
      template: 'Hi',
    }, { cookie: true, idempotencyKey: 'oversize-key' });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, 'BLAST_TOO_MANY_RECIPIENTS');
    assert.equal(sends, 0);
  });
});

test('blast route scopes accounts to the session owner and reports partial results', async (t) => {
  const db = appDb();
  await withApp(t, {
    sql: db.sql,
    sendSmsTwilio: async () => ({ sent: true, sid: 'sm-1' }),
  }, async (base) => {
    const response = await post(base, {
      accountIds: ['mine', 'theirs'],
      template: 'Hi {name}',
    }, { cookie: true, idempotencyKey: 'owner-scope-key' });
    assert.equal(response.status, 207);
    const body = await response.json();
    assert.equal(body.sent, 1);
    assert.equal(body.skipped, 1);
    assert.equal(db.messages.size, 1);
    assert.equal([...db.messages.values()][0].user_id, 'owner-1');
  });
});
