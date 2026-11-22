import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BLAST_MAX_RECIPIENTS,
  chunkRecipients,
  createBlastRun,
  aggregateBlastResults,
  shouldStopAfterBatch,
  formatBlastProgress,
  createSubmitGuard,
} from '../src/blast-batches.js';

test('large selections are split deterministically into server-sized chunks', () => {
  const ids = Array.from({ length: 23 }, (_, i) => `acc-${i + 1}`);
  const chunks = chunkRecipients(ids);
  assert.deepEqual(chunks.map((c) => c.length), [10, 10, 3]);
  assert.deepEqual(chunks[0][0], 'acc-1');
  assert.deepEqual(chunks[2], ['acc-21', 'acc-22', 'acc-23']);
  assert.equal(BLAST_MAX_RECIPIENTS, 10);
});

test('a blast run assigns stable batch keys so retries reuse the same idempotency records', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `acc-${i + 1}`);
  const run = createBlastRun(ids, { createRunId: () => 'run-fixed' });
  assert.equal(run.runId, 'run-fixed');
  assert.equal(run.batches.length, 2);
  assert.deepEqual(run.batches.map((b) => b.idempotencyKey), [
    'blast:run-fixed:0',
    'blast:run-fixed:1',
  ]);
  assert.deepEqual(run.batches.map((b) => b.accountIds.length), [10, 2]);
  assert.deepEqual(createBlastRun(ids, { createRunId: () => 'run-fixed' }), run);
});

test('aggregate results add every batch without double counting replayed responses', () => {
  const aggregate = aggregateBlastResults({
    total: 12,
    results: [
      {
        batchIndex: 0,
        status: 200,
        body: { sent: 8, queued: 1, skipped: 1, failed: 0, total: 10 },
      },
      {
        batchIndex: 1,
        replayed: true,
        status: 207,
        body: { sent: 1, queued: 1, skipped: 0, failed: 0, total: 2 },
      },
    ],
    stopped: false,
  });
  assert.deepEqual(
    {
      total: aggregate.total,
      batches: aggregate.batches,
      sent: aggregate.sent,
      queued: aggregate.queued,
      skipped: aggregate.skipped,
      failed: aggregate.failed,
      replayed: aggregate.replayed,
      stopped: aggregate.stopped,
    },
    {
      total: 12,
      batches: 2,
      sent: 9,
      queued: 2,
      skipped: 1,
      failed: 0,
      replayed: 1,
      stopped: false,
    }
  );
});

test('only unknown batch outcomes stop subsequent batches; settled partial results continue', () => {
  assert.equal(shouldStopAfterBatch({ status: 200, body: { sent: 10 } }), false);
  assert.equal(shouldStopAfterBatch({ status: 207, body: { sent: 8, queued: 2 } }), false);
  assert.equal(shouldStopAfterBatch({ status: 400, error: 'invalid request' }), true);
  assert.equal(shouldStopAfterBatch({ status: 500, error: 'server error' }), true);
  assert.equal(shouldStopAfterBatch({ error: 'network interruption' }), true);
});

test('progress text exposes batch position and final aggregate counts', () => {
  const aggregate = aggregateBlastResults({
    total: 12,
    results: [{ batchIndex: 0, status: 207, body: { sent: 8, queued: 1, skipped: 1, failed: 0, total: 10 } }],
    stopped: false,
  });
  const progress = formatBlastProgress(aggregate, 1, 2);
  const final = formatBlastProgress(aggregate, 2, 2, { final: true, stopped: true, error: 'network interruption' });

  assert.match(progress, /Batch 1 of 2/);
  assert.match(progress, /8 sent/);
  assert.match(final, /Final/);
  assert.match(final, /stopped after batch 2 of 2/);
  assert.match(final, /network interruption/);
});

test('a single-flight guard blocks a second click until the first run is released', () => {
  const guard = createSubmitGuard();
  assert.equal(guard.start(), true);
  assert.equal(guard.start(), false);
  assert.equal(guard.active(), true);
  guard.release();
  assert.equal(guard.active(), false);
  assert.equal(guard.start(), true);
});

test('Messages.jsx delegates blasting to the tested batch helper and submit guard', () => {
  const source = readFileSync(new URL('../src/tabs/Messages.jsx', import.meta.url), 'utf8');
  assert.match(source, /from '\.\.\/blast-batches\.js'/);
  assert.match(source, /createBlastRun\(/);
  assert.match(source, /createSubmitGuard\(/);
  assert.match(source, /api\.action\('POST', '\/api\/messages\/blast',\s*\{[\s\S]{0,300}idempotencyKey: batch\.idempotencyKey/);
  assert.match(source, /shouldStopAfterBatch\(/);
  assert.match(source, /formatBlastProgress\(/);
  assert.match(source, /disabled=\{blastLoading\}/);
  assert.doesNotMatch(source, /api\.post\('\/api\/messages\/blast'/);
});
