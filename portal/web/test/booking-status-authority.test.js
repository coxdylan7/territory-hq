import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('portal treats server status as authoritative and never fabricates completion', () => {
  const app = read('src/App.jsx');
  assert.doesNotMatch(app, /status:\s*'completed'/);
  assert.doesNotMatch(app, /b\.date\s*<\s*today\s*\?\s*\{\s*\.\.\.b/);
  assert.doesNotMatch(app, /<span className="pill completed">Completed<\/span>/);
  assert.match(app, /STATUS_LABEL\[b\.status\]/);
});

test('completion stays an ambassador command backed by an audited server transition', () => {
  const store = read('src/store.js');
  const app = read('src/App.jsx');
  const portalServer = read('../api/src/server.js');
  const bookingService = read('../../api/src/booking-service.js');

  assert.match(store, /api\.action\('put', '\/api\/bookings\/' \+ id \+ '\/complete'/);
  assert.match(app, /st\.completeBooking\(b\.id\)/);
  assert.match(portalServer, /app\.put\('\/api\/bookings\/:id\/complete', gate/);
  assert.match(bookingService, /action: 'completed'/);
});
