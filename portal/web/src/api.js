// First-party portal sessions are HttpOnly cookies set by the portal API.
// No token is stored in the browser or read from JSON responses.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function newIdempotencyKey() {
  const browserCrypto = globalThis.crypto;
  if (browserCrypto && typeof browserCrypto.randomUUID === 'function') {
    return browserCrypto.randomUUID();
  }
  if (browserCrypto && typeof browserCrypto.getRandomValues === 'function') {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error('crypto.randomUUID is unavailable');
}

export class ApiError extends Error {
  constructor(message, { status, code, details, replayed }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.replayed = replayed;
  }
}

function errorDetails(data, status) {
  const body = data && typeof data === 'object' ? data : {};
  return {
    error: body.error || ('request failed (' + status + ')'),
    code: body.code || 'REQUEST_FAILED',
    details: body.details,
  };
}

async function readJson(response) {
  try { return await response.json(); } catch (e) { return null; }
}

export async function apiFetch(path, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const idempotent = Boolean(opts.idempotent && MUTATING_METHODS.has(method));
  const key = opts.idempotencyKey || (idempotent ? newIdempotencyKey() : null);
  const attempts = idempotent ? Math.max(1, Number(opts.retries) || 2) : 1;
  let transportError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const headers = { ...(opts.headers || {}) };
    if (key) headers['Idempotency-Key'] = key;
    let r;
    try {
      r = await fetch(path, { ...opts, credentials: 'include', headers });
    } catch (error) {
      transportError = error;
      if (idempotent && attempt < attempts) continue;
      throw error;
    }

    if (r.status === 401) {
      if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new Event('tp:unauthorized'));
      throw new ApiError('unauthorized', { status: 401, code: 'UNAUTHORIZED' });
    }
    if (!r.ok) {
      const data = await readJson(r);
      const info = errorDetails(data, r.status);
      const message = method + ' ' + path + ' failed (' + r.status + '): ' + info.error;
      if (idempotent && r.status >= 500 && attempt < attempts) continue;
      throw new ApiError(message, {
        status: r.status,
        code: info.code,
        details: info.details,
        replayed: r.headers && typeof r.headers.get === 'function' && r.headers.get('Idempotency-Replayed') === 'true',
      });
    }
    return readJson(r);
  }
  throw transportError || new Error('request failed');
}

function request(method, path, body, opts = {}) {
  const fetchOptions = { method, ...opts };
  if (body !== undefined) {
    fetchOptions.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    fetchOptions.body = JSON.stringify(body);
  }
  return apiFetch(path, fetchOptions);
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b, o) => request('POST', p, b, o),
  put: (p, b, o) => request('PUT', p, b, o),
  del: (p, o) => request('DELETE', p, undefined, o),
  action: (method, p, b, o = {}) => request(String(method).toUpperCase(), p, b, { ...o, idempotent: true }),
};
