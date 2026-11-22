'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const BASE = 'portal';
const configPath = path.join(BASE, 'netlify.toml');
const functionPath = path.join(BASE, 'netlify/functions/portal-api.mjs');

let parse;
test.before(async () => {
  ({ parse } = await import('smol-toml'));
});

test('Portal Git CI base is portal and its config is discovered there', () => {
  assert.ok(existsSync(path.join(root, BASE, 'netlify.toml')), 'portal/netlify.toml exists at the base');
  const config = parse(read(configPath));
  assert.equal(config.build.base, undefined, 'base is a Git CI site setting, not a TOML key');
  assert.doesNotMatch(read(configPath), /package directory/i, 'no package-directory workaround remains in the config');
  assert.doesNotMatch(read(configPath), /npm --prefix portal\//, 'no repository-root-relative build paths remain');
});

test('Portal build command, publish and functions paths are relative to the portal base', () => {
  const config = parse(read(configPath));
  assert.equal(
    config.build.command,
    'npm --prefix api install --no-audit --no-fund && npm --prefix web install --no-audit --no-fund && npm --prefix web run build'
  );
  assert.equal(config.build.publish, 'web/dist');
  assert.equal(config.functions.directory, 'netlify/functions');
  assert.ok(existsSync(path.join(root, BASE, config.build.publish, '_headers')));
  assert.ok(existsSync(path.join(root, BASE, config.functions.directory, 'portal-api.mjs')));
});

test('Portal redirects and security headers remain unchanged', () => {
  const hq = parse(read('netlify.toml'));
  const portal = parse(read(configPath));
  const shape = (functionName, redirects) => redirects.map(({ from, to, status, force }) => ({
    from,
    to: to.replace(`/.netlify/functions/${functionName}`, '/.netlify/functions/SITE_API'),
    status,
    force,
  }));
  assert.deepEqual(shape('portal-api', portal.redirects), shape('hq-api', hq.redirects));
  assert.deepEqual(portal.headers, hq.headers);
});

test('Portal function statically imports shared root code without duplicating the adapter', () => {
  const fnSource = read(functionPath);
  const adapterMatch = fnSource.match(/^import \{ makeLambdaHandler \} from '([^']+)';$/m);
  const serverMatch = fnSource.match(/^import server from '([^']+)';$/m);
  assert.ok(adapterMatch, 'portal function imports makeLambdaHandler');
  assert.ok(serverMatch, 'portal function imports the portal Express app');

  const fnDir = path.dirname(path.join(root, functionPath));
  const adapterAbs = path.resolve(fnDir, adapterMatch[1]);
  const serverAbs = path.resolve(fnDir, serverMatch[1]);
  assert.equal(adapterAbs, path.join(root, 'netlify/lib/api-adapter.mjs'), 'shared root adapter is imported from outside base');
  assert.equal(serverAbs, path.join(root, 'portal/api/src/server.js'), 'portal API is imported relative to base');
  assert.ok(existsSync(adapterAbs));
  assert.ok(existsSync(serverAbs));
  assert.equal(existsSync(path.join(root, BASE, 'netlify/lib')), false, 'no duplicated adapter inside the base');
  assert.doesNotMatch(fnSource, /missingFunctionEnv|SECURITY_HEADERS|function environment is not configured/);

  const adapterSource = readFileSync(adapterAbs, 'utf8');
  const securityMatch = adapterSource.match(/from '([^']+security-headers\.js)'/);
  assert.ok(securityMatch, 'shared adapter reuses the single security-header source');
  assert.ok(existsSync(path.resolve(path.dirname(adapterAbs), securityMatch[1])));
});

test('base package install supplies dependencies used by the shared root function graph', () => {
  const rootPkg = JSON.parse(read('package.json'));
  const apiPkg = JSON.parse(read('api/package.json'));
  const basePkg = JSON.parse(read(path.join(BASE, 'package.json')));
  for (const [dep, source] of [
    ['serverless-http', rootPkg],
    ['@netlify/aws-lambda-compat', rootPkg],
    ['postgres', apiPkg],
  ]) {
    assert.equal(basePkg.dependencies && basePkg.dependencies[dep], source.dependencies[dep], `${dep} declared at Portal base`);
  }
  const portalApiPkg = JSON.parse(read(path.join(BASE, 'api/package.json')));
  assert.equal(portalApiPkg.dependencies.postgres, apiPkg.dependencies.postgres);
  assert.equal(portalApiPkg.dependencies.express, apiPkg.dependencies.express);
});

test('shared adapter keeps its fail-closed gate when used by the Portal function name', async () => {
  const adapterAbs = path.join(root, 'netlify/lib/api-adapter.mjs');
  const { makeLambdaHandler } = await import(pathToFileURL(adapterAbs).href);
  let called = 0;
  const wrapped = makeLambdaHandler(async () => {
    called += 1;
    return { statusCode: 200, body: 'should not run' };
  }, 'portal-api', {});
  const res = await wrapped({ path: '/api/health', headers: {} }, { requestId: 'portal-red' });
  assert.equal(called, 0);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body).missing, ['DATABASE_URL', 'SKIP_SCHEMA', 'PUBLIC_ORIGIN', 'TRUST_PROXY']);
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
});
