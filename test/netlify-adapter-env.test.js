'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

let adapter;
test.before(async () => {
  adapter = await import(pathToFileURL(path.join(__dirname, '../netlify/lib/api-adapter.mjs')).href);
});

const validEnv = () => ({
  DATABASE_URL: 'postgres://not-a-real-value@example.invalid/db',
  SKIP_SCHEMA: '1',
  PUBLIC_ORIGIN: 'https://hq.example.com',
  TRUST_PROXY: '1',
});

test('missing or unsafe function environment is reported by key name only', () => {
  assert.deepEqual(adapter.missingFunctionEnv({}), [
    'DATABASE_URL', 'SKIP_SCHEMA', 'PUBLIC_ORIGIN', 'TRUST_PROXY',
  ]);
  assert.deepEqual(adapter.missingFunctionEnv(validEnv()), []);

  for (const bad of ['https://*.example.com', 'https://hq.example.com/path', 'null', 'http://']) {
    assert.deepEqual(
      adapter.missingFunctionEnv({ ...validEnv(), PUBLIC_ORIGIN: bad }),
      ['PUBLIC_ORIGIN'],
      `${bad} is not an exact browser origin`
    );
  }
  assert.deepEqual(
    adapter.missingFunctionEnv({ ...validEnv(), SKIP_SCHEMA: '0' }),
    ['SKIP_SCHEMA']
  );
  assert.deepEqual(
    adapter.missingFunctionEnv({ ...validEnv(), TRUST_PROXY: '0' }),
    ['TRUST_PROXY']
  );
});

test('every incoming path is normalized to the same-origin API namespace', () => {
  for (const [input, expected] of [
    ['/api/health', '/api/health'],
    ['/api/health?x=1', '/api/health'],
    ['/api', '/api'],
    ['/.netlify/functions/hq-api/api/health', '/api/health'],
    ['/.netlify/functions/hq-api', '/api'],
    ['/.netlify/functions/portal-api/api/me', '/api/me'],
    ['/', '/api'],
    ['', '/api'],
    ['/health', '/api/health'],
  ]) {
    const name = input.includes('portal-api') ? 'portal-api' : 'hq-api';
    assert.equal(adapter.normalizeApiPath(input, name), expected, `from ${input}`);
  }
});

test('lambda wrapper fails closed before reaching Express when env is absent', async () => {
  let called = 0;
  const wrapped = adapter.makeLambdaHandler(async () => {
    called += 1;
    return { statusCode: 200, body: 'ok' };
  }, 'hq-api', {});

  const result = await wrapped({ path: '/api/health', headers: {} }, { requestId: 'r1' });
  assert.equal(called, 0);
  assert.equal(result.statusCode, 503);
  assert.equal(JSON.parse(result.body).error, 'function environment is not configured');
  assert.doesNotMatch(result.body, /postgres:\/\//);
});

test('lambda wrapper forwards normalized path, body-relevant event and context', async () => {
  const seen = [];
  const wrapped = adapter.makeLambdaHandler(async (event, context) => {
    seen.push({ event, context });
    return { statusCode: 201, headers: { 'X-Test': 'yes' }, body: 'created' };
  }, 'hq-api', validEnv());

  const event = {
    path: '/.netlify/functions/hq-api/api/bookings',
    httpMethod: 'post',
    headers: { cookie: 'thq_session=abc' },
    body: '{"a":1}',
  };
  const context = { requestId: 'r2' };
  const result = await wrapped(event, context);

  assert.deepEqual(result, { statusCode: 201, headers: { 'X-Test': 'yes' }, body: 'created' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event.path, '/api/bookings');
  assert.equal(seen[0].event.httpMethod, 'POST');
  assert.equal(seen[0].event.body, '{"a":1}');
  assert.equal(seen[0].event.headers.cookie, 'thq_session=abc');
  assert.equal(seen[0].context, context);
});
