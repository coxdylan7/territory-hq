'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, readdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const root = path.join(__dirname, '..');
let parse;
test.before(async () => {
  ({ parse } = await import('smol-toml'));
});

const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const { CONTENT_SECURITY_POLICY } = require('../api/src/security-headers');

const sites = [
  {
    name: 'HQ',
    config: 'netlify.toml',
    publish: 'web/dist',
    functionsDir: 'netlify/functions',
    functionName: 'hq-api',
    buildMarkers: ['npm --prefix api install', 'npm --prefix web install', 'npm --prefix web run build'],
  },
  {
    name: 'Portal',
    config: 'portal/netlify.toml',
    publish: 'portal/web/dist',
    functionsDir: 'portal/netlify/functions',
    functionName: 'portal-api',
    buildMarkers: ['npm --prefix portal/api install', 'npm --prefix portal/web install', 'npm --prefix portal/web run build'],
  },
];

function loaded(site) {
  return parse(read(site.config));
}

test('each site parses with correct base-relative build, publish and function paths', () => {
  for (const site of sites) {
    const config = loaded(site);
    assert.equal(config.build.publish, site.publish, site.name);
    assert.equal(config.functions.directory, site.functionsDir, site.name);
    for (const marker of site.buildMarkers) {
      assert.match(config.build.command, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${site.name}: ${marker}`);
    }
    assert.ok(existsSync(path.join(root, site.functionsDir)), `${site.name}: functions directory exists`);
    assert.ok(
      readdirSync(path.join(root, site.functionsDir)).some((f) => f.startsWith(site.functionName + '.')),
      `${site.name}: function entrypoint exists`
    );
    assert.equal(String(config.build.environment.NODE_VERSION).startsWith('22.'), true, `${site.name}: Node 22+ runtime`);
  }
});

test('API redirects precede the SPA fallback and cannot serve index.html', () => {
  for (const site of sites) {
    const redirects = loaded(site).redirects;
    assert.ok(Array.isArray(redirects) && redirects.length >= 3, site.name);

    const apiRedirects = redirects.slice(0, 2);
    assert.deepEqual(apiRedirects.map((r) => r.from), ['/api', '/api/*'], `${site.name}: API rules are first`);
    for (const rule of apiRedirects) {
      assert.equal(rule.to, `/.netlify/functions/${site.functionName}`, site.name);
      assert.equal(rule.status, 200, `${site.name}: rewrite, not HTTP redirect`);
      assert.equal(rule.force, true, `${site.name}: API path wins over static files`);
    }

    const spa = redirects[2];
    assert.deepEqual({ from: spa.from, to: spa.to, status: spa.status }, {
      from: '/*', to: '/index.html', status: 200,
    }, `${site.name}: SPA fallback follows API rules`);

    const laterApiRule = redirects.slice(2).find((r) => r.from.startsWith('/api'));
    assert.equal(laterApiRule, undefined, `${site.name}: no later /api rule can override the function`);
  }
});

test('static headers are hardened and match the shared Express policy', () => {
  for (const site of sites) {
    const headers = loaded(site).headers;
    assert.ok(Array.isArray(headers), site.name);
    const all = headers.find((h) => h.for === '/*');
    assert.ok(all, `${site.name}: global header rule`);
    const values = all.values;

    assert.equal(values['Content-Security-Policy'], CONTENT_SECURITY_POLICY, `${site.name}: CSP parity`);
    assert.equal(values['X-Frame-Options'], 'DENY', site.name);
    assert.equal(values['X-Content-Type-Options'], 'nosniff', site.name);
    assert.equal(values['Referrer-Policy'], 'no-referrer', site.name);
    assert.match(values['Strict-Transport-Security'], /max-age=31536000; includeSubDomains/, site.name);
    assert.equal(values['Permissions-Policy'], 'camera=(), microphone=(), geolocation=(), payment=()', site.name);

    const headersFile = read(path.join(site.publish, '_headers'));
    assert.match(headersFile, /X-Frame-Options: DENY/, site.name);
    assert.ok(headersFile.includes(CONTENT_SECURITY_POLICY), `${site.name}: _headers CSP parity`);
  }
});

test('function source is outside the published directory', () => {
  for (const site of sites) {
    const publishFiles = readdirSync(path.join(root, site.publish));
    assert.equal(publishFiles.some((f) => f.includes(site.functionName)), false, site.name);
  }
});
