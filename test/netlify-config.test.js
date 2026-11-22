'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
let parse;
test.before(async () => {
  ({ parse } = await import('smol-toml'));
});

const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const { CONTENT_SECURITY_POLICY } = require('../api/src/security-headers');

// Base directory is a Git CI site setting, not a TOML key. HQ builds from the
// repository root; Portal builds from `portal`. Every path below is relative
// to that base, which is where Netlify runs the build command.
const sites = [
  {
    name: 'HQ',
    base: '',
    config: 'netlify.toml',
    publish: 'web/dist',
    functionsDir: 'netlify/functions',
    functionName: 'hq-api',
    buildCommand: 'npm --prefix api install --no-audit --no-fund && npm --prefix web install --no-audit --no-fund && npm --prefix web run build',
  },
  {
    name: 'Portal',
    base: 'portal',
    config: 'portal/netlify.toml',
    publish: 'web/dist',
    functionsDir: 'netlify/functions',
    functionName: 'portal-api',
    buildCommand: 'npm --prefix api install --no-audit --no-fund && npm --prefix web install --no-audit --no-fund && npm --prefix web run build',
  },
];

const fromBase = (site, relative) => path.join(root, site.base, relative);
const repoPath = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
const loaded = (site) => parse(read(site.config));

test('each netlify.toml is discovered at its Git CI base and uses base-relative paths', () => {
  for (const site of sites) {
    assert.ok(existsSync(path.join(root, site.base, 'netlify.toml')), `${site.name}: config at base`);
    const config = loaded(site);
    assert.equal(config.build.base, undefined, `${site.name}: base is selected in Git CI, not TOML`);
    assert.equal(config.build.command, site.buildCommand, `${site.name}: build command runs at base`);
    assert.equal(config.build.publish, site.publish, `${site.name}: publish is relative to base`);
    assert.equal(config.functions.directory, site.functionsDir, `${site.name}: functions are relative to base`);
    assert.ok(existsSync(fromBase(site, site.functionsDir)), `${site.name}: functions directory exists at base`);
    assert.ok(
      readdirSync(fromBase(site, site.functionsDir)).some((f) => f.startsWith(site.functionName + '.')),
      `${site.name}: function entrypoint exists at base`
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

    const headersFile = read(repoPath(fromBase(site, path.join(site.publish, '_headers'))));
    assert.match(headersFile, /X-Frame-Options: DENY/, site.name);
    assert.ok(headersFile.includes(CONTENT_SECURITY_POLICY), `${site.name}: _headers CSP parity`);
  }
});

test('function source is outside the published directory', () => {
  for (const site of sites) {
    const publishFiles = readdirSync(fromBase(site, site.publish));
    assert.equal(publishFiles.some((f) => f.includes(site.functionName)), false, site.name);
  }
});
