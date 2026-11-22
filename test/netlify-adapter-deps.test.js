'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('Netlify adapter dependencies are declared at the repository base', () => {
  assert.equal(
    pkg.dependencies && pkg.dependencies['serverless-http'],
    '^4.0.0',
    'use the maintained serverless-http Express adapter'
  );
  assert.equal(
    pkg.dependencies && pkg.dependencies['@netlify/aws-lambda-compat'],
    '^2.0.4',
    'use Netlify official Lambda-signature compatibility wrapper'
  );
});

test('TOML config tests have an explicit parser dependency', () => {
  assert.equal(
    pkg.devDependencies && pkg.devDependencies['smol-toml'],
    '^1.9.1',
    'netlify.toml must be parsed, not regex-guessed'
  );
});
