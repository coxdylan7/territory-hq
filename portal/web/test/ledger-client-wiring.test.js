import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Portal booking commands use generated idempotency keys', () => {
  const store = read('src/store.js');
  for (const command of [
    "api.action('post', '/api/bookings'",
    "api.action('put', '/api/bookings/' + id + '/cancel'",
    "api.action('put', '/api/bookings/' + id + '/accept'",
    "api.action('put', '/api/bookings/' + id + '/decline-assignment'",
    "api.action('put', '/api/bookings/' + id + '/complete'",
  ]) {
    assert.ok(store.includes(command), `portal store is missing ${command}`);
  }
});

test('Portal booking UI uses quotes, requires a start time, and exposes stable codes', () => {
  const app = read('src/App.jsx');
  const apiClient = read('src/api.js');
  assert.match(app, /b\.quotedCredits/);
  assert.doesNotMatch(app, /startTime:\s*startTime \|\| null/);
  assert.match(app, /Start time is required/);
  assert.match(apiClient, /headers\['Idempotency-Key'\]/);
  assert.match(apiClient, /this\.code = code/);
});
