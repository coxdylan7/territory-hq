const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  securityHeadersMiddleware,
} = require('../src/security-headers');

function directive(name) {
  const found = CONTENT_SECURITY_POLICY.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + ' '));
  return found ? found.slice(name.length + 1).trim() : '';
}

test('CSP allows the app, Leaflet, Google Maps, fonts and API calls but blocks plugins and framing', () => {
  assert.match(directive('default-src'), /^'self'$/);
  assert.match(directive('script-src'), /'self'/);
  assert.match(directive('script-src'), /maps\.googleapis\.com/);
  assert.doesNotMatch(directive('script-src'), /unsafe-inline|unsafe-eval/);
  assert.match(directive('style-src'), /'unsafe-inline'/, 'React inline styles are required');
  assert.match(directive('style-src'), /fonts\.googleapis\.com/);
  assert.match(directive('img-src'), /tile\.openstreetmap\.org/);
  assert.match(directive('img-src'), /maps\.gstatic\.com/);
  assert.match(directive('font-src'), /fonts\.gstatic\.com/);
  assert.match(directive('connect-src'), /'self'/);
  assert.match(directive('connect-src'), /data\.ny\.gov/);
  assert.match(directive('connect-src'), /nominatim\.openstreetmap\.org/);
  assert.match(directive('connect-src'), /router\.project-osrm\.org/);
  assert.equal(directive('object-src'), "'none'");
  assert.equal(directive('frame-ancestors'), "'none'");
  assert.equal(directive('base-uri'), "'self'");
  assert.equal(directive('form-action'), "'self'");
});

test('supporting headers are set on every response by middleware', () => {
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
  assert.match(SECURITY_HEADERS['Strict-Transport-Security'], /max-age=\d+/);
  assert.match(SECURITY_HEADERS['Permissions-Policy'], /geolocation=\(\)/);

  const applied = {};
  const res = { setHeader(name, value) { applied[name.toLowerCase()] = value; } };
  let nextCalled = false;
  securityHeadersMiddleware()({}, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(applied['content-security-policy'], CONTENT_SECURITY_POLICY);
  assert.equal(applied['x-content-type-options'], 'nosniff');
  assert.equal(applied['x-frame-options'], 'DENY');
});

test('Vite HTML carries the same CSP as the API and needs no inline scripts', () => {
  for (const file of ['web/index.html', 'portal/web/index.html']) {
    const html = readFileSync(path.join(__dirname, '../..', file), 'utf8');
    const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/i);
    assert.ok(meta, `${file} needs a CSP meta fallback for static hosting`);
    assert.equal(meta[1], CONTENT_SECURITY_POLICY);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} must not use inline scripts`);
  }
});

test('static Vite deployments ship host header configuration with framing defenses', () => {
  for (const file of ['web/public/_headers', 'portal/web/public/_headers']) {
    const headers = readFileSync(path.join(__dirname, '../..', file), 'utf8');
    assert.match(headers, /^\/\*/m, `${file} must apply headers to every path`);
    assert.ok(headers.includes(`Content-Security-Policy: ${CONTENT_SECURITY_POLICY}`),
      `${file} must configure the complete HTTP CSP`);
    assert.match(headers, /^\s*X-Frame-Options:\s*DENY\s*$/mi, `${file} must configure X-Frame-Options`);
  }

  const docs = readFileSync(path.join(__dirname, '../../README.md'), 'utf8');
  assert.match(docs, /meta CSP cannot enforce `frame-ancestors`/i);
  assert.match(docs, /web\/public\/_headers/);
  assert.match(docs, /portal\/web\/public\/_headers/);
});
