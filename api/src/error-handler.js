const { json } = require('./helpers');

// Express requires a four-argument middleware signature to treat this as an
// error handler. Unexpected errors are logged with details server-side; clients
// only receive a generic message so stack traces and internals never leak.
function makeErrorHandler(logger = console) {
  return function handleError(err, req, res, next) {
    if (err && err.type === 'entity.parse.failed') {
      return json(res, { error: 'invalid JSON body' }, 400);
    }
    logger.error('API ERROR:', err && err.stack ? err.stack : err);
    return json(res, { error: 'Internal error' }, 500);
  };
}

// Handler-local catch branches use this so 5xx bodies are identical to the
// middleware's, while the original error (including its stack) is still logged.
function internalError(context, err, logger = console) {
  logger.error(`${context} failed:`, err && err.stack ? err.stack : err);
  return { error: 'Internal error' };
}

module.exports = { makeErrorHandler, internalError };
