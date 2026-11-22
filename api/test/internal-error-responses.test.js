const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { internalError } = require('../src/error-handler');

function repoFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

// Extract every explicit 5xx reply from both Express servers so handler-local
// catch branches are checked, not just the shared error-handler middleware.
function fiveHundredResponses(source) {
  const responses = [];
  const jsonRe = /\bjson\s*\(\s*res\s*,\s*([^;]*?),\s*(5\d{2})\s*\)/g;
  const failRe = /\bfail\s*\(\s*res\s*,\s*(5\d{2})\s*,\s*([^;]*?)\s*\)/g;
  let match;
  while ((match = jsonRe.exec(source))) {
    responses.push({ body: match[1].trim(), status: Number(match[2]) });
  }
  while ((match = failRe.exec(source))) {
    responses.push({ body: match[2].trim(), status: Number(match[1]) });
  }
  return responses;
}

test('no Express 5xx response contains runtime error details', () => {
  for (const file of ['api/src/server.js', 'portal/api/src/server.js']) {
    const responses = fiveHundredResponses(repoFile(file));
    assert.ok(responses.length > 0, `no 5xx responses found in ${file}`);

    for (const { body, status } of responses) {
      assert.equal(status, 500, `${file}: unexpected 5xx status ${status}`);

      // A helper call is allowed, but only with a fixed context label and the
      // caught error object; the helper itself is tested below.
      if (/^internalError\s*\(/.test(body)) {
        assert.match(body, /^internalError\(\s*'[^']*'\s*,\s*[A-Za-z_$][\w$]*\s*\)$/, `${file}: unsafe internalError call ${body}`);
        continue;
      }

      assert.doesNotMatch(body, /\.message\b/, `${file}: raw exception message in ${body}`);
      assert.doesNotMatch(body, /\b(?:err|e|error)\b\s*\?\./, `${file}: error value in ${body}`);
      assert.doesNotMatch(body, /\+|\$\{/, `${file}: dynamic 5xx body in ${body}`);
      assert.match(body, /^(?:\{\s*error:\s*)?'[^']*'(?:\s*\})?$/, `${file}: 5xx body must be a fixed message, got ${body}`);
    }
  }
});

test('internalError logs details server-side and sends only a generic body', () => {
  const logged = [];
  const err = new Error('database password is hunter2');
  err.stack = 'stack trace with database password is hunter2';

  const body = internalError('admin user deletion', err, { error: (...args) => logged.push(args) });

  assert.deepEqual(body, { error: 'Internal error' });
  assert.equal(logged.length, 1);
  assert.match(String(logged[0].join(' ')), /admin user deletion/);
  assert.match(String(logged[0].join(' ')), /database password is hunter2/);
});

test('specific non-sensitive validation messages are preserved', () => {
  const source = repoFile('api/src/server.js');
  for (const message of [
    'You cannot delete your own account.',
    'This is the last active admin — promote someone else first.',
    'Pick a valid staff member.',
    'A valid email is required.',
    'OCM license number is required.',
  ]) {
    assert.ok(source.includes(message), `missing validation message: ${message}`);
  }
});
