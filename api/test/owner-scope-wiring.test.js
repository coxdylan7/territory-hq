'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function repoFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

const hq = repoFile('api/src/server.js');
const portal = repoFile('portal/api/src/server.js');

test('HQ owner-scoped commands verify affected rows', () => {
  for (const pattern of [
    /app\.put\('\/api\/event-types\/:id'[\s\S]{0,500}RETURNING id[\s\S]{0,200}404/,
    /app\.put\('\/api\/portal-users\/:id\/status'[\s\S]{0,400}RETURNING id[\s\S]{0,200}404/,
    /app\.delete\('\/api\/portal-invites\/:id'[\s\S]{0,300}RETURNING id[\s\S]{0,200}404/,
    /app\.put\('\/api\/portal-users\/:id\/account'[\s\S]{0,700}RETURNING id[\s\S]{0,200}404/,
  ]) {
    assert.match(hq, pattern);
  }
});

test('HQ portal-user deletion uses the owner-scoped audited booking command', () => {
  const route = hq.slice(
    hq.indexOf("app.delete('/api/portal-users/:id'"),
    hq.indexOf("app.put('/api/portal-users/:id/account'")
  );
  assert.match(route, /SELECT id FROM portal_users[\s\S]{0,160}owner_user_id/);
  assert.match(route, /PORTAL_USER_NOT_FOUND[\s\S]{0,40}404/);
  assert.match(route, /removePortalUsersBookings\(tx, \{[\s\S]{0,240}ownerUserId: user\.id[\s\S]{0,160}portalUserIds: \[req\.params\.id\]/);
  assert.doesNotMatch(route, /UPDATE bookings SET ambassador_user_id = NULL/);

  const service = repoFile('api/src/booking-service.js');
  assert.match(service, /DELETE FROM portal_users[\s\S]{0,160}owner_user_id/);
});

test('Portal owner and account joins are owner scoped', () => {
  const accountLookup = portal.slice(
    portal.indexOf('async function gate('),
    portal.indexOf("app.get('/api/event-types'")
  );
  assert.match(accountLookup, /accounts WHERE id = \$\{u\.account_id\} AND user_id = \$\{u\.owner_user_id\}/);
  assert.doesNotMatch(hq, /SELECT \* FROM bookings WHERE id = \$\{req\.params\.id\}\)\[0\]/);
});
