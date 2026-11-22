const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('legacy public report app is retired in favor of the active Vite app', () => {
  assert.equal(fs.existsSync(path.join(root, 'public/index.html')), false,
    'public/index.html must be removed so its unescaped export cannot be deployed');
  assert.match(read('README.md'), /legacy public\/index\.html retired/i);
});

test('retired Netlify API paths stay absent while current Netlify hosting is allowed', () => {
  // The old, direct-browser Supabase API is still forbidden. The two new
  // first-party Netlify Function adapters are added under netlify/ and
  // portal/netlify/ and are intentionally allowed by this migration.
  for (const p of ['reference/netlify.toml', 'reference/netlify/functions/api.js']) {
    assert.equal(fs.existsSync(path.join(root, p)), false, `${p} must stay deleted`);
  }

  // Local/Docker operation continues to start the same Express apps directly.
  for (const file of ['Dockerfile', 'portal/Dockerfile']) {
    assert.match(read(file), /CMD \["node", "[^"]+server\.js"\]/, `${file} must still start an Express API`);
  }
});

test('deployment docs keep requiring exact origin configuration', () => {
  const docs = read('README.md');
  assert.match(docs, /PUBLIC_ORIGIN/);
});
