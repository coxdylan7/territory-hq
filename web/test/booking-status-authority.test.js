import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/tabs/Bookings.jsx'), 'utf8');

test('HQ treats server status as authoritative and never fabricates completion', () => {
  assert.doesNotMatch(source, /status:\s*'completed'/);
  assert.doesNotMatch(source, /b\.date\s*<\s*today\s*\?\s*\{\s*\.\.\.b/);
  assert.match(source, /const rows = \[\.\.\.st\.bookings\]/);
  assert.match(source, /const archive = rows\.filter/);
});

test('HQ has no client completion command', () => {
  assert.doesNotMatch(source, /\/complete['"]/);
});
