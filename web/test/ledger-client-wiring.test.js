import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('HQ financial commands use generated idempotency keys', () => {
  const actions = read('src/actions.js');
  const bookings = read('src/tabs/Bookings.jsx');
  assert.match(actions, /api\.action\('post',\s*'\/api\/credits'/);
  assert.doesNotMatch(actions, /id:\s*'cr'\s*\+\s*Date\.now\(\)/);
  for (const command of ['approve', 'decline', 'cancel', 'assign']) {
    assert.ok(bookings.includes(`api.action('put', '/api/bookings/' + bk.id + '/${command}'`));
  }
  assert.match(bookings, /ambassadorUserId: bk\.ambassadorUserId \|\| null/);
  assert.match(bookings, /notes: bk\.notes \|\| ''/);
  assert.doesNotMatch(bookings, /ambassadorUserId: approveBk/);
  assert.doesNotMatch(bookings, /notes: declineBk/);
});

test('HQ booking UI uses the immutable quote and client exposes stable error codes', () => {
  const bookings = read('src/tabs/Bookings.jsx');
  const apiClient = read('src/api.js');
  assert.match(bookings, /b\.quotedCredits/);
  assert.doesNotMatch(bookings, /creditEstimate\(/);
  assert.match(apiClient, /headers\['Idempotency-Key'\]/);
  assert.match(apiClient, /this\.code = code/);
});
