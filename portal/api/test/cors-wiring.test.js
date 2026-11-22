const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

test('portal API uses exact CORS and explicit trust-proxy configuration', () => {
  const src = readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(src, /require\('\.\.\/\.\.\/\.\.\/api\/src\/cors'\)/);
  assert.match(src, /require\('\.\.\/\.\.\/\.\.\/api\/src\/trust-proxy'\)/);
  assert.match(src, /app\.set\('trust proxy', trustProxySetting\(process\.env\.TRUST_PROXY\)\)/);
  assert.match(src, /app\.use\(corsMiddleware\(\)\)/);
});
