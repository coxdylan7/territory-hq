'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readIdempotencyKey,
  canonicalRequestHash,
  withIdempotency,
} = require('../src/idempotency');

function fakeTx(handler) {
  const calls = [];
  const tx = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    return Promise.resolve(handler(text, values, calls));
  };
  return { tx, calls };
}

test('Idempotency-Key is read case-insensitively and validated', () => {
  assert.equal(readIdempotencyKey({ headers: { 'IDEMPOTENCY-KEY': ' key-1 ' } }), 'key-1');
  assert.equal(readIdempotencyKey({ headers: { 'idempotency-key': 'x'.repeat(128) } }), 'x'.repeat(128));

  for (const headers of [
    {},
    { 'idempotency-key': '' },
    { 'idempotency-key': 'x'.repeat(129) },
    { 'idempotency-key': 'bad\nkey' },
  ]) {
    assert.throws(
      () => readIdempotencyKey({ headers }),
      (error) => error.code === 'IDEMPOTENCY_KEY_REQUIRED' && error.status === 400
    );
  }
});

test('canonical request hash includes operation, resource, actor and body values', () => {
  const base = {
    operation: 'approve',
    resourceId: 'bk-1',
    actor: { type: 'hq_user', id: 'owner-1' },
    body: { b: 2, a: 1 },
  };
  const reordered = { ...base, body: { a: 1, b: 2 } };
  assert.equal(canonicalRequestHash(base), canonicalRequestHash(reordered));
  assert.notEqual(canonicalRequestHash(base), canonicalRequestHash({ ...base, resourceId: 'bk-2' }));
  assert.notEqual(canonicalRequestHash(base), canonicalRequestHash({ ...base, body: { a: 1, b: 3 } }));
});

test('a new idempotency record is acquired in the action transaction and its response is persisted', async () => {
  const stored = new Map();
  const { tx, calls } = fakeTx((text, values) => {
    if (/INSERT INTO api_idempotency/.test(text)) {
      stored.set(values[5], {
        id: 'idem-1',
        owner_user_id: values[1],
        actor_type: values[2],
        actor_id: values[3],
        operation: values[4],
        idempotency_key: values[5],
        request_hash: values[6],
        response_status: null,
        response_body: null,
        completed_at: null,
      });
      return [{ id: 'idem-1' }];
    }
    if (/UPDATE api_idempotency/.test(text)) {
      const row = [...stored.values()].find((r) => r.idempotency_key === values[2]);
      row.response_status = values[0];
      row.response_body = values[1];
      row.completed_at = 'now';
      return [row];
    }
    return [];
  });

  let handlerCalls = 0;
  const first = await withIdempotency({
    sql: tx,
    ownerUserId: 'owner-1',
    actor: { type: 'hq_user', id: 'user-1' },
    operation: 'booking.approve',
    resourceId: 'bk-1',
    key: 'same-key',
    requestHash: 'hash-a',
    handler: async () => {
      handlerCalls += 1;
      return { status: 200, body: { ok: true } };
    },
  });

  assert.deepEqual(first, { status: 200, body: { ok: true }, replayed: false });
  assert.equal(handlerCalls, 1);
  assert.ok(calls.some((call) => /INSERT INTO api_idempotency/.test(call.text)));
  assert.ok(calls.some((call) => /UPDATE api_idempotency/.test(call.text)));
});

test('the same key and hash replay the stored response without rerunning the handler', async () => {
  const rows = [{
    id: 'idem-1',
    request_hash: 'hash-a',
    response_status: 409,
    response_body: { error: 'not enough credits', code: 'INSUFFICIENT_CREDITS' },
    completed_at: 'now',
  }];
  const { tx } = fakeTx((text) => {
    if (/INSERT INTO api_idempotency/.test(text)) return [];
    if (/SELECT[\s\S]*FROM api_idempotency/.test(text)) return rows;
    return [];
  });

  let handlerCalls = 0;
  const replay = await withIdempotency({
    sql: tx,
    ownerUserId: 'owner-1',
    actor: { type: 'hq_user', id: 'user-1' },
    operation: 'booking.approve',
    resourceId: 'bk-1',
    key: 'same-key',
    requestHash: 'hash-a',
    handler: async () => {
      handlerCalls += 1;
      return { status: 200, body: { ok: true } };
    },
  });

  assert.equal(handlerCalls, 0);
  assert.deepEqual(replay, {
    status: 409,
    body: { error: 'not enough credits', code: 'INSUFFICIENT_CREDITS' },
    replayed: true,
  });
});

test('the same key with a different canonical hash is rejected without a state change', async () => {
  const row = { id: 'idem-1', request_hash: 'hash-a', completed_at: null };
  const { tx, calls } = fakeTx((text) => {
    if (/INSERT INTO api_idempotency/.test(text)) return [];
    if (/SELECT[\s\S]*FROM api_idempotency/.test(text)) return [row];
    return [];
  });

  let handlerCalls = 0;
  await assert.rejects(
    withIdempotency({
      sql: tx,
      ownerUserId: 'owner-1',
      actor: { type: 'hq_user', id: 'user-1' },
      operation: 'booking.approve',
      resourceId: 'bk-1',
      key: 'same-key',
      requestHash: 'hash-b',
      handler: async () => {
        handlerCalls += 1;
        return { status: 200, body: {} };
      },
    }),
    (error) => error.status === 409 && error.code === 'IDEMPOTENCY_KEY_REUSED'
  );

  assert.equal(handlerCalls, 0);
  assert.ok(!calls.some((call) => /UPDATE bookings|INSERT INTO credits/.test(call.text)));
});
