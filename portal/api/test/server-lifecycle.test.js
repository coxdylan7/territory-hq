'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

function withoutImportListen(load) {
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function blockedListen() {
    throw new Error('app.listen() was called while importing the portal server module');
  };
  try {
    return load();
  } finally {
    net.Server.prototype.listen = original;
  }
}

test('importing the portal server builds an app but never opens a socket', () => {
  const server = withoutImportListen(() => require('../src/server'));
  assert.equal(typeof server.createApp, 'function');
  assert.equal(typeof server.getApp, 'function');
  assert.equal(typeof server.start, 'function');
  assert.equal(typeof server.getApp(), 'function');
  assert.equal(server.getApp(), server.getApp(), 'app is constructed once');
});

test('portal start uses port 8081 by default and can be overridden', async () => {
  const server = require('../src/server');
  const ports = [];
  const env = { DATABASE_URL: 'postgres://placeholder@example.invalid/db' };

  await server.start({
    env,
    listen: (_app, port) => { ports.push(port); },
    logger: { log() {}, error() {} },
    exit: false,
  });
  await server.start({
    env: { ...env, PORT: '9091' },
    listen: (_app, port) => { ports.push(port); },
    logger: { log() {}, error() {} },
    exit: false,
  });

  assert.deepEqual(ports, [8081, 9091]);
});

test('portal start fails closed when DATABASE_URL is absent', async () => {
  const server = require('../src/server');
  const errors = [];
  await assert.rejects(() => server.start({
    env: {},
    listen: () => { throw new Error('must not listen without DATABASE_URL'); },
    logger: { log() {}, error: (message) => errors.push(String(message)) },
    exit: false,
  }), /DATABASE_URL/);
  assert.match(errors.join(' '), /DATABASE_URL/);
  assert.doesNotMatch(errors.join(' '), /postgres:\/\//);
});
