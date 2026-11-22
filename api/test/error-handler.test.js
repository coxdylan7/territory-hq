const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeErrorHandler } = require('../src/error-handler');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    type() { return this; },
    json(body) { this.body = body; return this; },
  };
}

test('unexpected errors are logged in detail but return only a generic message', () => {
  const logged = [];
  const handler = makeErrorHandler({ error: (...args) => logged.push(args) });
  const res = fakeRes();
  const err = new Error('database password is hunter2');

  handler(err, {}, res, () => {});

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Internal error' });
  assert.equal(logged.length, 1);
  assert.match(String(logged[0].join(' ')), /database password is hunter2/);
});

test('invalid JSON bodies keep their existing 400 response', () => {
  const logged = [];
  const handler = makeErrorHandler({ error: (...args) => logged.push(args) });
  const res = fakeRes();

  handler(Object.assign(new Error('bad JSON'), { type: 'entity.parse.failed' }), {}, res, () => {});

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'invalid JSON body' });
  assert.equal(logged.length, 0);
});

test('the Express server wires the generic error handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');

  assert.match(source, /makeErrorHandler/);
  assert.doesNotMatch(source, /error:\s*\(err && err\.message\)/);
});
