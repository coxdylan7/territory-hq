'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const reconciliation = require(path.join(root, 'scripts/lib/legacy-quote-reconciliation'));
const scriptPath = path.join(root, 'scripts/reconcile-legacy-quotes.js');

const BASE_PLAN = {
  version: 1,
  chargedBookings: ['bk-charged-1', 'bk-charged-2', 'bk-charged-3', 'bk-charged-4'],
  blockedBookings: ['bk-blocked-1', 'bk-blocked-2'],
  mappings: {},
};

function rows() {
  return [
    ['bk-charged-1', '40.00', '4.00'],
    ['bk-charged-2', '32.50', '4.00'],
    ['bk-charged-3', '18.00', '3.00'],
    ['bk-charged-4', '52.00', '5.00'],
    ['bk-blocked-1', null, '6.00'],
    ['bk-blocked-2', null, '4.00'],
  ].map(([id, chargedTotal, durationHours]) => ({
    id,
    chargedTotal,
    durationHours,
    quotedCredits: null,
    quoteBaseHours: null,
    quoteBaseCredits: null,
    quoteExtraHourCredits: null,
  }));
}

const TARGET = { environment: 'staging', projectRef: 'abcdefghijklmnopqrst' };

test('legacy plan rejects missing, duplicate, overlapping or extra booking identifiers', () => {
  assert.throws(() => reconciliation.canonicalPlan({ ...BASE_PLAN, chargedBookings: [] }), /four charged/i);
  assert.throws(() => reconciliation.canonicalPlan({
    ...BASE_PLAN,
    chargedBookings: ['bk-charged-1', 'bk-charged-1', 'bk-charged-2', 'bk-charged-3'],
  }), /unique/i);
  assert.throws(() => reconciliation.canonicalPlan({
    ...BASE_PLAN,
    blockedBookings: ['bk-charged-1', 'bk-blocked-2'],
  }), /overlap/i);
  assert.throws(() => reconciliation.canonicalPlan({
    ...BASE_PLAN,
    mappings: { 'bk-charged-1': { baseHours: '4', baseCredits: '40', extraHourCredits: '0', expectedTotal: '40' } },
  }), /charged/i);
  assert.throws(() => reconciliation.canonicalPlan({
    ...BASE_PLAN,
    blockedBookings: ['bk-blocked-1'],
  }), /two uncharged/i);
});

test('an uncharged mapping must be explicit and internally consistent', () => {
  const plan = reconciliation.canonicalPlan({
    ...BASE_PLAN,
    blockedBookings: ['bk-blocked-2'],
    mappings: {
      'bk-blocked-1': {
        durationHours: '6.00',
        baseHours: '4.00',
        baseCredits: '40.00',
        extraHourCredits: '10.00',
        expectedTotal: '60.00',
      },
    },
  });
  assert.equal(plan.mappings['bk-blocked-1'].baseHours, '4.00');

  assert.throws(() => reconciliation.canonicalPlan({
    ...BASE_PLAN,
    blockedBookings: ['bk-blocked-2'],
    mappings: {
      'bk-blocked-1': {
        durationHours: '6.00',
        baseHours: '4.00',
        baseCredits: '40.00',
        extraHourCredits: '10.00',
        expectedTotal: '40.00',
      },
    },
  }), /total/i);

  assert.throws(() => reconciliation.canonicalPlan({
    ...BASE_PLAN,
    blockedBookings: ['bk-blocked-2'],
    mappings: {
      'bk-blocked-1': {
        durationHours: '6.00',
        baseHours: '4.00',
        baseCredits: '40.00',
        extraHourCredits: '10.00',
      },
    },
  }), /expectedTotal/i);
});

test('review derives charged totals only from the charged amount and never invents components', () => {
  const review = reconciliation.buildReview({
    plan: reconciliation.canonicalPlan(BASE_PLAN),
    rows: rows(),
    target: TARGET,
  });
  assert.equal(review.aggregate.chargedBookings, 4);
  assert.equal(review.aggregate.blockedUnchargedBookings, 2);
  assert.deepEqual(review.operations.filter((op) => op.kind === 'charged-total').map((op) => op.currentTotal),
    ['40.00', '32.50', '18.00', '52.00']);
  for (const op of review.operations.filter((op) => op.kind === 'charged-total')) {
    assert.equal(op.componentColumns, null);
  }
  assert.deepEqual(review.operations.filter((op) => op.kind === 'blocked').map((op) => op.bookingId),
    ['bk-blocked-1', 'bk-blocked-2']);
  assert.equal(review.status, 'pending');
});

test('review fails closed on charged drift, prefilled quotes or mapping mismatch', () => {
  const plan = reconciliation.canonicalPlan(BASE_PLAN);
  const missing = rows().slice(1);
  assert.throws(() => reconciliation.buildReview({ plan, rows: missing, target: TARGET }), /missing booking/i);

  const prefilled = rows();
  prefilled[0].quotedCredits = '40.00';
  assert.throws(() => reconciliation.buildReview({ plan, rows: prefilled, target: TARGET }), /already/i);

  const mapped = reconciliation.canonicalPlan({
    ...BASE_PLAN,
    blockedBookings: ['bk-blocked-2'],
    mappings: {
      'bk-blocked-1': {
        durationHours: '6.00',
        baseHours: '4.00',
        baseCredits: '40.00',
        extraHourCredits: '10.00',
        expectedTotal: '60.00',
      },
    },
  });
  const drifted = rows();
  drifted.find((row) => row.id === 'bk-blocked-1').durationHours = '4.00';
  assert.throws(() => reconciliation.buildReview({ plan: mapped, rows: drifted, target: TARGET }), /duration/i);
});

test('plan hash covers nested operator mapping values', () => {
  const mappingPlan = (baseCredits, extraHourCredits, expectedTotal) => reconciliation.canonicalPlan({
    ...BASE_PLAN,
    blockedBookings: ['bk-blocked-2'],
    mappings: {
      'bk-blocked-1': {
        durationHours: '6.00',
        baseHours: '4.00',
        baseCredits,
        extraHourCredits,
        expectedTotal,
      },
    },
  });
  const original = mappingPlan('40.00', '10.00', '60.00');
  const changed = mappingPlan('1000.00', '100.00', '1200.00');
  assert.notEqual(reconciliation.planHash(original), reconciliation.planHash(changed));
});

test('snapshot hash covers reviewed rows and target', () => {
  const plan = reconciliation.canonicalPlan({
    ...BASE_PLAN,
    blockedBookings: ['bk-blocked-2'],
    mappings: {
      'bk-blocked-1': {
        durationHours: '6.00',
        baseHours: '4.00',
        baseCredits: '40.00',
        extraHourCredits: '10.00',
        expectedTotal: '60.00',
      },
    },
  });
  const review = reconciliation.buildReview({ plan, rows: rows(), target: TARGET });
  const approved = {
    ...review,
    status: 'approved',
    approval: {
      approver: 'operator@example.test',
      changeTicket: 'CHG-1234',
      approvedAt: '2026-11-22T04:00:00Z',
    },
  };
  const tampered = {
    ...approved,
    operations: approved.operations.map((op) => op.kind === 'full-mapping'
      ? { ...op, quotedCredits: '1200.00', baseCredits: '1000.00', extraHourCredits: '100.00' }
      : op),
  };
  assert.notEqual(reconciliation.snapshotHash(tampered), approved.snapshotHash);
  assert.throws(() => reconciliation.assertApprovedReview(tampered, {
    planHash: review.planHash,
    target: TARGET,
    confirmation: 'APPLY-LEGACY-QUOTE-RECONCILIATION',
  }), /snapshot/i);
  assert.notEqual(reconciliation.snapshotHash({
    ...approved,
    target: { ...TARGET, projectRef: 'abcdefghijklmnopqrsu' },
  }), approved.snapshotHash);
});

test('apply requires an approved, untampered review and a typed confirmation', () => {
  const review = reconciliation.buildReview({
    plan: reconciliation.canonicalPlan(BASE_PLAN),
    rows: rows(),
    target: TARGET,
  });
  assert.throws(() => reconciliation.assertApprovedReview(review, {
    planHash: review.planHash,
    target: TARGET,
    confirmation: 'APPLY-LEGACY-QUOTE-RECONCILIATION',
  }), /approved/i);

  const approved = {
    ...review,
    status: 'approved',
    approval: {
      approver: 'operator@example.test',
      changeTicket: 'CHG-1234',
      approvedAt: '2026-11-22T04:00:00Z',
    },
  };
  reconciliation.assertApprovedReview(approved, {
    planHash: review.planHash,
    target: TARGET,
    confirmation: 'APPLY-LEGACY-QUOTE-RECONCILIATION',
  });

  assert.throws(() => reconciliation.assertApprovedReview({ ...approved, operations: [] }, {
    planHash: review.planHash,
    target: TARGET,
    confirmation: 'APPLY-LEGACY-QUOTE-RECONCILIATION',
  }), /snapshot/i);
  assert.throws(() => reconciliation.assertApprovedReview(approved, {
    planHash: 'tampered',
    target: TARGET,
    confirmation: 'APPLY-LEGACY-QUOTE-RECONCILIATION',
  }), /plan/i);
  assert.throws(() => reconciliation.assertApprovedReview(approved, {
    planHash: review.planHash,
    target: TARGET,
    confirmation: 'yes',
  }), /confirm/i);
});

test('apply statements use only allowlisted helpers and produce no write for blocked rows', () => {
  const review = reconciliation.buildReview({
    plan: reconciliation.canonicalPlan(BASE_PLAN),
    rows: rows(),
    target: TARGET,
  });
  const calls = reconciliation.applyCalls(review);
  assert.equal(calls.length, 4);
  assert.deepEqual([...new Set(calls.map((call) => call.function))], ['fill_legacy_booking_total']);
  for (const call of calls) {
    assert.equal(call.args.length, 2);
    assert.match(call.bookingId, /^bk-[a-z0-9-]+$/);
  }
  assert.equal(reconciliation.applyCalls(review).filter((call) => call.function === 'fill_legacy_booking_quote').length, 0);
});

test('CLI separates dry-run, review and apply gates and never accepts --db-url', () => {
  const common = [
    '--environment', 'staging', '--confirm-environment', 'staging',
    '--project-ref', 'abcdefghijklmnopqrst', '--plan', 'plan.json',
  ];
  const dry = reconciliation.parseCli(['dry-run', ...common]);
  assert.equal(dry.dbUrl, null);
  const review = reconciliation.parseCli(['review', ...common, '--db-url-stdin', '--review-out', 'review.json']);
  assert.equal(review.dbUrlFromStdin, true);
  const apply = reconciliation.parseCli([
    'apply', ...common, '--db-url-stdin', '--review-file', 'review.json',
    '--confirm-apply', 'APPLY-LEGACY-QUOTE-RECONCILIATION',
  ]);
  assert.equal(apply.confirmApply, 'APPLY-LEGACY-QUOTE-RECONCILIATION');
  assert.throws(() => reconciliation.parseCli(['dry-run', ...common, '--db-url', 'postgres://u:p@example.test/db']), /db-url/i);
  assert.throws(() => reconciliation.parseCli(['review', ...common, '--db-url-stdin']), /review-out/i);
  assert.throws(() => reconciliation.parseCli(['apply', ...common, '--db-url-stdin', '--review-file', 'review.json']), /confirm-apply/i);
});

test('dry-run CLI validates a plan without opening a database connection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'territory-reconcile-'));
  try {
    const planPath = path.join(dir, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify(BASE_PLAN));
    const result = spawnSync(process.execPath, [
      scriptPath,
      'dry-run',
      '--environment', 'staging',
      '--confirm-environment', 'staging',
      '--project-ref', 'abcdefghijklmnopqrst',
      '--plan', planPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN — no connection opened, no query executed/);
    assert.match(result.stdout, /charged=4 uncharged=2/);
    assert.match(result.stdout, /Blocked bookings: bk-blocked-1, bk-blocked-2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runbook documents the three reconciliation gates and the production situation', () => {
  const runbook = fs.readFileSync(path.join(root, 'docs/supabase-deployment-runbook.md'), 'utf8');
  for (const fragment of [
    'scripts/reconcile-legacy-quotes.js dry-run',
    'scripts/reconcile-legacy-quotes.js review',
    'scripts/reconcile-legacy-quotes.js apply',
    'APPLY-LEGACY-QUOTE-RECONCILIATION',
    'backups/production-predeploy-',
    'HTTP 402',
    'newgrp docker',
  ]) {
    assert.ok(runbook.includes(fragment), `runbook is missing: ${fragment}`);
  }
  assert.match(runbook, /No production data was changed/);
  assert.doesNotMatch(runbook, /No live service was contacted/);
});
