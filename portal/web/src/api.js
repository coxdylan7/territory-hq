const KEY = 'tp_session';
let AUTH_TOKEN = (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) || '';

export function getToken() { return AUTH_TOKEN; }
export function setToken(t) { AUTH_TOKEN = t; try { localStorage.setItem(KEY, t); } catch (e) {} }
export function clearToken() { AUTH_TOKEN = ''; try { localStorage.removeItem(KEY); } catch (e) {} }

function authHeaders() {
  return AUTH_TOKEN ? { Authorization: 'Bearer ' + AUTH_TOKEN } : {};
}

export async function apiFetch(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });
  if (r.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('tp:unauthorized'));
    throw new Error('unauthorized');
  }
  if (!r.ok) {
    let msg = (opts.method || 'GET') + ' ' + path + ' failed (' + r.status + ')';
    try { const d = await r.json(); if (d && d.error) msg += ': ' + d.error; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  get: (p) => apiFetch(p),
  post: (p, b) => apiFetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }),
  put: (p, b) => apiFetch(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }),
  del: (p) => apiFetch(p, { method: 'DELETE' }),
};