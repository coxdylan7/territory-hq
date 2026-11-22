const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const trackedFiles = () => execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

test('legacy public report app is retired in favor of the active Vite app', () => {
  assert.equal(fs.existsSync(path.join(root, 'public/index.html')), false,
    'public/index.html must be removed so its unescaped export cannot be deployed');
  assert.match(read('README.md'), /legacy public\/index\.html retired/i);
});

test('no tracked legacy Netlify API or deployment config remains', () => {
  const trackedLegacy = trackedFiles().filter((f) => /netlify/i.test(f));
  assert.deepEqual(trackedLegacy, [], 'the legacy Netlify function and config must be removed from the index');
  for (const p of ['reference/netlify.toml', 'reference/netlify/functions/api.js']) {
    assert.equal(fs.existsSync(path.join(root, p)), false, `${p} must be deleted from disk`);
  }
});

test('no retained config, docs or Vite client source routes to the retired serverless API', () => {
  const deploySurfaces = trackedFiles().filter((f) =>
    !f.includes('/test/') && !f.endsWith('.pdf') && !f.endsWith('package-lock.json'));
  for (const file of deploySurfaces) {
    assert.equal(/netlify/i.test(read(file)), false, `${file} still refers to the retired serverless API`);
  }

  const docs = read('README.md');
  assert.match(docs, /external compatible Express API/i, 'docs must require an external Express API for static hosting');
  assert.match(docs, /PUBLIC_ORIGIN/, 'docs must require exact cookie/CORS configuration for static hosting');

  for (const file of ['Dockerfile', 'portal/Dockerfile']) {
    assert.match(read(file), /CMD \["node", "[^"]+server\.js"\]/, `${file} must still start an Express API`);
  }
});
