'use strict';

// Netlify bundles each function from its site base, but bare modules are
// externalized at runtime. A dependency merely installed under api/ is not
// enough: it must be declared and installed at the base that packages the
// function. This test walks each real function graph and resolves every bare
// module from that base, then checks the base manifest and lockfile agree.
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { createRequire, isBuiltin } = require('node:module');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const apiPkg = readJson(path.join(root, 'api/package.json'));
const rootPkg = readJson(path.join(root, 'package.json'));

const canonicalVersions = {
  '@netlify/aws-lambda-compat': rootPkg.dependencies['@netlify/aws-lambda-compat'],
  'serverless-http': rootPkg.dependencies['serverless-http'],
  express: apiPkg.dependencies.express,
  postgres: apiPkg.dependencies.postgres,
};

const sites = [
  {
    name: 'HQ',
    base: root,
    function: path.join(root, 'netlify/functions/hq-api.mjs'),
  },
  {
    name: 'Portal',
    base: path.join(root, 'portal'),
    function: path.join(root, 'portal/netlify/functions/portal-api.mjs'),
  },
];

const specifierPatterns = [
  /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function localModule(file, specifier) {
  const absolute = path.resolve(path.dirname(file), specifier);
  const candidates = [
    absolute,
    `${absolute}.js`,
    `${absolute}.mjs`,
    `${absolute}.cjs`,
    `${absolute}.json`,
    path.join(absolute, 'index.js'),
    path.join(absolute, 'index.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && require('node:fs').statSync(candidate).isFile());
}

function externalDependencies(entrypoint) {
  const external = new Set();
  const visited = new Set();
  const pending = [entrypoint];

  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, 'utf8');
    for (const pattern of specifierPatterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier || isBuiltin(specifier)) continue;
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          const local = localModule(file, specifier);
          assert.ok(local, `cannot follow local import ${specifier} from ${path.relative(root, file)}`);
          pending.push(local);
          continue;
        }
        if (specifier.startsWith('/') || /^[a-z]+:/i.test(specifier)) continue;
        external.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
      }
    }
  }

  return { external, visited };
}

for (const site of sites) {
  test(`${site.name} function runtime dependencies are declared and installed at its Netlify base`, () => {
    const { external, visited } = externalDependencies(site.function);
    assert.deepEqual(
      [...external].sort(),
      Object.keys(canonicalVersions).sort(),
      `${site.name}: walk the complete bundled graph from ${path.relative(root, site.function)} (${visited.size} local modules)`
    );

    const baseRequire = createRequire(path.join(site.base, 'package.json'));
    const basePkg = readJson(path.join(site.base, 'package.json'));
    const baseLock = path.join(site.base, 'package-lock.json');
    assert.ok(existsSync(baseLock), `${site.name}: ${path.relative(root, baseLock)} exists`);
    const lock = readJson(baseLock);

    for (const dep of [...external].sort()) {
      assert.equal(
        basePkg.dependencies && basePkg.dependencies[dep],
        canonicalVersions[dep],
        `${site.name}: ${dep} is declared at the base at the same version as the API package`
      );
      assert.equal(
        lock.packages && lock.packages[''] && lock.packages[''].dependencies && lock.packages[''].dependencies[dep],
        canonicalVersions[dep],
        `${site.name}: base lockfile declares ${dep}`
      );
      assert.ok(
        lock.packages && lock.packages[`node_modules/${dep}`],
        `${site.name}: base lockfile installs node_modules/${dep}`
      );
      assert.doesNotThrow(
        () => baseRequire.resolve(dep),
        `${site.name}: ${dep} resolves from ${path.relative(root, site.base) || '.'}, not only from api/node_modules`
      );
    }
  });
}
