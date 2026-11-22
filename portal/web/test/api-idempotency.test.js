import test from 'node:test';
import assert from 'node:assert/strict';

import { api, ApiError, newIdempotencyKey } from '../src/api.js';

const originalFetch = globalThis.fetch;
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalWindow = globalThis.window;

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
    value: { randomUUID: () => `portal-key-${++count}` },
  });
  return () => count;
}

test.beforeEach(() => {
  globalThis.window = { dispatchEvent() {} };
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else delete globalThis.crypto;
});

test('portal actions reuse one key across transport retries and rotate for new clicks', async () => {
  const count = installDeterministicCrypto();
  const keys = [];
  let attempt = 0;
  globalThis.fetch = async (path, options) => {
    keys.push(options.headers['Idempotency-Key']);
    attempt += 1;
    if (attempt === 1) return fakeResponse(503, { error: 'try again', code: 'TEMPORARY' });
    return fakeResponse(201, { booking: { id: 'bk-1' } });
  };

  const result = await api.action('POST', '/api/bookings', { eventTypeId: 'et-1' });
  assert.equal(result.booking.id, 'bk-1');
  assert.deepEqual(keys, ['portal-key-1', 'portal-key-1']);
  assert.equal(count(), 1);

  await api.action('PUT', '/api/bookings/bk-1/cancel', {});
  assert.deepEqual(keys, ['portal-key-1', 'portal-key-1', 'portal-key-2']);
});

test('portal client exposes stable codes without losing the human message', async () => {
  installDeterministicCrypto();
  globalThis.fetch = async () => fakeResponse(403, {
    error: 'you are not assigned to that event, or it is already handled',
    code: 'FORBIDDEN_ACTOR',
  });

  await assert.rejects(
    () => api.action('PUT', '/api/bookings/bk-1/accept', {}),
    (error) => error instanceof ApiError
      && error.code === 'FORBIDDEN_ACTOR'
      && error.message.includes('you are not assigned to that event')
  );
});

test('portal fallback key generation produces a UUID-shaped value', () => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: (bytes) => bytes.fill(15) },
  });
  assert.match(newIdempotencyKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
