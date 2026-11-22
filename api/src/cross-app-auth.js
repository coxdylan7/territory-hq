const { bearerToken, safeEq } = require('./helpers');

// CROSS_APP_TOKENS_JSON is a server-side secret: a JSON object whose keys are
// opaque bearer tokens and whose values are the single owner_user_id each token
// may access. No owner id is ever read from the request.
function parseCrossAppTokens(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return new Map();

  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('CROSS_APP_TOKENS_JSON must be a JSON object');
  }

  const tokens = new Map();
  for (const [token, ownerUserId] of Object.entries(parsed)) {
    if (!token || typeof ownerUserId !== 'string' || !ownerUserId.trim()) {
      throw new TypeError('CROSS_APP_TOKENS_JSON entries need a token and a non-empty owner_user_id');
    }
    tokens.set(token, ownerUserId.trim());
  }
  return tokens;
}

function resolveCrossAppOwner(req, env = process.env, logger = console) {
  let tokens;
  try {
    tokens = parseCrossAppTokens(env.CROSS_APP_TOKENS_JSON);
  } catch {
    // Fail closed: malformed configuration grants nobody access. Never log the
    // raw value because it contains the tokens themselves.
    logger.error?.('CROSS_APP_TOKENS_JSON is invalid; cross-app reads are disabled.');
    return null;
  }

  const presented = bearerToken(req);
  if (!presented) return null;

  for (const [configuredToken, ownerUserId] of tokens) {
    if (safeEq(presented, configuredToken)) return ownerUserId;
  }
  return null;
}

module.exports = { parseCrossAppTokens, resolveCrossAppOwner };
