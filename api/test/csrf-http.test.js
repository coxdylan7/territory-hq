const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { csrfMiddleware } = require('../src/csrf');
const { CONTENT_SECURITY_POLICY, securityHeadersMiddleware } = require('../src/security-headers');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('HTTP mutations fail closed for credentialed browser requests but allow non-browser clients', async () => {
  const app = express();
  app.use(securityHeadersMiddleware());
  app.use(csrfMiddleware({
    PUBLIC_ORIGIN: '',
    FIRST_PARTY_ORIGINS: '',
    ALLOWED_ORIGINS: '',
  }));
  app.post('/api/mutate', (req, res) => res.json({ ok: true }));
  app.get('/api/read', (req, res) => res.json({ ok: true }));

  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = 'thq_session=test-session';
  try {
    const missingOrigin = await fetch(`${base}/api/mutate`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(missingOrigin.status, 403);
    assert.deepEqual(await missingOrigin.json(), { error: 'cross-origin request blocked' });
    assert.equal(missingOrigin.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
    assert.equal(missingOrigin.headers.get('x-content-type-options'), 'nosniff');

    const nullOrigin = await fetch(`${base}/api/mutate`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'null' },
    });
    assert.equal(nullOrigin.status, 403);

    const crossOrigin = await fetch(`${base}/api/mutate`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.example' },
    });
    assert.equal(crossOrigin.status, 403);

    const crossSiteFetch = await fetch(`${base}/api/mutate`, {
      method: 'POST',
      headers: { Origin: base, 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSiteFetch.status, 403);

    const browserWithoutOrigin = await fetch(`${base}/api/mutate`, {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(browserWithoutOrigin.status, 403);

    const sameOrigin = await fetch(`${base}/api/mutate`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: base, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(sameOrigin.status, 200);
    assert.deepEqual(await sameOrigin.json(), { ok: true });

    const nonBrowser = await fetch(`${base}/api/mutate`, { method: 'POST' });
    assert.equal(nonBrowser.status, 200, 'a client without Origin or browser metadata is non-browser');

    const crossGet = await fetch(`${base}/api/read`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(crossGet.status, 200, 'cross-app GET remains available under its own bearer scope');
  } finally {
    await close(server);
  }
});
