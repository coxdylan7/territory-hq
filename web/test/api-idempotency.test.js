import test from 'node:test';
import assert from 'node:assert/strict';

import { api, ApiError, newIdempotencyKey } from '../src/api.js';

const originalFetch = globalThis.fetch;
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function fakeResponse(status, body, replayed = false) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'idempotency-replayed' && replayed ? 'true' : null) },
    json: async () => body,
  };
}

function installDeterministicCrypto() {
  let count = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { randomUUID: () => `key-${++count}` },
  });
  return () => count;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else delete globalThis.crypto;
});

test('an action gets one generated key and reuses it for transport retries', async () => {
  const count = installDeterministicCrypto();
  const keys = [];
  let firstCall = true;
  globalThis.fetch = async (path, options) => {
    keys.push(options.headers['Idempotency-Key']);
    if (firstCall) { firstCall = false; throw new Error('network interruption'); }
    return fakeResponse(200, { ok: true });
  };

  assert.deepEqual(await api.action('PUT', '/api/bookings/bk-1/approve', {}), { ok: true });
  assert.deepEqual(keys, ['key-1', 'key-1']);
  assert.equal(count(), 1);

  await api.action('PUT', '/api/bookings/bk-1/approve', {});
  assert.deepEqual(keys, ['key-1', 'key-1', 'key-2']);
});

test('machine-readable codes and human errors are both preserved', async () => {
  installDeterministicCrypto();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return fakeResponse(409, {
      error: 'Insufficient credits.',
      code: 'INSUFFICIENT_CREDITS',
      details: { balance: '5.00' },
    });
  };

  await assert.rejects(
    () => api.action('POST', '/api/credits', { amount: 10 }),
    (error) => error instanceof ApiError
      && error.status === 409
      && error.code === 'INSUFFICIENT_CREDITS'
      && error.details.balance === '5.00'
      && error.message.includes('Insufficient credits.')
  );
  assert.equal(calls, 1, 'business failures must not be retried');
});

test('fallback key generation produces a UUID-shaped value', () => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: (bytes) => bytes.fill(7) },
  });
  assert.match(newIdempotencyKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
