# Supabase deployment runbook (Territory HQ)

This runbook prepares and applies the staged imperative migrations in
`supabase/migrations/` without ever pasting credentials into chat, issues, shell
history, or client-side code. No production data was changed while preparing the
repository; the read-only discovery and its backup are documented below. Every
command below is run by an operator tomorrow, explicitly.

## 0. Safety rules and required environment variables

- Treat `supabase/config.toml`'s `project_id` as a protected, production-like
  reference. Never infer a target from it; always pass an explicit ref with
  `--remote=<ref>` (CLI v3), except to `supabase link`, which still takes
  `--project-ref`.
- CLI v3 is local by default: every hosted database command must use `--remote`
  (or `--remote=<ref>`). Hosted changes prompt for confirmation and default to
  No; do not pass `--yes` to skip that gate.
- Never run `supabase db push` without first running its `--dry-run` form.
- The preflight script refuses `production` entirely. Production data must be
  preflighted on a fresh disposable branch/copy, never in place.
- The verification script accepts production only with
  `--environment production --confirm-environment production`.
- `migration-preflight.js` and `post-migration-verify.js` are read-only: they
  open a `BEGIN READ ONLY` transaction and roll it back. They never apply a
  migration or write data.
- `reconcile-legacy-quotes.js` is the only repository write path. Its `dry-run`
  mode opens no connection, `review` is read-only, and `apply` requires a saved
  approved review plus the exact typed confirmation. It never reads a URL from
  the environment or command-line arguments; review/apply accept stdin only.
- Keep secrets in your secret manager or shell environment. Use variable names
  in commands, never literal values. Do not read `api/.env` in automation.

Required names (set them from the secret manager; values are intentionally not
documented):

| Name | Used for |
|------|----------|
| `DATABASE_URL` | Server-side Postgres connection for the API. Never exposed to browsers. |
| `SUPABASE_DB_PASSWORD` | Database password for `supabase link`; never pass with `--password` on a command line. |
| `SUPABASE_ACCESS_TOKEN` | Optional CLI login token; never print it. |
| `CROSS_APP_TOKENS_JSON` | Server-side opaque token → owner mapping. Denies cross-app reads when unset. |
| `PUBLIC_ORIGIN`, `FIRST_PARTY_ORIGINS`, `ALLOWED_ORIGINS` | Exact origins for cookies/CSRF and cross-app CORS. |
| `TRUST_PROXY`, `COOKIE_SECURE`, `ALLOW_LEGACY_BEARER_SESSION` | Proxy trust, secure cookies, temporary session compatibility. |
| `SKIP_SCHEMA` | Set to `1` for production after migrations are applied, so boot does not issue DDL. |
| `ADMIN_EMAIL`, `TWILIO_*`, `ANTHROPIC_API_KEY`, `PORT` | Optional application configuration. |
| `TEST_DATABASE_URL` | Optional disposable-only database for the real Postgres suite. |

## 1. Backup and restore point (before any target change)

```sh
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
supabase db dump --remote="$PRODUCTION_REF" --dry-run
supabase db dump --remote="$PRODUCTION_REF" --file "backups/${STAMP}-schema.sql"
supabase db dump --remote="$PRODUCTION_REF" --data-only --file "backups/${STAMP}-data.sql"
ls -l "backups/${STAMP}-schema.sql" "backups/${STAMP}-data.sql"
```

Record the dump filenames, project ref, and timestamp in the change ticket.
Confirm a tested restore path or PITR window before continuing. If either dump
is empty or unreadable, stop.

## 2. Disposable branch/staging database (never rehearse on production)

Create a branch with production-shaped data, then use its own ref and
connection string for every rehearsal:

```sh
supabase branches create --remote="$PRODUCTION_REF" --with-data --persistent territory-ledger-rehearsal
# Copy the new ref and its database connection string into your secret manager
# as STAGING_REF and STAGING_DB_URL. Do not echo either value.
```

Alternatives: a separately provisioned staging project or a local Docker
Postgres restored from the backup. The branch is disposed of after sign-off.

## 3. Local verification before touching any database

```sh
npm run verify
```

This runs all default Node suites, both Vite builds, the optional Postgres
suite only when `TEST_DATABASE_URL` is present, and diff checks. `npm run
check:migrations` runs the deterministic migration-order and schema/migration
parity checks alone. No database is contacted by these commands.

### Verified local rehearsal on 2026-11-22 (this workspace)

Docker commands need the host's Docker group; direct socket access was denied.
Use `newgrp docker -c '...'` for every Supabase/Docker command. No group
password, database URL, or other machine-only secret belongs in this runbook.

```sh
supabase --version
newgrp docker -c 'supabase status'
newgrp docker -c 'supabase db reset --local'
newgrp docker -c 'supabase migration list --local'
newgrp docker -c 'supabase db lint --local --fail-on error'
TEST_DATABASE_URL="$DISPOSABLE_TEST_DB_URL" npm run verify
```

Verified result: Supabase CLI `3.2.0`; a clean local reset applied all four
migrations in deterministic order; the local migration list aligned with the
repository; `db lint --local --fail-on error` was clean; and the full
`npm run verify` exited 0 with 257 executed test cases, 0 failures and 0 skips:
39 root, 160 API (including 12 real PostgreSQL cases), 15 HQ web, 17 portal
API, 14 portal web, and a second standalone 12-case PostgreSQL invocation,
plus both Vite builds and both diff checks. The application's production
runtime schema remains explicitly `public`.
Random validated schemas are used only by disposable tests; runtime protection,
function qualification and `search_path` now follow the selected schema. RLS
policies and grants were not weakened.

Local replay backups use the pattern `backups/local-rehearsal-<UTC stamp>/`.
Current Supabase CLI documentation defines
`functions.<function_name>.import_map` (default
`supabase/functions/<function_name>/deno.json`), not a top-level `[import_map]`
section. That obsolete section was removed from `supabase/config.toml` and
replaced with a pointer to the per-function key.

### Hosted preview limitation observed on 2026-11-22

Creating a hosted preview branch returned **HTTP 402** because the Supabase
organization is not on the Pro plan. Do not retry that path with the same
organization. Use a fresh local reset/replay as above, or provision a separate
staging project, then repeat sections 4-9 against that explicit target.

### Read-only production discovery already completed

A production backup was taken before discovery at
`backups/production-predeploy-<UTC stamp>/` with schema, data, roles and
`SHA256SUMS`; verify its checksums before any restore decision. Read-only
discovery found zero of the four repository migrations applied. It reported six
legacy bookings and eight credit rows: no null owners, no owner/account
mismatches, no orphan credits, and no invalid dates, times, statuses or
durations. All six bookings lack a matching owner-scoped event type. Four
bookings have a nonzero `credits_charged`; the other two must remain blocked or
receive an explicit operator mapping. No PII was queried or exposed, and no
production object or row was changed.

Legacy quote reconciliation is therefore fail-closed: charged bookings may
receive only their existing charged total with all component columns left
NULL, and no base-hours, base-credits or extra-rate value may be inferred. The
two uncharged bookings require explicit, internally consistent operator
mappings; otherwise they stay blocked and read-only.

## 4. Supabase CLI linking (explicit ref only)

```sh
supabase --version   # >= 3.2.0; v3 uses --remote for every hosted database command
supabase link --project-ref "$STAGING_REF"
```

Supply the database password through the configured environment variable or an
interactive prompt. Do not use `--password <value>`; it leaks through shell
history and process listings. Confirm the linked ref printed by the CLI matches
`STAGING_REF` before continuing.

## 5. Migration list and dry checks

```sh
supabase migration list --remote
supabase db diff --remote --schema public
supabase db push --remote --skip-vault --dry-run
```

`-f/--file` is deliberately not used with `db diff`: it would create a new
migration file. Review the printed list; it must contain, in order:

1. `20240918000000_init.sql`
2. `20240921000000_portal.sql`
3. `20261122002427_secure_public_data_api.sql`
4. `20261122010000_credit_ledger.sql`

Stop if a local migration is missing, a remote migration is newer than the
local chain, or the dry run lists an unexpected migration.

## 6. Legacy-data preflight (read-only, disposable target only)

This check inspects the quote columns added by the credit-ledger migration, so
run it **after** section 8's `db push`, not before. The ordering here is
historical; `docs/credit-ledger-deployment-preflight.md` has the correct
apply-then-inspect sequence.

Dry run first, with a non-secret placeholder:

```sh
npm run migration:preflight -- \
  --environment staging \
  --confirm-environment staging \
  --project-ref "$STAGING_REF" \
  --db-url 'postgres://<redacted>@localhost:5432/postgres' \
  --dry-run
```

Real run; pipe the URL so it never appears in arguments or history:

```sh
printf '%s' "$STAGING_DB_URL" | npm run migration:preflight -- \
  --environment staging \
  --confirm-environment staging \
  --project-ref "$STAGING_REF" \
  --db-url-stdin
```

The script reports null/orphan owners, invalid dates/times, bad durations and
statuses, zero or sub-cent amounts, null quotes, charged/quote mismatches,
duplicate ledger entries, missing charges, duplicate idempotency keys,
one-minute overlaps, and a per-account balance baseline. It exits non-zero on
any anomaly. Resolve findings with the rules in
`docs/credit-ledger-deployment-preflight.md`; do not guess, invent booking ids,
or insert compensating debits. Record the balance baseline as an artifact.

## 7. TEST_DATABASE_URL integration suite (disposable database only)

The real Postgres tests create and drop uniquely named temporary schemas with
`CASCADE`; point them only at a disposable database:

```sh
TEST_DATABASE_URL="$DISPOSABLE_TEST_DB_URL" npm --prefix api test
TEST_DATABASE_URL="$DISPOSABLE_TEST_DB_URL" npm run test:postgres
```

They cover overlap edges, quote backfill immutability, refund identity,
trigger reruns, rollback retry, invite isolation, and audited ambassador
removal. Without `TEST_DATABASE_URL` these tests skip; a skipped suite is not
evidence that the staging rehearsal passed. Docker-enabled CI can additionally
run `supabase start && supabase db reset --local` for a full local migration
replay.

## 8. db push and advisors (staging first)

```sh
supabase db push --remote --skip-vault --dry-run
supabase db push --remote --skip-vault
supabase db advisors --remote --type all --level warn --fail-on error
supabase db lint --remote --fail-on error
```

Do not add `--yes`: CLI v3 prompts before changing a hosted project and defaults
to No, so the apply step still requires a human confirmation. Advisors and
lint must be clean (or every finding explicitly accepted in the ticket) before
the staging sign-off.

### 8a. Fail-closed legacy quote reconciliation

After the staged migration is present on the disposable target, create a
version-1 plan naming exactly four charged bookings and accounting for both
uncharged bookings via `mappings` or `blockedBookings`. Use IDs from the
read-only review artifact, never invented values.

Gate 1 — validate the plan only; no connection is opened:

```sh
node scripts/reconcile-legacy-quotes.js dry-run \
  --environment staging \
  --confirm-environment staging \
  --project-ref "$STAGING_REF" \
  --plan "$RECONCILIATION_PLAN"
```

Gate 2 — read-only review. The script derives charged totals only from each
booking's existing charged amount and writes a pending review file:

```sh
printf '%s' "$STAGING_DB_URL" | node scripts/reconcile-legacy-quotes.js review \
  --environment staging \
  --confirm-environment staging \
  --project-ref "$STAGING_REF" \
  --plan "$RECONCILIATION_PLAN" \
  --db-url-stdin \
  --review-out "$REVIEW_FILE"
```

A named operator records approver, change ticket and timestamp in the review
file, with `status: "approved"`. Any later edit to the plan, target or reviewed
rows invalidates its snapshot hash. Gate 3 requires that approval and an exact
typed confirmation; blocked rows produce no write:

```sh
printf '%s' "$STAGING_DB_URL" | node scripts/reconcile-legacy-quotes.js apply \
  --environment staging \
  --confirm-environment staging \
  --project-ref "$STAGING_REF" \
  --plan "$RECONCILIATION_PLAN" \
  --db-url-stdin \
  --review-file "$REVIEW_FILE" \
  --confirm-apply APPLY-LEGACY-QUOTE-RECONCILIATION
```

Do not pass `--db-url`; it is rejected. The apply transaction uses only the
allowlisted `fill_legacy_booking_total` and reviewed
`fill_legacy_booking_quote` helpers, rolls back if any result is false, and
never fabricates quote components. No production reconciliation was executed
while preparing this repository.

## 9. Verification queries (read-only)

Primary check:

```sh
printf '%s' "$STAGING_DB_URL" | npm run migration:verify -- \
  --environment staging \
  --confirm-environment staging \
  --project-ref "$STAGING_REF" \
  --db-url-stdin
```

Manual spot checks using the CLI (no secrets in the SQL):

```sh
supabase db query --remote --read-only "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version"
supabase db query --remote --read-only "SELECT conname, convalidated FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND (conname LIKE '%credit%' OR conname LIKE 'bookings_%') ORDER BY conname"
supabase db query --remote --read-only "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname"
supabase db query --remote --read-only "SELECT count(*) AS events FROM public.booking_events"
supabase db query --remote --read-only "SELECT count(*) AS replay_records FROM public.api_idempotency"
```

`NOT VALID` is expected in this phase and is reported as deferred validation.
After a clean legacy preflight and explicit reconciliation, constraints may be
validated with `VALIDATE CONSTRAINT` only through a reviewed follow-up
migration. On staging, the verification script can be made stricter with
`--require-validated-constraints` once that migration exists.

## 10. Application rollout order

1. Keep the old application running while migrations are applied; the migration
   is additive and backward compatible for reads. Do not deploy the new
   application before the migration: its ledger writes use the typed columns
   unconditionally.
2. Build artifacts with `npm run build:all`.
3. Deploy the new API images with the required environment variables set from
   the secret manager. Set `SKIP_SCHEMA=1` in production so boot does not issue
   DDL. Do not expose `DATABASE_URL` to the web or portal bundles.
4. Deploy the web and portal static builds; configure exact
   `PUBLIC_ORIGIN`/`FIRST_PARTY_ORIGINS`/`ALLOWED_ORIGINS` on both APIs.
5. Run the smoke tests in section 12 before enabling the new client rollout.
6. Only after staging passes, link the production ref explicitly, repeat
   sections 1, 5, 6 (on a fresh production copy), 7, and 8 against production,
   then run production verification with the explicit confirmation flags.

## 11. Rollback and restore decision points

- **Before `db push`:** any failed preflight, dry check, advisor, or integration
  suite stops the deployment. No rollback is needed.
- **After `db push`, before application rollout:** the old application still
  works with the additive schema. If verification fails, do not deploy the new
  app. Prefer restoring the disposable branch; on production, use the verified
  dump/PITR restore point. A compensating migration is not provided.
- **After application rollout:** roll the application back first if HTTP or UI
  smoke tests fail; the database changes remain backward compatible. Restore
  the database only for proven data corruption, balance drift, or unauthorized
  Data API exposure. Preserve ledger and idempotency records as evidence.
- **Never** delete ledger rows, idempotency records, or audit events to make a
  check pass. Never run the integration suite against production.

## 12. Post-deploy smoke tests

Run after each rollout and record results in the change ticket:

1. `GET /api/health` returns 200 on both APIs; TLS and `PUBLIC_ORIGIN` are
   correct. On Netlify hosting, follow `docs/netlify-deployment.md` for the
   two-site build settings, environment gates, and cutover blocker.
2. Sign in to HQ and the portal; confirm `thq_session` and `tp_session` are
   HttpOnly, `Secure` in production, and absent from browser storage.
3. Create a credit grant; read the balance before and after and confirm the
   delta equals the grant (legacy and numeric views agree).
4. Create, approve, confirm and cancel a booking; verify one charge and one
   exact-inverse refund, plus `booking_events` audit rows.
5. Retry the same approval with the same idempotency key; confirm a single
   charge and a replayed response.
6. Activate a portal invite and read owner-scoped cross-app data with the
   configured opaque token; a wrong owner must return 404/403.
7. Confirm Data API access is denied: an anonymous REST request to
   `/rest/v1/credits` with the publishable key must not return rows.
8. Re-run the verification script from section 9 with the target's own
   explicit environment and project inputs.
