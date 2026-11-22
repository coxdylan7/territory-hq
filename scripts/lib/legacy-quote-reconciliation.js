'use strict';

// Fail-closed legacy quote reconciliation helpers.
//
// The production discovery found six legacy bookings, four with a nonzero
// charged amount and two with no matching owner-scoped event type. This module
// never infers financial components: charged bookings may receive only their
// existing charged total, and uncharged bookings require an explicit operator
// mapping or an explicit block. All identifiers and money values are validated
// before they can reach a SQL parameter.

const crypto = require('node:crypto');

const EXPECTED_CHARGED_COUNT = 4;
const EXPECTED_UNCHARGED_COUNT = 2;
const CONFIRM_APPLY = 'APPLY-LEGACY-QUOTE-RECONCILIATION';
const APPLY_FUNCTIONS = new Set(['fill_legacy_booking_total', 'fill_legacy_booking_quote']);

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

class ReconciliationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

function fail(message) {
  throw new ReconciliationError(message);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    fail(`${label} has an invalid booking identifier`);
  }
  return value;
}

function canonicalDecimal(value, label, { allowZero = false, max = null } = {}) {
  const text = typeof value === 'number' ? value.toString() : value;
  if (typeof text !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(text.trim())) {
    fail(`${label} must be a non-negative decimal with at most two places`);
  }
  const [whole, fraction = ''] = text.trim().split('.');
  const canonical = `${whole}.${fraction.padEnd(2, '0')}`;
  const numeric = Number(canonical);
  if (!Number.isFinite(numeric) || (!allowZero && numeric <= 0)) {
    fail(`${label} must be greater than zero`);
  }
  if (max !== null && numeric > max) fail(`${label} must not exceed ${max}`);
  return canonical;
}

function canonicalNullableDecimal(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return canonicalDecimal(value, label, { allowZero: true });
}

function expectedMappingTotal(mapping) {
  const extraHours = Math.max(0, Number(mapping.durationHours) - Number(mapping.baseHours));
  return Number(mapping.baseCredits) + extraHours * Number(mapping.extraHourCredits);
}

function canonicalMapping(value, bookingId) {
  assertPlainObject(value, `mapping ${bookingId}`);
  for (const field of ['durationHours', 'baseHours', 'baseCredits', 'extraHourCredits', 'expectedTotal']) {
    if (!(field in value)) fail(`mapping ${bookingId} is missing ${field}`);
  }
  const mapping = {
    durationHours: canonicalDecimal(value.durationHours, `mapping ${bookingId} durationHours`, { max: 24 }),
    baseHours: canonicalDecimal(value.baseHours, `mapping ${bookingId} baseHours`, { max: 24 }),
    baseCredits: canonicalDecimal(value.baseCredits, `mapping ${bookingId} baseCredits`),
    extraHourCredits: canonicalDecimal(value.extraHourCredits, `mapping ${bookingId} extraHourCredits`, { allowZero: true }),
    expectedTotal: canonicalDecimal(value.expectedTotal, `mapping ${bookingId} expectedTotal`),
  };
  const derived = Number(expectedMappingTotal(mapping)).toFixed(2);
  if (derived !== mapping.expectedTotal) {
    fail(`mapping ${bookingId} expectedTotal does not match its explicit components`);
  }
  return mapping;
}

function canonicalPlan(plan) {
  assertPlainObject(plan, 'plan');
  if (plan.version !== 1) fail('plan version must be 1');
  if (!Array.isArray(plan.chargedBookings) || plan.chargedBookings.length !== EXPECTED_CHARGED_COUNT) {
    fail('plan must name exactly four charged bookings');
  }
  if (!Array.isArray(plan.blockedBookings) || plan.blockedBookings.length > EXPECTED_UNCHARGED_COUNT) {
    fail(`plan cannot block more than ${EXPECTED_UNCHARGED_COUNT} uncharged bookings`);
  }

  const chargedBookings = plan.chargedBookings.map((id) => assertId(id, 'chargedBookings'));
  const blockedBookings = plan.blockedBookings.map((id) => assertId(id, 'blockedBookings'));
  for (const [label, ids] of [['chargedBookings', chargedBookings], ['blockedBookings', blockedBookings]]) {
    if (new Set(ids).size !== ids.length) fail(`${label} values must be unique`);
  }
  const charged = new Set(chargedBookings);
  const blocked = new Set(blockedBookings);
  for (const id of blocked) {
    if (charged.has(id)) fail(`charged/uncharged overlap for booking ${id}`);
  }

  assertPlainObject(plan.mappings || {}, 'mappings');
  const mappings = {};
  for (const [id, mapping] of Object.entries(plan.mappings || {})) {
    assertId(id, 'mappings key');
    if (charged.has(id)) fail(`charged booking ${id} must not carry a component mapping`);
    if (blocked.has(id)) fail(`mapped booking ${id} must not also be blocked`);
    mappings[id] = canonicalMapping(mapping, id);
  }
  const mapped = new Set(Object.keys(mappings));
  if (blocked.size + mapped.size !== EXPECTED_UNCHARGED_COUNT) {
    fail('the plan must map or explicitly block exactly two uncharged bookings');
  }

  return {
    version: 1,
    chargedBookings: [...chargedBookings].sort(),
    blockedBookings: [...blockedBookings].sort(),
    mappings: Object.fromEntries([...mapped].sort().map((id) => [id, mappings[id]])),
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function planHash(plan) {
  return crypto.createHash('sha256').update(canonicalJson(canonicalPlan(plan))).digest('hex');
}

function validateTarget(target) {
  assertPlainObject(target, 'target');
  if (!['staging', 'production'].includes(target.environment)) fail('target environment must be staging or production');
  if (typeof target.projectRef !== 'string' || !/^[a-z]{20}$/i.test(target.projectRef)) {
    fail('target projectRef is invalid');
  }
  return { environment: target.environment, projectRef: target.projectRef };
}

function rowMap(rows) {
  if (!Array.isArray(rows)) fail('review rows must be an array');
  const byId = new Map();
  for (const row of rows) {
    assertPlainObject(row, 'booking row');
    const id = assertId(row.id, 'booking row');
    if (byId.has(id)) fail(`duplicate booking row ${id}`);
    byId.set(id, row);
  }
  return byId;
}

function assertLegacyQuoteEmpty(row) {
  if ([row.quotedCredits, row.quoteBaseHours, row.quoteBaseCredits, row.quoteExtraHourCredits]
    .some((value) => value !== null && value !== undefined && value !== '')) {
    fail(`booking ${row.id} already has quote data`);
  }
}

function snapshotHash(review) {
  return crypto.createHash('sha256').update(canonicalJson({
    version: 1,
    target: review.target,
    planHash: review.planHash,
    aggregate: review.aggregate,
    operations: review.operations,
  })).digest('hex');
}

function buildReview({ plan, rows, target }) {
  const canonical = canonicalPlan(plan);
  const validatedTarget = validateTarget(target);
  const byId = rowMap(rows);
  const expectedIds = [
    ...canonical.chargedBookings,
    ...canonical.blockedBookings,
    ...Object.keys(canonical.mappings),
  ];
  for (const id of expectedIds) {
    if (!byId.has(id)) fail(`missing booking ${id} in review query`);
  }
  if (byId.size !== expectedIds.length) fail('review query returned an unexpected booking');

  const operations = [];
  for (const id of canonical.chargedBookings) {
    const row = byId.get(id);
    assertLegacyQuoteEmpty(row);
    const chargedTotal = canonicalNullableDecimal(row.chargedTotal, `booking ${id} charged total`);
    if (!chargedTotal || Number(chargedTotal) <= 0) fail(`charged booking ${id} has no positive charged amount`);
    operations.push({
      kind: 'charged-total',
      bookingId: id,
      currentTotal: chargedTotal,
      componentColumns: null,
    });
  }
  for (const id of canonical.blockedBookings) {
    const row = byId.get(id);
    assertLegacyQuoteEmpty(row);
    const chargedTotal = canonicalNullableDecimal(row.chargedTotal, `booking ${id} charged total`);
    if (chargedTotal && Number(chargedTotal) > 0) fail(`blocked booking ${id} has a charged amount and must be reclassified`);
    operations.push({ kind: 'blocked', bookingId: id, reason: 'explicit operator block; no write' });
  }
  for (const [id, mapping] of Object.entries(canonical.mappings)) {
    const row = byId.get(id);
    assertLegacyQuoteEmpty(row);
    const chargedTotal = canonicalNullableDecimal(row.chargedTotal, `booking ${id} charged total`);
    if (chargedTotal && Number(chargedTotal) > 0) fail(`mapped booking ${id} has a charged amount and must use the charged-total path`);
    const duration = canonicalNullableDecimal(row.durationHours, `booking ${id} durationHours`);
    if (!duration || duration !== mapping.durationHours) {
      fail(`mapped booking ${id} duration drifted from the explicit operator mapping`);
    }
    operations.push({
      kind: 'full-mapping',
      bookingId: id,
      quotedCredits: mapping.expectedTotal,
      baseHours: mapping.baseHours,
      baseCredits: mapping.baseCredits,
      extraHourCredits: mapping.extraHourCredits,
      durationHours: duration,
    });
  }

  operations.sort((a, b) => a.bookingId.localeCompare(b.bookingId));
  const aggregate = {
    totalBookings: operations.length,
    chargedBookings: canonical.chargedBookings.length,
    mappedUnchargedBookings: Object.keys(canonical.mappings).length,
    blockedUnchargedBookings: canonical.blockedBookings.length,
  };
  const review = {
    version: 1,
    status: 'pending',
    target: validatedTarget,
    planHash: planHash(canonical),
    aggregate,
    operations,
    approval: null,
  };
  review.snapshotHash = snapshotHash(review);
  return review;
}

function applyCalls(review) {
  assertPlainObject(review, 'review');
  if (!Array.isArray(review.operations)) fail('review operations are missing');
  const calls = [];
  for (const op of review.operations) {
    assertPlainObject(op, 'review operation');
    const id = assertId(op.bookingId, 'review operation');
    if (op.kind === 'charged-total') {
      const total = canonicalDecimal(op.currentTotal, `charged total ${id}`);
      if (op.componentColumns !== null) fail(`charged total ${id} must leave component columns NULL`);
      calls.push({ function: 'fill_legacy_booking_total', bookingId: id, args: [id, total] });
    } else if (op.kind === 'full-mapping') {
      const quotedCredits = canonicalDecimal(op.quotedCredits, `mapped total ${id}`);
      const baseHours = canonicalDecimal(op.baseHours, `mapped baseHours ${id}`, { max: 24 });
      const baseCredits = canonicalDecimal(op.baseCredits, `mapped baseCredits ${id}`);
      const extraHourCredits = canonicalDecimal(op.extraHourCredits, `mapped extraHourCredits ${id}`, { allowZero: true });
      calls.push({
        function: 'fill_legacy_booking_quote',
        bookingId: id,
        args: [id, quotedCredits, baseHours, baseCredits, extraHourCredits],
      });
    } else if (op.kind === 'blocked') {
      continue;
    } else {
      fail(`unknown review operation kind ${op.kind}`);
    }
  }
  for (const call of calls) {
    if (!APPLY_FUNCTIONS.has(call.function)) fail(`apply function ${call.function} is not allowlisted`);
  }
  return calls;
}

function assertApprovedReview(review, { planHash: expectedPlanHash, target, confirmation } = {}) {
  if (confirmation !== CONFIRM_APPLY) fail('apply confirmation must exactly repeat the typed gate');
  assertPlainObject(review, 'review');
  if (review.version !== 1) fail('review version must be 1');
  if (review.status !== 'approved' || !review.approval) fail('review must be explicitly approved');
  for (const field of ['approver', 'changeTicket', 'approvedAt']) {
    if (typeof review.approval[field] !== 'string' || !review.approval[field].trim()) {
      fail(`review approval is missing ${field}`);
    }
  }
  if (review.planHash !== expectedPlanHash) fail('review plan hash does not match the supplied plan');
  if (JSON.stringify(review.target) !== JSON.stringify(validateTarget(target))) fail('review target does not match the confirmed target');
  if (review.snapshotHash !== snapshotHash(review)) fail('review snapshot hash changed; approval is stale');
  applyCalls(review);
  return review;
}

function parseCli(argv) {
  const [mode, ...args] = argv;
  if (!['dry-run', 'review', 'apply'].includes(mode)) {
    throw new UsageError('mode must be dry-run, review or apply');
  }
  const parsed = {
    mode,
    environment: null,
    confirmEnvironment: null,
    projectRef: null,
    planPath: null,
    reviewOut: null,
    reviewFile: null,
    confirmApply: null,
    dbUrl: null,
    dbUrlFromStdin: false,
  };

  const takeValue = (flag, index) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case '--environment':
        parsed.environment = takeValue(flag, i++);
        break;
      case '--confirm-environment':
        parsed.confirmEnvironment = takeValue(flag, i++);
        break;
      case '--project-ref':
        parsed.projectRef = takeValue(flag, i++);
        break;
      case '--plan':
        parsed.planPath = takeValue(flag, i++);
        break;
      case '--review-out':
        parsed.reviewOut = takeValue(flag, i++);
        break;
      case '--review-file':
        parsed.reviewFile = takeValue(flag, i++);
        break;
      case '--confirm-apply':
        parsed.confirmApply = takeValue(flag, i++);
        break;
      case '--db-url-stdin':
        parsed.dbUrlFromStdin = true;
        break;
      case '--db-url':
        throw new UsageError('--db-url is forbidden; use --db-url-stdin');
      default:
        throw new UsageError(`unknown option: ${flag}`);
    }
  }

  for (const flag of ['environment', 'confirmEnvironment', 'projectRef', 'planPath']) {
    if (!parsed[flag]) throw new UsageError(`${flag} is required`);
  }
  if (!['staging', 'production'].includes(parsed.environment)) {
    throw new UsageError('--environment must be staging or production');
  }
  if (parsed.confirmEnvironment !== parsed.environment) {
    throw new UsageError('--confirm-environment must exactly repeat --environment');
  }
  if (!/^[a-z]{20}$/i.test(parsed.projectRef)) {
    throw new UsageError('--project-ref must be a 20-character project ref');
  }

  if (mode === 'dry-run') {
    if (parsed.dbUrlFromStdin || parsed.reviewOut || parsed.reviewFile || parsed.confirmApply) {
      throw new UsageError('dry-run is plan-only and forbids database, review-file and apply flags');
    }
  } else if (!parsed.dbUrlFromStdin) {
    throw new UsageError('--db-url-stdin is required for review and apply');
  }
  if (mode === 'review') {
    if (!parsed.reviewOut) throw new UsageError('--review-out is required for review');
    if (parsed.reviewFile || parsed.confirmApply) throw new UsageError('review cannot include apply flags');
  }
  if (mode === 'apply') {
    if (!parsed.reviewFile) throw new UsageError('--review-file is required for apply');
    if (parsed.reviewOut) throw new UsageError('--review-out is not valid for apply');
    if (parsed.confirmApply !== CONFIRM_APPLY) {
      throw new UsageError(`--confirm-apply must exactly be ${CONFIRM_APPLY}`);
    }
  }
  return parsed;
}

module.exports = {
  CONFIRM_APPLY,
  EXPECTED_CHARGED_COUNT,
  EXPECTED_UNCHARGED_COUNT,
  ReconciliationError,
  UsageError,
  applyCalls,
  assertApprovedReview,
  buildReview,
  canonicalPlan,
  parseCli,
  planHash,
  snapshotHash,
};
