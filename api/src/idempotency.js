'use strict';

const crypto = require('node:crypto');
const { ServiceError } = require('./service-errors');

const KEY_PATTERN = /^[\x20-\x7e]{1,128}$/;

function readIdempotencyKey(req) {
  const headers = (req && req.headers) || {};
  let raw;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'idempotency-key') {
      raw = Array.isArray(value) ? value[0] : value;
      break;
    }
  }
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!KEY_PATTERN.test(key)) {
    throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required.');
  }
  return key;
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonicalize(value[key]);
  }
  return out;
}

function canonicalRequestHash({ operation, resourceId, actor, body }) {
  const canonical = canonicalize({ operation, resourceId: resourceId || null, actor, body: body || null });
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function acquire(sql, fields) {
  const inserted = await sql`
    INSERT INTO api_idempotency
      (id, owner_user_id, actor_type, actor_id, operation, idempotency_key, request_hash)
    VALUES
      (${crypto.randomUUID()}, ${fields.ownerUserId}, ${fields.actor.type}, ${fields.actor.id},
       ${fields.operation}, ${fields.key}, ${fields.requestHash})
    ON CONFLICT (owner_user_id, actor_type, actor_id, operation, idempotency_key)
    DO NOTHING
    RETURNING id`;
  if (inserted.length) return { acquired: true, row: inserted[0] };

  const existing = await sql`
    SELECT id, request_hash, response_status, response_body, completed_at
      FROM api_idempotency
     WHERE owner_user_id = ${fields.ownerUserId}
       AND actor_type = ${fields.actor.type}
       AND actor_id = ${fields.actor.id}
       AND operation = ${fields.operation}
       AND idempotency_key = ${fields.key}
     FOR UPDATE`;
  if (!existing.length) return { acquired: false, row: null };
  return { acquired: false, row: existing[0] };
}

async function persist(sql, fields, result) {
  const status = Number(result.status) || 200;
  await sql`
    UPDATE api_idempotency
       SET response_status = ${status},
           response_body = ${JSON.stringify(result.body || {})}::jsonb,
           completed_at = now()
     WHERE idempotency_key = ${fields.key}
       AND owner_user_id = ${fields.ownerUserId}
       AND actor_type = ${fields.actor.type}
       AND actor_id = ${fields.actor.id}
       AND operation = ${fields.operation}`;
}

async function withIdempotency(options) {
  const fields = {
    ownerUserId: options.ownerUserId,
    actor: options.actor,
    operation: options.operation,
    key: options.key,
    requestHash: options.requestHash,
  };

  // A rolled-back concurrent insert can make the first SELECT return no row.
  // Retry once so the winner's freshly committed record is observed.
  let acquired = await acquire(options.sql, fields);
  if (!acquired.row) acquired = await acquire(options.sql, fields);

  if (!acquired.acquired && acquired.row) {
    const row = acquired.row;
    if (row.request_hash !== fields.requestHash) {
      throw new ServiceError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.'
      );
    }
    if (row.completed_at) {
      return {
        status: Number(row.response_status) || 200,
        body: row.response_body || {},
        replayed: true,
      };
    }
  }

  const result = await options.handler(options.sql);
  await persist(options.sql, fields, result);
  return { status: Number(result.status) || 200, body: result.body || {}, replayed: false };
}

module.exports = {
  readIdempotencyKey,
  canonicalRequestHash,
  withIdempotency,
};
