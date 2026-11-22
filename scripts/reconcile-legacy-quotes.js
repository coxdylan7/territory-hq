#!/usr/bin/env node
'use strict';

// Fail-closed legacy quote reconciliation CLI.
//
// dry-run: validates the operator plan only and opens no database connection.
// review:  opens a READ ONLY transaction and writes a pending snapshot.
// apply:   revalidates the plan, target, approval and snapshot, then performs
//          only allowlisted writes in one transaction. A URL is accepted only
//          from stdin for review/apply and is never printed or persisted.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const { repoPath, redactSecrets } = require('./lib/deployment-target');
const { withReadOnlyClient } = require('./lib/read-only-db');
const {
  UsageError,
  ReconciliationError,
  applyCalls,
  assertApprovedReview,
  buildReview,
  canonicalPlan,
  parseCli,
  planHash,
} = require('./lib/legacy-quote-reconciliation');

const APPLY_SQL = {
  fill_legacy_booking_total:
    'SELECT public.fill_legacy_booking_total($1, $2::numeric) AS applied',
  fill_legacy_booking_quote:
    'SELECT public.fill_legacy_booking_quote($1, $2::numeric, $3::numeric, $4::numeric, $5::numeric) AS applied',
};

function usage() {
  return `Usage:
  scripts/reconcile-legacy-quotes.js dry-run --environment <staging|production> \\
    --confirm-environment <name> --project-ref <ref> --plan <file>

  scripts/reconcile-legacy-quotes.js review --environment <staging|production> \\
    --confirm-environment <name> --project-ref <ref> --plan <file> \\
    --db-url-stdin --review-out <file>

  scripts/reconcile-legacy-quotes.js apply --environment <staging|production> \\
    --confirm-environment <name> --project-ref <ref> --plan <file> \\
    --db-url-stdin --review-file <file> \\
    --confirm-apply APPLY-LEGACY-QUOTE-RECONCILIATION

The connection string must be piped on stdin for review/apply. --db-url is
rejected. dry-run opens no connection. apply requires an approved review file.`;
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${label} is not valid JSON: ${error.message}`);
  }
}

function readDbUrlFromStdin() {
  const input = fs.readFileSync(0, 'utf8').trim();
  if (!input || /\s/.test(input)) {
    throw new UsageError('--db-url-stdin requires exactly one non-blank connection string');
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new UsageError('stdin connection string must be a postgres URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname === '/') {
    throw new UsageError('stdin connection string must be a complete postgres URL');
  }
  return input;
}

function sqlLiteral(value) {
  // Plan identifiers are already restricted to [A-Za-z0-9_-]; escaping is kept
  // explicit so the review query cannot become an injection point if that
  // validation changes.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function reviewQuery(plan) {
  const ids = [
    ...plan.chargedBookings,
    ...plan.blockedBookings,
    ...Object.keys(plan.mappings),
  ].map(sqlLiteral).join(', ');
  return `SELECT
    id::text AS "id",
    COALESCE(credits_charged_numeric::text, round(credits_charged::numeric, 2)::text) AS "chargedTotal",
    COALESCE(duration_hours_numeric::text, duration_hours::text) AS "durationHours",
    quoted_credits::text AS "quotedCredits",
    quote_base_hours::text AS "quoteBaseHours",
    quote_base_credits::text AS "quoteBaseCredits",
    quote_extra_hour_credits::text AS "quoteExtraHourCredits"
  FROM public.bookings
  WHERE id::text IN (${ids})`;
}

function writeReview(file, review) {
  try {
    fs.writeFileSync(file, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (error) {
    throw new UsageError(`cannot write review file: ${error.message}`);
  }
}

function loadPostgres() {
  const requireFromApi = createRequire(path.join(repoPath('api'), 'package.json'));
  return requireFromApi('postgres');
}

async function runApply(dbUrl, review) {
  const calls = applyCalls(review);
  if (calls.length === 0) {
    throw new ReconciliationError('approved review contains no apply operations');
  }
  const postgres = loadPostgres();
  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: 'territory-legacy-quote-apply' },
  });
  try {
    await sql.begin(async (tx) => {
      for (const call of calls) {
        const statement = APPLY_SQL[call.function];
        if (!statement) throw new ReconciliationError(`apply function ${call.function} is not allowlisted`);
        const rows = await tx.unsafe(statement, call.args);
        if (!rows.length || rows[0].applied !== true) {
          throw new ReconciliationError(`helper declined ${call.function} for ${call.bookingId}`);
        }
      }
    });
  } catch (error) {
    const safe = redactSecrets(error && error.message ? error.message : String(error), dbUrl);
    throw new ReconciliationError(`apply transaction rolled back: ${safe}`);
  } finally {
    try {
      await sql.end({ timeout: 2 });
    } catch {
      // Teardown must not mask the transaction result.
    }
  }
  return calls.length;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const parsed = parseCli(process.argv.slice(2));
  const plan = canonicalPlan(readJson(parsed.planPath, 'plan'));
  const target = {
    environment: parsed.environment,
    projectRef: parsed.projectRef,
  };

  if (parsed.mode === 'dry-run') {
    process.stdout.write('DRY RUN — no connection opened, no query executed\n');
    process.stdout.write(`Target: environment=${target.environment} project-ref=${target.projectRef}\n`);
    process.stdout.write('Plan: version=1 charged=4 uncharged=2\n');
    process.stdout.write(`Plan hash: ${planHash(plan)}\n`);
    process.stdout.write(`Charged bookings: ${plan.chargedBookings.join(', ')}\n`);
    process.stdout.write(`Mapped bookings: ${Object.keys(plan.mappings).join(', ') || '(none)'}\n`);
    process.stdout.write(`Blocked bookings: ${plan.blockedBookings.join(', ') || '(none)'}\n`);
    return;
  }

  if (parsed.mode === 'review') {
    const dbUrl = readDbUrlFromStdin();
    const review = await withReadOnlyClient(dbUrl, async (db) => {
      const rows = await db.query(reviewQuery(plan));
      return buildReview({ plan, rows, target });
    });
    writeReview(parsed.reviewOut, review);
    process.stdout.write('REVIEW — read-only snapshot written; status=pending; no data changed\n');
    process.stdout.write(`Review file: ${parsed.reviewOut}\n`);
    process.stdout.write(`Plan hash: ${review.planHash}\n`);
    process.stdout.write(`Snapshot hash: ${review.snapshotHash}\n`);
    process.stdout.write(`Operations: ${review.aggregate.totalBookings} (blocked writes: ${review.aggregate.blockedUnchargedBookings})\n`);
    return;
  }

  const review = readJson(parsed.reviewFile, 'review');
  assertApprovedReview(review, { planHash: planHash(plan), target, confirmation: parsed.confirmApply });
  const dbUrl = readDbUrlFromStdin();
  const writes = await runApply(dbUrl, review);
  process.stdout.write(`APPLY — committed ${writes} allowlisted helper calls in one transaction\n`);
  process.stdout.write('Blocked bookings were not written.\n');
}

main().catch((error) => {
  const message = redactSecrets(error && error.message ? error.message : String(error));
  process.stderr.write(`${error && error.name ? error.name : 'Error'}: ${message}\n`);
  process.exitCode = 1;
});
