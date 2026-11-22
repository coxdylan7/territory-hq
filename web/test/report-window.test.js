import test from 'node:test';
import assert from 'node:assert/strict';
import { openPrintWindow } from '../src/report-window.js';

function fakeChild(events) {
  const child = {
    opener: 'parent',
    document: {
      write(html) { events.push(['write', html, child.opener]); },
      close() { events.push(['close', child.opener]); },
    },
    focus() { events.push(['focus']); },
    print() { events.push(['print']); },
  };
  return child;
}

test('openPrintWindow opens exactly one writable about:blank window and clears opener before writing', () => {
  const events = [];
  const child = fakeChild(events);
  const opens = [];
  const win = {
    open(...args) {
      opens.push(args);
      return child;
    },
  };

  const schedulePrint = (fn) => fn();
  assert.equal(openPrintWindow('<h1>safe</h1>', win, { schedulePrint }), true);
  assert.equal(opens.length, 1, 'must never open a second window');
  assert.equal(opens[0][0], 'about:blank');
  assert.equal(opens[0][1], '_blank');
  assert.doesNotMatch(String(opens[0][2] || ''), /noopener|noreferrer/);
  assert.equal(child.opener, null);
  assert.deepEqual(events.slice(0, 2), [
    ['write', '<h1>safe</h1>', null],
    ['close', null],
  ]);
  assert.deepEqual(events.slice(2), [['focus'], ['print']]);
});

test('openPrintWindow does not retry when a browser returns no window handle', () => {
  const opens = [];
  const win = {
    open(...args) {
      opens.push(args);
      return null;
    },
  };

  assert.equal(openPrintWindow('<h1>safe</h1>', win, { schedulePrint() {} }), false);
  assert.equal(opens.length, 1, 'a null handle must not trigger a second popup');
});
