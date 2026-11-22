# Credit ledger deployment preflight (P0)

No live Supabase service was contacted while preparing this phase. The additive
migration in `supabase/migrations/20261122010000_credit_ledger.sql` is safe to
apply without converting existing values, but validation of constraints and any
backfill must wait for the read-only checks below on a production copy.

## 1. Freeze and backup

1. Take a verified database backup and record its restore point.
2. Build and stage application code that reads both legacy and typed columns,
   but do not deploy it before the migration: the new write paths use the typed
   columns unconditionally. The full order is in
   `docs/supabase-deployment-runbook.md`.
3. Apply the additive migration. Do not validate the `NOT VALID` constraints or
   enable new write paths for legacy rows until reports are clean.

## 2. Read-only data reports

Run grouped reports per `(owner_user_id, account_id)` and save the output as a
deployment artifact:

- **null owner / orphan account**: bookings with null `owner_user_id`, credits
  whose `user_id` is null, accounts whose `user_id` does not match the booking
  owner, and accounts referenced by credits with no matching account.
- **invalid date/time**: nonblank dates that are not valid dates, blank or
  malformed `start_time`, and start times outside `00:00`–`23:59`.
- **nonpositive duration / unknown status**: null, zero, negative or greater
  than 24-hour durations, and statuses outside the six documented values.
- **amount and quote anomalies**: zero or non-finite `credits.amount`, amounts
  with more than two decimal places, null `quoted_credits`, and charged bookings
  whose `credits_charged` does not equal the stored quote.
- **duplicate ledger entries**: more than one `booking_charge` or
  `booking_refund` per booking, refunds with no charge, and duplicate
  `(owner, idempotency_key)` pairs.
- **overlap**: live account overlaps and assigned-ambassador overlaps using the
  legacy midnight interpretation for null times. One-minute overlaps must be
  reported; events that merely touch are allowed.
- **balance parity**: per-account `SUM(amount)` before and after every planned
  normalization. Any unexplained difference aborts the deployment.

## 3. Quarantine rules

Do not guess when evidence conflicts:

- Quarantine bookings whose account owner disagrees with `owner_user_id`.
- Reject malformed nonblank times for manual remediation; only blank/null times
  may be interpreted as the legacy `00:00` convention and recorded in migration
  metadata.
- Do not infer a missing duration from a default. Use an owner-scoped
  `event_types.base_hours` only when it exists; otherwise quarantine.
- Associate legacy debits/refunds conservatively. Leave `entry_type='migration'`
  when more than one booking matches. Never invent a `booking_id`.
- Do not insert a debit solely to satisfy a constraint if the historical balance
  already reflects it.
- Soft-deactivate event types rather than deleting rows referenced by quotes.

## 4. Before validating constraints

1. Resolve every reported category explicitly by correcting data or cancelling
   conflicting bookings; migration order must not choose a winner.
2. Add owner-consistency unique indexes (`accounts(user_id,id)`,
   `event_types(owner_user_id,id)`, `portal_users(owner_user_id,id)`) only after
   duplicate reports are empty.
3. Validate the `NOT VALID` status, quote and ledger constraints.
4. Compare per-account balances before and after conversion; require zero
   unexplained differences.
5. Only then enable strengthened quote immutability on historical rows and run
   the concurrent booking/approval/cancellation integration suite.

## 5. Deferred database work

- **btree_gist / exclusion constraints**: not introduced by this phase. The
  extension may be unavailable or disallowed, and legacy overlap conflicts
  cannot be verified without live data. Application transactions currently use
  `pg_advisory_xact_lock` plus owner-scoped overlap queries. Adding
  `bookings_account_no_overlap` and `bookings_ambassador_no_overlap` remains
  preflight work after extension availability and conflict reports are clean.
- **Destructive conversions**: converting `credits.amount`,
  `bookings.duration_hours`, `bookings.credits_charged`, booking `date`,
  `start_time` and timestamp columns in place is deferred. This phase adds
  typed numeric shadow columns instead of rounding or coercing legacy rows.
- **Hard NOT NULL backfills**: deferred until quoted snapshots and audit fields
  are verified for every historical booking.
- **Foreign keys with RESTRICT**: deferred until owner consistency and orphan
  reports pass; historical quotes and ledger rows must survive account/event
  deactivation.

## 6. Verification

The default Node test suites run without a live database. The real-Postgres
constraint and concurrency tests in `api/test/postgres-integration.test.js`
are skipped unless `TEST_DATABASE_URL` points at a disposable database. Run
them only after application code can read the additive schema:

```sh
TEST_DATABASE_URL=postgres://… npm --prefix api test
```

Each integration test creates and drops a unique temporary schema and uses a
separate connection where concurrency is exercised.

## 7. Operational notes

Idempotency records retain response bodies and are never automatically deleted
while clients may retry. Define a retention policy only after establishing the
maximum retry horizon, preserving financial request keys. Keep the Data API
disabled for all managed tables; the server-side `DATABASE_URL` connection is
the only application writer.
