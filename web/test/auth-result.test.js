import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applySignupResult } from '../src/auth-result.js';

test('pending signup shows the approval state without calling signIn or init', () => {
  const calls = [];
  const result = applySignupResult(
    { ok: true, pending: true },
    {
      signIn: (user) => calls.push(['signIn', user]),
      pending: () => calls.push(['pending']),
    },
  );
  assert.equal(result, 'pending');
  assert.deepEqual(calls, [['pending']]);
});

test('an activated signup still signs in with the returned user', () => {
  const calls = [];
  const user = { id: 'u1', status: 'active' };
  const result = applySignupResult(
    { ok: true, user },
    {
      signIn: (value) => calls.push(['signIn', value]),
      pending: () => calls.push(['pending']),
    },
  );
  assert.equal(result, 'app');
  assert.deepEqual(calls, [['signIn', user]]);
});

test('AuthScreen delegates signup results to the tested helper', () => {
  const source = readFileSync(new URL('../src/components.jsx', import.meta.url), 'utf8');
  assert.match(source, /import\s+\{[^}]*applySignupResult[^}]*\}\s+from\s+['"]\.\/auth-result\.js['"]/);
  assert.match(source, /applySignupResult\(d,\s*\{/);
});
