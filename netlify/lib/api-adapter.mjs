// Shared Netlify adapter helpers for the HQ and Portal Express APIs.
// Kept dependency-free so configuration/env behaviour can be tested without
// loading either Express app or opening a database connection.
import securityHeaders from '../../api/src/security-headers.js';

const { SECURITY_HEADERS } = securityHeaders;

const REQUIRED_KEYS = ['DATABASE_URL', 'SKIP_SCHEMA', 'PUBLIC_ORIGIN', 'TRUST_PROXY'];
const EXACT_ORIGIN = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/;

function isExactOrigin(raw) {
  return EXACT_ORIGIN.test(String(raw ?? '').trim().replace(/\/+$/, '').toLowerCase());
}

export function missingFunctionEnv(env = process.env) {
  const missing = [];
  if (!String(env.DATABASE_URL || '').trim()) missing.push('DATABASE_URL');
  if (String(env.SKIP_SCHEMA || '').trim() !== '1') missing.push('SKIP_SCHEMA');
  if (!isExactOrigin(env.PUBLIC_ORIGIN)) missing.push('PUBLIC_ORIGIN');
  if (String(env.TRUST_PROXY || '').trim() !== '1') missing.push('TRUST_PROXY');
  return missing;
}

export function normalizeApiPath(rawPath, functionName) {
  let pathname = String(rawPath || '').split('?')[0].split('#')[0];
  const functionPrefix = `/.netlify/functions/${functionName}`;
  if (pathname.startsWith(functionPrefix)) {
    pathname = pathname.slice(functionPrefix.length);
  }
  if (!pathname || pathname === '/') return '/api';
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  if (!pathname.startsWith('/api')) pathname = `/api${pathname}`;
  return pathname;
}

function configErrorResponse(missing) {
  return {
    statusCode: 503,
    headers: {
      ...Object.fromEntries(Object.entries(SECURITY_HEADERS).map(([name, value]) => [name.toLowerCase(), value])),
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({
      error: 'function environment is not configured',
      missing,
    }),
  };
}

export function makeLambdaHandler(handler, functionName, env = process.env) {
  return async function lambdaHandler(event, context) {
    const missing = missingFunctionEnv(env);
    if (missing.length) return configErrorResponse(missing);

    const incoming = event || {};
    const path = normalizeApiPath(incoming.path || incoming.rawPath, functionName);
    const normalized = {
      ...incoming,
      path,
      rawPath: path,
      httpMethod: String(incoming.httpMethod || 'GET').toUpperCase(),
    };
    return handler(normalized, context);
  };
}
