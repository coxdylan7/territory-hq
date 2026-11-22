const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { corsMiddleware } = require('../src/cors');
const { trustProxySetting } = require('../src/trust-proxy');

const env = {
  PUBLIC_ORIGIN: 'https://hq.example.com',
  FIRST_PARTY_ORIGINS: 'https://portal.example.com',
  ALLOWED_ORIGINS: 'https://consumer.example',
};

function run(origin, method = 'GET', envOverride = env) {
  const headers = {};
  const res = {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    set(name, value) { this.setHeader(name, value); return this; },
    status() { return this; },
    sendStatus(code) { this.statusCode = code; return this; },
    json() { return this; },
  };
  let nextCalled = false;
  corsMiddleware(envOverride)({ method, headers: origin ? { origin } : {} }, res, () => { nextCalled = true; });
  return { headers, nextCalled, statusCode: res.statusCode };
}

test('credentialed CORS is exact for PUBLIC_ORIGIN and FIRST_PARTY_ORIGINS', () => {
  for (const origin of ['https://hq.example.com', 'https://portal.example.com']) {
    const { headers, nextCalled } = run(origin, 'POST');
    assert.equal(headers['access-control-allow-origin'], origin);
    assert.equal(headers['access-control-allow-credentials'], 'true');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.match(headers['access-control-allow-methods'], new RegExp(method));
    }
    assert.equal(headers.vary, 'Origin');
    assert.equal(nextCalled, true);
  }
});

test('cross-app bearer CORS stays separate and never returns credentials or wildcard', () => {
  const bearer = run('https://consumer.example');
  assert.equal(bearer.headers['access-control-allow-origin'], 'https://consumer.example');
  assert.equal(bearer.headers['access-control-allow-credentials'], undefined);
  assert.equal(bearer.headers['access-control-allow-methods'], 'GET, OPTIONS');

  const unknown = run('https://hq.example.com.evil.example');
  assert.equal(unknown.headers['access-control-allow-origin'], undefined);
  assert.equal(unknown.headers['access-control-allow-credentials'], undefined);
  assert.equal(unknown.headers.vary, 'Origin');

  const wildcard = run('https://anything.example', 'GET', { ALLOWED_ORIGINS: '*' });
  assert.equal(wildcard.headers['access-control-allow-origin'], undefined);
  assert.doesNotMatch(JSON.stringify(wildcard.headers), /\*/);
});

test('preflight is answered without trusting unconfigured origins', () => {
  const allowed = run('https://portal.example.com', 'OPTIONS');
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');

  const denied = run('https://evil.example', 'OPTIONS');
  assert.equal(denied.statusCode, 204);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  assert.equal(denied.headers['access-control-allow-credentials'], undefined);
});

test('trust proxy is explicit and never inferred from forwarded headers', () => {
  assert.equal(trustProxySetting(''), false);
  assert.equal(trustProxySetting('1'), 1);
  assert.equal(trustProxySetting('true'), 1);
  assert.deepEqual(trustProxySetting('10.0.0.1, 10.0.0.2'), ['10.0.0.1', '10.0.0.2']);
  assert.equal(trustProxySetting('bogus'), false);
});

test('server wires exact CORS and explicit trust-proxy configuration', () => {
  const root = path.join(__dirname, '../..');
  const server = readFileSync(path.join(root, 'api/src/server.js'), 'utf8');
  assert.match(server, /app\.set\('trust proxy', trustProxySetting\(process\.env\.TRUST_PROXY\)\)/);
  assert.match(server, /app\.use\(corsMiddleware\(\)\)/);
  assert.doesNotMatch(server, /allow\.includes\('\*'\)/);

  const envExample = readFileSync(path.join(root, 'api/.env.example'), 'utf8');
  for (const needle of ['PUBLIC_ORIGIN=', 'TRUST_PROXY=', 'FIRST_PARTY_ORIGINS=']) {
    assert.ok(envExample.includes(needle), `api/.env.example must document ${needle}`);
  }

  const docs = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(docs, /PUBLIC_ORIGIN/);
  assert.match(docs, /TRUST_PROXY/);
  assert.match(docs, /credentialed CORS/i);
});
