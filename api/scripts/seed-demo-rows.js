// Typed row builders shared by scripts/seed-demo.js. Keeping these separate
// from the script's CLI guard lets the seed rows be unit-tested without a
// database. Quotes use the same helper as the booking API so demo fixtures
// cannot introduce null legacy quote snapshots.
'use strict';

const { computeQuote } = require('../src/booking-service');
const { money, parseLedgerAmount } = require('../src/credit-ledger');

const DEMO_ACTOR_TYPE = 'seed_demo';

function demoCreditGrant({ id, owner, account, credits, date }) {
  const amount = money(parseLedgerAmount(credits));
  return {
    id,
    user_id: owner.id,
    account_id: account.id,
    account_name: account.name,
    license_number: account.license_number || null,
    city: account.city || null,
    amount,
    amount_numeric: amount,
    note: 'Demo credit grant (TEST data)',
    date,
    entry_type: 'grant',
    booking_id: null,
    source_id: 'seed-demo',
    idempotency_key: `seed-demo:grant:${id}`,
    reverses_credit_id: null,
    actor_type: DEMO_ACTOR_TYPE,
    actor_id: owner.id,
    metadata: JSON.stringify({
      source: 'seed_demo',
      accountName: account.name,
      demo: true,
    }),
  };
}

function demoBooking({
  id,
  owner,
  account,
  eventType,
  date,
  status,
  ambassadorUserId = null,
  charged,
  notes,
  durationHours = eventType.base_hours,
  createdAt = new Date().toISOString(),
}) {
  const quote = computeQuote(eventType, durationHours);
  const chargedAmount = charged == null ? null : money(parseLedgerAmount(charged));
  return {
    id,
    owner_user_id: owner.id,
    account_id: account.id,
    account_name: account.name,
    license_number: account.license_number || null,
    event_type_id: eventType.id,
    event_type_name: eventType.name,
    date,
    start_time: '10:00',
    duration_hours: Number(money(parseLedgerAmount(durationHours))),
    duration_hours_numeric: money(parseLedgerAmount(durationHours)),
    credits_charged: chargedAmount,
    credits_charged_numeric: chargedAmount,
    status,
    ambassador_user_id: ambassadorUserId,
    notes_client: null,
    notes_admin: notes || null,
    quoted_credits: quote.quotedCredits,
    quote_base_hours: quote.baseHours,
    quote_base_credits: quote.baseCredits,
    quote_extra_hour_credits: quote.extraHourCredits,
    requested_by_portal_user_id: null,
    created_by_actor_type: DEMO_ACTOR_TYPE,
    created_by_actor_id: owner.id,
    created_at: createdAt,
    updated_at: null,
  };
}

module.exports = { demoCreditGrant, demoBooking };
