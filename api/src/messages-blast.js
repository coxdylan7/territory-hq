'use strict';

const crypto = require('node:crypto');
const { smsConfigured } = require('./integrations');
const { canonicalRequestHash, withIdempotency } = require('./idempotency');
const { ServiceError } = require('./service-errors');
const { BLAST_LIMITS } = require('../../shared/blast-limits.cjs');

const BATCH_OPERATION = 'messages.blast';
const RECIPIENT_OPERATION = 'messages.blast.recipient';

function validateBlastRequest(input = {}) {
  const { accountIds, template } = input;
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    throw new ServiceError(400, 'BLAST_INVALID_REQUEST', 'Select at least one recipient.');
  }
  if (accountIds.length > BLAST_LIMITS.maxRecipients) {
    throw new ServiceError(
      413,
      'BLAST_TOO_MANY_RECIPIENTS',
      `A blast request can contain at most ${BLAST_LIMITS.maxRecipients} recipients.`,
      { maxRecipients: BLAST_LIMITS.maxRecipients }
    );
  }
  if (accountIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new ServiceError(400, 'BLAST_INVALID_REQUEST', 'Every recipient must be a non-empty account id.');
  }
  if (new Set(accountIds).size !== accountIds.length) {
    throw new ServiceError(400, 'BLAST_INVALID_REQUEST', 'Duplicate recipients are not allowed.');
  }
  if (typeof template !== 'string' || !template.trim()) {
    throw new ServiceError(400, 'BLAST_INVALID_REQUEST', 'Write a message before sending a blast.');
  }
  return { accountIds: [...accountIds], template };
}

function summarize(results, smsEnabled) {
  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    sent: count('sent'),
    queued: count('queued'),
    skipped: count('skipped'),
    failed: count('failed'),
    total: results.length,
    smsEnabled,
    results,
  };
}

function parseStoredBody(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function digest(...parts) {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function recipientIdempotencyKey(batchKey, accountId) {
  return digest(RECIPIENT_OPERATION, batchKey, accountId);
}

function recipientMessageId(recipientKey) {
  return `msg-${recipientKey}`;
}

function batchId(batchKey) {
  return `blast-${digest(BATCH_OPERATION, batchKey).slice(0, 24)}`;
}

async function claimRecipient(sql, fields, newId) {
  const insert = async () => sql`
    INSERT INTO api_idempotency
      (id, owner_user_id, actor_type, actor_id, operation, idempotency_key, request_hash)
    VALUES
      (${newId()}, ${fields.ownerUserId}, ${fields.actor.type}, ${fields.actor.id},
       ${RECIPIENT_OPERATION}, ${fields.key}, ${fields.requestHash})
    ON CONFLICT (owner_user_id, actor_type, actor_id, operation, idempotency_key)
    DO NOTHING RETURNING id`;

  const inserted = await insert();
  if (inserted.length) return { acquired: true };

  const read = async () => sql`
    SELECT id, request_hash, response_status, response_body, completed_at
      FROM api_idempotency
     WHERE owner_user_id = ${fields.ownerUserId}
       AND actor_type = ${fields.actor.type}
       AND actor_id = ${fields.actor.id}
       AND operation = ${RECIPIENT_OPERATION}
       AND idempotency_key = ${fields.key}
       FOR UPDATE`;

  let rows = await read();
  if (!rows.length) {
    // A rolled-back concurrent insert can briefly hide the winning row.
    const retried = await insert();
    if (retried.length) return { acquired: true };
    rows = await read();
  }
  const row = rows[0];
  if (!row) return { acquired: false, inFlight: true };
  if (row.request_hash !== fields.requestHash) {
    throw new ServiceError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'This blast key was already used for a different recipient or message.'
    );
  }
  if (row.completed_at) return { acquired: false, replay: parseStoredBody(row.response_body) };
  return { acquired: false, inFlight: true };
}

async function completeRecipient(sql, fields, result) {
  await sql`
    UPDATE api_idempotency
       SET response_status = ${result.sent ? 200 : 202},
           response_body = ${JSON.stringify(result)}::jsonb,
           completed_at = now()
     WHERE idempotency_key = ${fields.key}
       AND owner_user_id = ${fields.ownerUserId}
       AND actor_type = ${fields.actor.type}
       AND actor_id = ${fields.actor.id}
       AND operation = ${RECIPIENT_OPERATION}`;
}

function createBlastService(dependencies = {}) {
  const sql = dependencies.sql;
  const sendSmsTwilio = dependencies.sendSmsTwilio;
  const smsEnabled = dependencies.smsConfigured || smsConfigured;
  const newId = dependencies.newId || (() => crypto.randomUUID());

  async function deliverOne({ accountId, template, blastId, ownerUserId, actor, batchKey }) {
    const rows = await sql`
      SELECT * FROM accounts WHERE id = ${accountId} AND user_id = ${ownerUserId}`;
    const acc = rows[0];
    if (!acc || !acc.phone) {
      return { accountId, status: 'skipped', ok: false, sent: false, reason: 'no phone on file' };
    }

    const text = String(template).replace(/\{name\}/gi, acc.name || '');
    const key = recipientIdempotencyKey(batchKey, accountId);
    const messageId = recipientMessageId(key);
    const fields = {
      ownerUserId,
      actor,
      key,
      requestHash: canonicalRequestHash({
        operation: RECIPIENT_OPERATION,
        resourceId: accountId,
        actor,
        body: { batchKey, accountId, phone: acc.phone, text },
      }),
    };

    const claim = await claimRecipient(sql, fields, newId);
    if (claim.replay) return claim.replay;
    if (!claim.acquired) {
      const storedRows = await sql`
        SELECT id, status FROM messages WHERE id = ${messageId} AND user_id = ${ownerUserId}`;
      const stored = storedRows[0];
      if (stored) {
        const sent = stored.status === 'sent';
        return {
          accountId, ok: sent, sent, status: sent ? 'sent' : 'queued',
          reason: 'replayed_from_message', messageId: stored.id,
        };
      }
      return {
        accountId, ok: false, sent: false, status: 'failed', messageId,
        reason: 'recipient send is in progress or was interrupted before confirmation',
      };
    }

    let sendResult;
    try {
      sendResult = await sendSmsTwilio(acc.phone, text, { timeoutMs: BLAST_LIMITS.twilioTimeoutMs });
    } catch (error) {
      sendResult = { sent: false, reason: error && error.message ? error.message : 'send failed' };
    }
    const sent = Boolean(sendResult && sendResult.sent);

    // A deterministic id plus ON CONFLICT makes the audit row replay-safe even
    // if a retry happens after Twilio confirmation but before idempotency
    // completion was committed.
    await sql`
      INSERT INTO messages
        (id, account_id, account_name, license_number, city, channel, purpose,
         body, recipient, direction, date, status, blast_id, user_id)
      VALUES
        (${messageId}, ${acc.id}, ${acc.name}, ${acc.license_number || ''}, ${acc.city || ''},
         'text', 'SMS blast', ${text}, ${acc.phone}, 'outbound', ${new Date().toISOString()},
         ${sent ? 'sent' : 'queued'}, ${blastId}, ${ownerUserId})
      ON CONFLICT (id) DO NOTHING RETURNING id`;

    const result = {
      accountId,
      ok: sent,
      sent,
      status: sent ? 'sent' : 'queued',
      reason: sent ? 'sent' : (sendResult && sendResult.reason ? sendResult.reason : 'not sent'),
      messageId,
    };
    await completeRecipient(sql, fields, result);
    return result;
  }

  return {
    validateBlastRequest,
    async sendBlast(input) {
      const request = validateBlastRequest(input);
      const actor = input.actor || { type: 'hq_user', id: input.ownerUserId };
      const blastId = batchId(input.key);
      const results = new Array(request.accountIds.length);

      return withIdempotency({
        sql,
        ownerUserId: input.ownerUserId,
        actor,
        operation: BATCH_OPERATION,
        key: input.key,
        requestHash: canonicalRequestHash({
          operation: BATCH_OPERATION,
          resourceId: null,
          actor,
          body: { accountIds: request.accountIds, template: request.template },
        }),
        handler: async () => {
          for (let offset = 0; offset < request.accountIds.length; offset += BLAST_LIMITS.concurrency) {
            const wave = request.accountIds
              .slice(offset, offset + BLAST_LIMITS.concurrency)
              .map(async (accountId, index) => {
                results[offset + index] = await deliverOne({
                  accountId,
                  template: request.template,
                  blastId,
                  ownerUserId: input.ownerUserId,
                  actor,
                  batchKey: input.key,
                });
              });
            await Promise.all(wave);
          }

          const body = summarize(results, Boolean(smsEnabled()));
          return {
            status: body.sent === body.total ? 200 : 207,
            body: { blastId, ...body },
          };
        },
      });
    },
  };
}

module.exports = { createBlastService, validateBlastRequest, summarize };
