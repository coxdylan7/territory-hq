// Invite activation is a single claim: lock the invite, choose an account that
// belongs to its owner, create the portal user, mark the invite used only if it
// is still unused, and create the session. Any failure rolls the whole claim
// back, so two concurrent activations cannot both redeem one invite.
'use strict';

const {
  ServiceError,
  errorBody,
  mapDatabaseError,
} = require('../../../api/src/service-errors');

const DEFAULT_SESSION_DAYS = 30;

function commandResult(error) {
  if (error instanceof ServiceError) {
    return { status: error.status, body: errorBody(error) };
  }
  if (error && ['23505', '23503', '23514'].includes(error.code)) {
    const mapped = mapDatabaseError(error);
    return { status: mapped.status, body: errorBody(mapped) };
  }
  return { status: 500, body: { error: 'db error', code: 'INTERNAL_ERROR' } };
}

async function activatePortalInvite(sql, input, deps = {}) {
  const body = input || {};
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const requestedAccountId = body.accountId == null || body.accountId === ''
    ? null
    : String(body.accountId);

  if (!token || !name || password.length < 6) {
    return commandResult(new ServiceError(
      400,
      'VALIDATION_ERROR',
      'name, password (6+ chars) and invite token required'
    ));
  }

  const now = deps.now ? deps.now() : new Date();
  const createToken = deps.randomToken;
  const hashPassword = deps.hashPassword;
  const sessionDays = Number(deps.sessionDays) || DEFAULT_SESSION_DAYS;
  const expires = new Date(now.getTime() + sessionDays * 86400000).toISOString();

  try {
    return await sql.begin(async (tx) => {
      const inviteRows = await tx`
        SELECT id, email, role, account_id, owner_user_id, expires, used_at
          FROM portal_invites
         WHERE token = ${token}
         FOR UPDATE`;
      if (!inviteRows.length) {
        throw new ServiceError(404, 'INVITE_NOT_FOUND', 'invalid invite token');
      }
      const invite = inviteRows[0];
      if (invite.used_at) {
        throw new ServiceError(409, 'INVITE_ALREADY_USED', 'invite already used');
      }
      const inviteExpires = new Date(invite.expires).getTime();
      if (!Number.isFinite(inviteExpires) || inviteExpires < now.getTime()) {
        throw new ServiceError(400, 'INVITE_EXPIRED', 'invite expired');
      }

      let accountId;
      if (invite.account_id) {
        if (requestedAccountId && requestedAccountId !== invite.account_id) {
          throw new ServiceError(400, 'ACCOUNT_MISMATCH', 'this invite is linked to a specific store');
        }
        accountId = invite.account_id;
      } else if (invite.role === 'brand_ambassador') {
        if (requestedAccountId) {
          throw new ServiceError(400, 'ACCOUNT_NOT_ALLOWED', 'this invite does not select a store');
        }
        accountId = null;
      } else {
        if (!requestedAccountId) {
          throw new ServiceError(400, 'ACCOUNT_REQUIRED', 'pick which store you belong to first');
        }
        accountId = requestedAccountId;
      }

      if (accountId) {
        const accounts = await tx`
          SELECT id
            FROM accounts
           WHERE id = ${accountId}
             AND user_id = ${invite.owner_user_id}
           FOR SHARE`;
        if (!accounts.length) {
          throw new ServiceError(400, 'ACCOUNT_NOT_AVAILABLE', 'that store is not available');
        }
        accountId = accounts[0].id;
      }

      const createdRows = await tx`
        INSERT INTO portal_users (
          id, name, email, role, account_id, owner_user_id, pass_hash, status
        )
        VALUES (
          ${createToken()}, ${name}, ${invite.email}, ${invite.role}, ${accountId},
          ${invite.owner_user_id}, ${hashPassword(password)}, 'active'
        )
        RETURNING id, name, email, role, account_id, owner_user_id`;
      const user = createdRows[0];
      if (!user) {
        throw new ServiceError(409, 'INVITE_CLAIM_FAILED', 'could not activate invite');
      }

      const claimed = await tx`
        UPDATE portal_invites
           SET used_at = ${now.toISOString()}
         WHERE id = ${invite.id}
           AND used_at IS NULL
        RETURNING id`;
      if (!claimed.length) {
        throw new ServiceError(409, 'INVITE_ALREADY_USED', 'invite already used');
      }

      const sessionToken = createToken();
      await tx`
        INSERT INTO portal_sessions (token, user_id, expires)
        VALUES (${sessionToken}, ${user.id}, ${expires})`;

      return {
        status: 200,
        body: {
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
          },
        },
        sessionToken,
      };
    });
  } catch (error) {
    return commandResult(error);
  }
}

module.exports = { activatePortalInvite };
