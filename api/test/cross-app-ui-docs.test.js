const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILES = [
  'web/src/tabs/Credits.jsx',
  'web/src/tabs/Messages.jsx',
];

test('cross-app UI docs show a replaceable configured token', () => {
  for (const file of FILES) {
    const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    assert.doesNotMatch(source, /OWNER_SCOPED_TOKEN/, `${file} still has a fake token placeholder`);
    assert.match(source, /Bearer REPLACE_WITH_TOKEN_A/, `${file} lacks a concrete token placeholder`);
    assert.match(source, /CROSS_APP_TOKENS_JSON/, `${file} does not explain where the token comes from`);
  }
});
