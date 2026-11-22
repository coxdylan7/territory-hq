const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { activatePortalInvite } = require('../src/invite-activation');
const { createFakeSql, queryTexts } = require('../../../api/test/helpers/fake-sql');

const OWNER = 'owner-1';
const FUTURE = '2099-01-01T00:00:00.000Z';

function inviteDb(options = {}) {
  const state = {
    invite: {
      id: 'inv-1',
      email: 'store@example.test',
      role: options.role || 'store_manager',
      account_id: Object.prototype.hasOwnProperty.call(options, 'inviteAccountId')
        ? options.inviteAccountId
        : null,
      owner_user_id: OWNER,
      expires: options.expires || FUTURE,
      used_at: null,
    },
    accounts: [
      { id: 'acc-owned', user_id: OWNER },
      { id: 'acc-foreign', user_id: 'owner-2' },
    ],
    users: [],
    sessions: [],
  };

  const handler = (text, values) => {
    if (/FROM portal_invites[\s\S]*FOR UPDATE/.test(text)) {
      if (values[0] !== 'token-1') return [];
      const invite = { ...state.invite };
      if (options.raceClaim) invite.used_at = null;
      return [invite];
    }
    if (/FROM accounts/.test(text)) {
      const [accountId, ownerUserId] = values;
      if (options.accountError) throw options.accountError;
      return state.accounts
        .filter((account) => account.id === accountId && account.user_id === ownerUserId)
        .map((account) => ({ id: account.id }));
    }
    if (/INSERT INTO portal_users/.test(text)) {
      if (options.userError) throw options.userError;
      const [id, name, email, role, accountId, ownerUserId] = values;
      state.users.push({ id, name, email, role, account_id: accountId, owner_user_id: ownerUserId });
      return [{ id, name, email, role, account_id: accountId, owner_user_id: ownerUserId }];
    }
    if (/UPDATE portal_invites SET used_at/.test(text)) {
      if (options.raceClaim || state.invite.used_at) return [];
      state.invite.used_at = FUTURE;
      return [{ id: state.invite.id }];
    }
    if (/INSERT INTO portal_sessions/.test(text)) {
      state.sessions.push({ token: values[0], user_id: values[1], expires: values[2] });
      return [{}];
    }
    return [];
  };

  return { ...createFakeSql(handler), state };
}

function deps(overrides = {}) {
  let token = 0;
  return {
    now: () => new Date('2026-11-21T00:00:00.000Z'),
    hashPassword: () => 'salt:hash',
    randomToken: () => `generated-${++token}`,
    sessionDays: 30,
    ...overrides,
  };
}

function activate(sql, body, overrides) {
  return activatePortalInvite(sql, body, deps(overrides));
}

test('an account-bound invite rejects a caller override and rolls back', async () => {
  const { sql, calls, state } = inviteDb({ inviteAccountId: 'acc-owned' });
  const result = await activate(sql, {
    token: 'token-1', name: ' Manager ', password: 'secret123', accountId: 'acc-foreign',
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'ACCOUNT_MISMATCH');
  assert.deepEqual(state.users, []);
  assert.deepEqual(state.sessions, []);
  assert.equal(state.invite.used_at, null);
  assert.ok(calls.some((call) => call.kind === 'rollback'));
});

test('an account-bound invite uses its exact account even when no override is supplied', async () => {
  const { sql, calls, state } = inviteDb({ inviteAccountId: 'acc-owned' });
  const result = await activate(sql, { token: 'token-1', name: 'Manager', password: 'secret123' });

  assert.equal(result.status, 200);
  assert.equal(state.users[0].account_id, 'acc-owned');
  assert.match(queryTexts(calls).find((text) => /FROM accounts/.test(text)), /user_id = \?/);
});

test('an owner-wide invite accepts only an account owned by the invite owner', async () => {
  const foreign = inviteDb();
  const foreignResult = await activate(foreign.sql, {
    token: 'token-1', name: 'Manager', password: 'secret123', accountId: 'acc-foreign',
  });
  assert.equal(foreignResult.status, 400);
  assert.equal(foreignResult.body.code, 'ACCOUNT_NOT_AVAILABLE');
  assert.deepEqual(foreign.state.users, []);
  assert.deepEqual(foreign.state.sessions, []);

  const owned = inviteDb();
  const ownedResult = await activate(owned.sql, {
    token: 'token-1', name: 'Manager', password: 'secret123', accountId: 'acc-owned',
  });
  assert.equal(ownedResult.status, 200);
  assert.equal(owned.state.users[0].account_id, 'acc-owned');
});

test('invite claim, user creation and session creation happen in one transaction', async () => {
  const { sql, calls, state } = inviteDb();
  const result = await activate(sql, {
    token: 'token-1', name: 'Manager', password: 'secret123', accountId: 'acc-owned',
  });

  assert.equal(result.status, 200);
  assert.ok(result.sessionToken);
  assert.equal(result.body.user.email, 'store@example.test');
  assert.equal(state.sessions[0].user_id, state.users[0].id);

  const sequence = calls.map((call) => call.kind === 'query' ? call.text : call.kind);
  assert.equal(sequence[0], 'begin');
  assert.equal(sequence.at(-1), 'commit');
  const texts = queryTexts(calls);
  assert.match(texts.find((text) => /FROM portal_invites/.test(text)), /FOR UPDATE/);
  assert.match(texts.find((text) => /UPDATE portal_invites/.test(text)), /used_at IS NULL/);
  const userInsertIndex = texts.findIndex((text) => /INSERT INTO portal_users/.test(text));
  const claimIndex = texts.findIndex((text) => /UPDATE portal_invites/.test(text));
  const sessionIndex = texts.findIndex((text) => /INSERT INTO portal_sessions/.test(text));
  assert.ok(claimIndex >= userInsertIndex, 'the user is created before the invite is claimed');
  assert.ok(claimIndex < sessionIndex, 'a session is only created after the claim succeeds');
});

test('a concurrent activation cannot claim an already-used invite', async () => {
  const { sql, calls, state } = inviteDb({ raceClaim: true });
  const result = await activate(sql, {
    token: 'token-1', name: 'Second', password: 'secret123', accountId: 'acc-owned',
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'INVITE_ALREADY_USED');
  assert.equal(state.sessions.length, 0);
  assert.ok(calls.some((call) => call.kind === 'rollback'));
  assert.ok(!calls.some((call) => call.kind === 'commit'));
});

test('validation failures are 4xx and unexpected database errors are sanitized 500s', async () => {
  const invalid = await activate(null, { token: '', name: '', password: 'short' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'VALIDATION_ERROR');

  const missing = inviteDb();
  const missingResult = await activate(missing.sql, {
    token: 'wrong-token', name: 'Manager', password: 'secret123', accountId: 'acc-owned',
  });
  assert.equal(missingResult.status, 404);
  assert.equal(missingResult.body.code, 'INVITE_NOT_FOUND');

  const dbError = inviteDb({ accountError: Object.assign(new Error('secret db detail'), { code: 'XXXXX' }) });
  const dbResult = await activate(dbError.sql, {
    token: 'token-1', name: 'Manager', password: 'secret123', accountId: 'acc-owned',
  });
  assert.equal(dbResult.status, 500);
  assert.equal(dbResult.body.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(dbResult.body), /secret db detail/);
});

test('the invite-signup route uses the tested transactional helper', () => {
  const source = readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const route = source.slice(
    source.indexOf("app.post('/api/auth/invite-signup'"),
    source.indexOf('// Pre-claim store picker')
  );
  assert.match(route, /activatePortalInvite\(sql, req\.body \|\| \{\}/);
  assert.match(route, /setSessionCookie\(res, PORTAL_COOKIE, result\.sessionToken\)/);
  assert.doesNotMatch(route, /SELECT \* FROM portal_invites WHERE token = \$\{token\}/);
  assert.doesNotMatch(route, /fail\(res, 409, 'could not activate invite'\)/);
});
