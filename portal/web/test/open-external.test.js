import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openExternal } from '../src/open-external.js';

test('openExternal opens one isolated window with noopener and noreferrer', () => {
  const opens = [];
  const child = { opener: 'parent' };
  const win = {
    open(...args) {
      opens.push(args);
      return child;
    },
  };

  assert.equal(openExternal('https://www.google.com/maps/search/?api=1&query=1%2C+2', win), child);
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0], [
    'https://www.google.com/maps/search/?api=1&query=1%2C+2',
    '_blank',
    'noopener,noreferrer',
  ]);
  assert.equal(child.opener, null);
});

test('portal App uses the tested opener helper for Google Maps', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /import\s+\{\s*openExternal\s*\}\s+from\s+['"]\.\/open-external\.js['"]/);
  assert.doesNotMatch(source, /window\.open\(\s*['"]https:\/\/www\.google\.com\/maps/);
});
