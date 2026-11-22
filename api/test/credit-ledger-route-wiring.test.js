const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function repoFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

const hq = repoFile('api/src/server.js');
const portal = repoFile('portal/api/src/server.js');

test('HQ financial and booking commands delegate to shared services', () => {
  assert.match(hq, /require\('\.\/idempotency'\)/);
  assert.match(hq, /require\('\.\/credit-ledger'\)/);
  assert.match(hq, /require\('\.\/booking-service'\)/);
  for (const call of [
    'adjustCredits(', 'approveBooking(', 'cancelBooking(',
    'declineBooking(', 'assignBooking(',
  ]) {
    assert.ok(hq.includes(call), `HQ server is missing ${call}`);
  }
  assert.match(hq, /readIdempotencyKey\(req\)/);
  assert.match(hq, /canonicalRequestHash\(/);
  assert.match(hq, /Idempotency-Replayed/);
  assert.match(hq, /errorBody\(/);
});

test('HQ no longer recomputes prices or writes ledger rows directly', () => {
  assert.doesNotMatch(hq, /creditEstimate\(et, row\.duration_hours\)/);
  assert.doesNotMatch(hq, /'cr' \+ Date\.now\(\)/);
  assert.doesNotMatch(hq, /INSERT INTO credits/);
  assert.doesNotMatch(hq, /SELECT \* FROM bookings WHERE id = \$\{req\.params\.id\}[\s\S]{0,80}bookingView/);
});

test('HQ reads and event-type deletion are owner-scoped and soft', () => {
  assert.match(hq, /bookingAmbMap[\s\S]{0,400}owner_user_id/);
  assert.match(hq, /UPDATE event_types SET active = 0/);
  assert.match(hq, /EVENT_TYPE_IN_USE/);
  assert.match(hq, /bookingView: [A-Za-z_$]/);
});

test('Portal booking commands delegate to the same shared services', () => {
  assert.match(portal, /require\('\.\.\/\.\.\/\.\.\/api\/src\/idempotency'\)/);
  assert.match(portal, /require\('\.\.\/\.\.\/\.\.\/api\/src\/booking-service'\)/);
  for (const call of [
    'createBooking(', 'cancelBooking(', 'acceptBooking(',
    'declineAssignmentBooking(', 'completeBooking(',
  ]) {
    assert.ok(portal.includes(call), `Portal server is missing ${call}`);
  }
  assert.match(portal, /readIdempotencyKey\(req\)/);
  assert.match(portal, /canonicalRequestHash\(/);
  assert.match(portal, /Idempotency-Replayed/);
});

test('Portal queries and routes enforce owner scope and the documented state machine', () => {
  assert.match(portal, /WHERE b\.owner_user_id = \$\{u\.owner_user_id\}[\s\S]{0,200}AND b\.account_id = \$\{u\.account_id\}/);
  assert.match(portal, /WHERE b\.owner_user_id = \$\{u\.owner_user_id\}[\s\S]{0,200}AND b\.ambassador_user_id = \$\{u\.id\}/);
  assert.match(portal, /LEFT JOIN portal_users p ON p\.id = b\.ambassador_user_id[\s\S]{0,120}p\.owner_user_id/);
  assert.match(portal, /LEFT JOIN accounts a ON a\.id = b\.account_id[\s\S]{0,120}a\.user_id/);
  assert.match(portal, /AND user_id = \$\{u\.owner_user_id\}/);
  assert.doesNotMatch(portal, /status IN \('approved', 'confirmed'\)[\s\S]{0,120}complete failed/);
  assert.doesNotMatch(portal, /'cr' \+ Date\.now\(\)/);
  assert.doesNotMatch(portal, /INSERT INTO bookings/);
});
