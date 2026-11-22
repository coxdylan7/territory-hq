const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../../..');
const readJson = (p) => JSON.parse(readFileSync(path.join(root, p), 'utf8'));

test('portal Dockerfile builds from the repository root and starts portal/api/src/server.js', () => {
  const dockerfile = readFileSync(path.join(root, 'portal/Dockerfile'), 'utf8');

  assert.match(dockerfile, /COPY portal\/api\/package\*\.json portal\/api\//);
  assert.match(dockerfile, /COPY portal\/web\/package\*\.json portal\/web\//);
  assert.match(dockerfile, /npm --prefix portal\/api install/);
  assert.match(dockerfile, /npm --prefix portal\/web install/);
  assert.match(dockerfile, /COPY portal\/api portal\/api/);
  assert.match(dockerfile, /COPY portal\/web portal\/web/);
  assert.match(dockerfile, /COPY api\/src api\/src/, 'shared security modules must be in the image');
  assert.match(dockerfile, /npm --prefix portal\/web run build/);
  assert.match(dockerfile, /CMD \["node", "portal\/api\/src\/server\.js"\]/);
});

test('portal package scripts point at existing source entrypoints', () => {
  assert.equal(readJson('portal/api/package.json').scripts.start, 'node src/server.js');
  assert.equal(readJson('portal/api/package.json').scripts.dev, 'node --watch src/server.js');
  assert.equal(readJson('portal/package.json').scripts.start, 'node api/src/server.js');
});
