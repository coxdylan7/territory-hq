'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const root = path.join(__dirname, '..');
const HQ_URL = pathToFileURL(path.join(root, 'netlify/functions/hq-api.mjs')).href;
const PORTAL_URL = pathToFileURL(path.join(root, 'portal/netlify/functions/portal-api.mjs')).href;

const saved = {};
const KEYS = ['DATABASE_URL', 'SKIP_SCHEMA', 'PUBLIC_ORIGIN', 'FIRST_PARTY_ORIGINS', 'TRUST_PROXY', 'SERVE_WEB', 'NODE_ENV'];

test.before(async () => {
  for (const key of KEYS) saved[key] = process.env[key];
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://placeholder@example.invalid/db',
    SKIP_SCHEMA: '1',
    PUBLIC_ORIGIN: 'https://hq.example.com',
    FIRST_PARTY_ORIGINS: 'https://portal.example.com',
    TRUST_PROXY: '1',
    SERVE_WEB: 'false',
  });

  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function blockedListen() {
    throw new Error('Netlify Function import opened a listening socket');
  };
  try {
    hqHandler = (await import(HQ_URL)).default;
    portalHandler = (await import(PORTAL_URL)).default;
  } finally {
    net.Server.prototype.listen = original;
  }
});

test.after(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

let hqHandler;
let portalHandler;

const context = () => ({ requestId: 'test-request' });
function request(handler, url, options = {}) {
  return handler(new Request(url, options), context());
}
const jsonPost = (body, extraHeaders = {}) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'https://hq.example.com',
    ...extraHeaders,
  },
  body,
});

test('both function modules expose callable web handlers after import', () => {
  assert.equal(typeof hqHandler, 'function');
  assert.equal(typeof portalHandler, 'function');
});

test('health routes answer without a database and keep hardened headers', async () => {
  for (const [name, handler, service] of [
    ['HQ', hqHandler, 'hq'],
    ['Portal', portalHandler, 'portal'],
  ]) {
    const res = await request(handler, 'https://hq.example.com/api/health');
    assert.equal(res.status, 200, name);
    assert.deepEqual(await res.json(), { ok: true, service });
    assert.match(res.headers.get('content-type'), /application\/json/, name);
    assert.equal(res.headers.get('content-security-policy')?.includes("default-src 'self'"), true, name);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', name);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', name);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', name);
    assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/, name);
    assert.match(res.headers.get('permissions-policy'), /geolocation=\(\)/, name);
    assert.equal(res.headers.get('x-powered-by'), null, name);
  }
});

test('original same-origin path and rewritten function path both reach Express', async () => {
  for (const url of [
    'https://hq.example.com/api/health',
    'https://hq.example.com/.netlify/functions/hq-api/api/health',
  ]) {
    const res = await request(hqHandler, url);
    assert.equal(res.status, 200, url);
    assert.equal((await res.json()).service, 'hq');
  }
});

test('unknown /api paths return JSON 404, never the SPA shell', async () => {
  for (const [handler, url] of [
    [hqHandler, 'https://hq.example.com/api/does-not-exist'],
    [hqHandler, 'https://hq.example.com/api'],
    [portalHandler, 'https://portal.example.com/api/does-not-exist'],
    [portalHandler, 'https://portal.example.com/api'],
  ]) {
    const res = await request(handler, url);
    assert.equal(res.status, 404, url);
    assert.match(res.headers.get('content-type'), /application\/json/, url);
    assert.doesNotMatch(await res.text(), /<html|<!doctype/i, url);
  }
});

test('JSON bodies are parsed and malformed JSON is rejected before any route', async () => {
  const valid = await request(hqHandler, 'https://hq.example.com/api/health', jsonPost('{"x":1}'));
  assert.equal(valid.status, 404, 'parsed JSON reaches the API catch-all, not static fallback');

  const malformed = await request(hqHandler, 'https://hq.example.com/api/health', jsonPost('{"x":'));
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid JSON body' });
});

test('cookies are forwarded both ways without a session token in JSON', async () => {
  const hq = await request(hqHandler, 'https://hq.example.com/api/auth/logout', { method: 'POST' });
  assert.equal(hq.status, 200);
  const hqCookie = hq.headers.get('set-cookie');
  assert.match(hqCookie, /thq_session=;/);
  assert.match(hqCookie, /HttpOnly/);
  assert.match(hqCookie, /SameSite=Lax/);
  assert.doesNotMatch(await hq.text(), /session|token/i);

  const portal = await request(portalHandler, 'https://portal.example.com/api/auth/logout', {
    method: 'POST',
    headers: {
      origin: 'https://portal.example.com',
      cookie: 'tp_session=short',
    },
  });
  assert.equal(portal.status, 200);
  const portalCookie = portal.headers.get('set-cookie');
  assert.match(portalCookie, /tp_session=;/);
  assert.match(portalCookie, /HttpOnly/);
  assert.doesNotMatch(await portal.text(), /session|token/i);
});

test('CSRF rejection is preserved through the function adapter', async () => {
  const res = await request(hqHandler, 'https://hq.example.com/api/auth/logout', {
    method: 'POST',
    headers: { cookie: 'thq_session=short' },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'cross-origin request blocked' });
});

test('function adapter fails closed when required environment is absent', async () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    // A fresh wrapper reads process.env at construction time.
    const { makeLambdaHandler } = await import(pathToFileURL(path.join(root, 'netlify/lib/api-adapter.mjs')).href);
    const wrapped = makeLambdaHandler(async () => ({ statusCode: 200, body: 'should not run' }), 'hq-api');
    const res = await wrapped({ path: '/api/health', headers: {} }, context());
    assert.equal(res.statusCode, 503);
    assert.doesNotMatch(res.body, /placeholder|example\.invalid/);
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  } finally {
    process.env.DATABASE_URL = original;
  }
});
