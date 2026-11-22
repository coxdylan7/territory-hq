'use strict';

// Small in-memory stand-in for the SQL tagged-template calls made by the blast
// service. All side effects that would be external to the service are recorded
// here; the Twilio boundary is injected separately by each test.

function createFakeBlastDb(options = {}) {
  const accounts = options.accounts || [];
  const users = options.users || [];
  const sessions = options.sessions || [];
  const idempotency = new Map();
  const messages = new Map();
  const calls = [];
  let failBatchPersistOnce = Boolean(options.failBatchPersistOnce);

  const idemKey = (owner, actorType, actorId, operation, key) =>
    [owner, actorType, actorId, operation, key].join('\u0000');

  function idemLookup(values) {
    const [owner, actorType, actorId, operation, key] = values;
    return {
      composite: idemKey(owner, actorType, actorId, operation, key),
      operation,
    };
  }

  const sql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });

    if (/FROM sessions s JOIN users u/.test(text)) {
      const [token] = values;
      const session = sessions.find((s) => s.token === token && s.expires > values[1]);
      const user = session && users.find((u) => u.id === session.user_id);
      return Promise.resolve(user ? [user] : []);
    }

    if (/SELECT \* FROM accounts WHERE id = /.test(text)) {
      const [accountId, ownerUserId] = values;
      const rows = accounts.filter((a) => a.id === accountId && a.user_id === ownerUserId);
      return Promise.resolve(rows);
    }

    if (/INSERT INTO api_idempotency/.test(text)) {
      const [id, owner, actorType, actorId, operation, key, requestHash] = values;
      const composite = idemKey(owner, actorType, actorId, operation, key);
      if (idempotency.has(composite)) return Promise.resolve([]);
      const row = {
        id,
        owner_user_id: owner,
        actor_type: actorType,
        actor_id: actorId,
        operation,
        idempotency_key: key,
        request_hash: requestHash,
        response_status: null,
        response_body: null,
        completed_at: null,
      };
      idempotency.set(composite, row);
      return Promise.resolve([row]);
    }

    if (/SELECT id, request_hash, response_status, response_body, completed_at\s+FROM api_idempotency/.test(text)) {
      const { composite } = idemLookup(values);
      const row = idempotency.get(composite);
      return Promise.resolve(row ? [row] : []);
    }

    if (/UPDATE api_idempotency/.test(text)) {
      const [status, responseBody, key, owner, actorType, actorId, operation] = values;
      const row = idempotency.get(idemKey(owner, actorType, actorId, operation, key));
      if (!row) return Promise.resolve([]);
      if (operation === 'messages.blast' && failBatchPersistOnce) {
        failBatchPersistOnce = false;
        throw new Error('injected batch persist failure');
      }
      row.response_status = Number(status);
      row.response_body = responseBody;
      row.completed_at = 'now';
      return Promise.resolve([row]);
    }

    if (/SELECT id, status FROM messages WHERE id = /.test(text)) {
      const [id, ownerUserId] = values;
      const row = messages.get(id);
      return Promise.resolve(row && row.user_id === ownerUserId ? [row] : []);
    }

    if (/INSERT INTO messages/.test(text)) {
      const [id, accountId, accountName, licenseNumber, city, body, recipient, date, status, blastId, userId] = values;
      if (messages.has(id)) return Promise.resolve([]);
      const row = {
        id, account_id: accountId, account_name: accountName,
        license_number: licenseNumber, city,
        channel: 'text', purpose: 'SMS blast', body,
        recipient, direction: 'outbound', date, status,
        blast_id: blastId, user_id: userId,
      };
      messages.set(id, row);
      return Promise.resolve([row]);
    }

    throw new Error(`unhandled SQL in fake blast db: ${text}`);
  };
  sql.begin = async (handler) => handler(sql);

  return {
    sql,
    calls,
    idempotency,
    messages,
    setFailBatchPersistOnce(value) { failBatchPersistOnce = Boolean(value); },
  };
}

module.exports = { createFakeBlastDb };
