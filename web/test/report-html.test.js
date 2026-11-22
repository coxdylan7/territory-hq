import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeHtml, buildReportHtml } from '../src/report-html.js';

test('escapeHtml neutralizes HTML metacharacters in untrusted values', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml(`a & b ' c " d < e > f`), 'a &amp; b &#39; c &quot; d &lt; e &gt; f');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('buildReportHtml escapes account, credit, message, OCM, note and category data', () => {
  const pwn = '"><img src=x onerror=alert(1)>';
  const html = buildReportHtml({
    label: pwn,
    period: pwn,
    startStr: '2026-01-01',
    endStr: '2026-02-01',
    generated: '1/1/2026',
    kpis: [[pwn, 'Routes run'], [7, 'Visits']],
    tables: [
      { title: 'Expenses by category', rows: [[pwn, '$1.00']], valueRight: true },
      { title: 'Accounts by status', rows: [[pwn, 3]], valueRight: true, total: 4 },
      {
        title: 'Routes completed',
        header: ['Date', 'Day', 'Stops', 'Miles'],
        rows: [['2026-01-02', 'Fri', pwn, '2.0']],
        lastRight: true,
      },
      {
        title: 'Credits issued',
        header: ['Date', 'Client', 'Amount', 'Reason'],
        rows: [['2026-01-02', pwn, 10, pwn]],
        amountRight: true,
      },
      {
        title: 'Messages sent',
        header: ['Date', 'Client', 'Channel', 'Message'],
        rows: [['2026-01-02', pwn, 'text', pwn]],
      },
      {
        title: 'New OCM stores opened',
        header: ['Name', 'County', 'Opened'],
        rows: [[pwn, 'Albany', '2026-01-02']],
      },
      {
        title: 'Most neglected accounts',
        header: ['Name', 'Status', 'Last visit'],
        rows: [[pwn, pwn, 'Never']],
      },
    ],
  });

  assert.ok(!html.includes(pwn), 'raw attacker payload leaked into report HTML');
  assert.ok(!html.includes('<img'), 'an attacker-controlled element became a real tag');
  assert.ok(!html.includes('<script'), 'report HTML needs no scripts: printing is triggered by the opener');
  assert.equal(html.split('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;').length - 1, 14,
    'every injected field should appear escaped');
  assert.match(html, /\.total td\{font-weight:700;\}/);
  assert.match(html, /<td>Total<\/td><td style="text-align:right">4<\/td>/);
});

test('Reports export delegates markup and window handling to the tested helpers', () => {
  const src = readFileSync(new URL('../src/tabs/Reports.jsx', import.meta.url), 'utf8');
  assert.match(src, /buildReportHtml/);
  assert.match(src, /openPrintWindow/);
  assert.doesNotMatch(src, /document\.write/);
  assert.doesNotMatch(src, /window\.open/);
  assert.match(src, /openPrintWindow\(html\)/);
});
