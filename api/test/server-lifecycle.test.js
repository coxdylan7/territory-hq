'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

function withoutImportListen(load) {
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function blockedListen() {
    throw new Error('app.listen() was called while importing the server module');
  };
  try {
    return load();
  } finally {
    net.Server.prototype.listen = original;
  }
}

const env = () => ({
  DATABASE_URL: 'postgres://placeholder@example.invalid/db',
  PUBLIC_ORIGIN: 'https://hq.example.com',
  TRUST_PROXY: '1',
  SKIP_SCHEMA: '1',
  PORT: '8080',
});

test('importing the HQ server builds an app but never opens a socket', () => {
  const server = withoutImportListen(() => require('../src/server'));
  assert.equal(typeof server.createApp, 'function');
  assert.equal(typeof server.getApp, 'function');
  assert.equal(typeof server.start, 'function');
  assert.equal(typeof server.getApp(), 'function', 'Express app is callable by an adapter');
  assert.equal(server.getApp(), server.getApp(), 'app is constructed once');
});

test('SKIP_SCHEMA=1 skips boot DDL and still starts on the configured port', async () => {
  const server = require('../src/server');
  const calls = [];
  const listen = (app, port) => {
    calls.push({ app, port });
    return { close() {} };
  };
  const logger = { log() {}, error() {} };

  await server.start({
    env: env(),
    listen,
    logger,
    exit: false,
    ensureSchema: async () => { throw new Error('DDL must not run with SKIP_SCHEMA=1'); },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].port, 8080);
  assert.equal(typeof calls[0].app, 'function');
});

test('without SKIP_SCHEMA the existing boot-time ensureSchema still runs first', async () => {
  const server = require('../src/server');
  const order = [];
  await server.start({
    env: { ...env(), SKIP_SCHEMA: '0' },
    listen: (_app, port) => { order.push(`listen:${port}`); },
    logger: { log() {}, error() {} },
    exit: false,
    ensureSchema: async () => { order.push('schema'); },
  });
  assert.deepEqual(order, ['schema', 'listen:8080']);
});

test('start fails closed when DATABASE_URL is absent', async () => {
  const server = require('../src/server');
  const errors = [];
  const listen = () => { throw new Error('must not listen without DATABASE_URL'); };

  await assert.rejects(() => server.start({
    env: { ...env(), DATABASE_URL: '' },
    listen,
    logger: { log() {}, error: (message) => errors.push(String(message)) },
    exit: false,
  }), /DATABASE_URL/);

  assert.match(errors.join(' '), /DATABASE_URL/);
  assert.doesNotMatch(errors.join(' '), /postgres:\/\//);
});
