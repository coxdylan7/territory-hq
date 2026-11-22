// Browser-side helpers for the bounded Netlify-safe SMS blast flow. The cap is
// imported from the same module the API uses; the API still rejects oversize
// requests even if a different client is written incorrectly.
import limitsModule from '../../shared/blast-limits.cjs';

const { BLAST_LIMITS } = limitsModule;
export const BLAST_MAX_RECIPIENTS = BLAST_LIMITS.maxRecipients;

export function chunkRecipients(accountIds) {
  if (!Array.isArray(accountIds)) throw new TypeError('Recipients must be an array.');
  const chunks = [];
  for (let i = 0; i < accountIds.length; i += BLAST_MAX_RECIPIENTS) {
    chunks.push(accountIds.slice(i, i + BLAST_MAX_RECIPIENTS));
  }
  return chunks;
}

function defaultRunId() {
  if (!globalThis.crypto) throw new Error('crypto.randomUUID is unavailable');
  return globalThis.crypto.randomUUID();
}

export function createBlastRun(accountIds, options = {}) {
  const createRunId = options.createRunId || defaultRunId;
  const runId = createRunId();
  return {
    runId,
    batches: chunkRecipients(accountIds).map((ids, index) => ({
      index,
      accountIds: ids,
      idempotencyKey: `blast:${runId}:${index}`,
    })),
    total: accountIds.length,
  };
}

export function aggregateBlastResults(options = {}) {
  const results = options.results || [];
  const sum = (field) => results.reduce((total, result) => {
    const body = result && result.body;
    return total + (body && Number.isFinite(body[field]) ? body[field] : 0);
  }, 0);
  return {
    total: options.total || 0,
    batches: results.length,
    sent: sum('sent'),
    queued: sum('queued'),
    skipped: sum('skipped'),
    failed: sum('failed'),
    replayed: results.filter((result) => result && result.replayed).length,
    stopped: Boolean(options.stopped),
    error: options.error || null,
    results,
  };
}

// Safe rule: continue only after a response that settled every recipient in the
// batch (200/207 with a body). Stop on transport failures and HTTP errors,
// where the state of the batch is unknown and an automatic retry is unsafe.
export function shouldStopAfterBatch(outcome) {
  if (!outcome || outcome.error) return true;
  if (Number(outcome.status) >= 400) return true;
  return !outcome.body;
}

export function formatBlastProgress(aggregate, batchNumber, batchCount, options = {}) {
  const headline = options.final ? 'Final' : `Batch ${batchNumber} of ${batchCount}`;
  const counts = `${aggregate.sent} sent live, ${aggregate.queued} logged as queued, `
    + `${aggregate.skipped} skipped, ${aggregate.failed} failed`;
  if (!options.final) return `${headline}: ${counts}`;

  const stopped = options.stopped === undefined ? aggregate.stopped : options.stopped;
  const outcome = stopped
    ? `stopped after batch ${batchNumber} of ${batchCount}`
    : `completed all ${batchCount} batch(es)`;
  return `${headline}: ${counts} — ${outcome}${options.error ? ` — ${options.error}` : ''}`;
}

export function createSubmitGuard() {
  let active = false;
  return {
    start() {
      if (active) return false;
      active = true;
      return true;
    },
    release() { active = false; },
    active() { return active; },
  };
}
