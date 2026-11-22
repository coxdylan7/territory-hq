import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creditEstimate, fmtCredits } from '../src/utils.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = require('../../../api/src/booking-service.js');
const app = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8');

const cases = [
  { baseHours: '2', basePriceCredits: '10', extraHourCredits: '0.5', hours: '3.5' },
  { baseHours: '1.5', basePriceCredits: '10', extraHourCredits: '0.5', hours: '2.25' },
  { baseHours: '2', basePriceCredits: '10.25', extraHourCredits: '0.49', hours: '4.1' },
  { baseHours: '2', basePriceCredits: '10', extraHourCredits: '0.5', hours: '2' },
];

for (const item of cases) {
  test(`portal preview matches server cent rounding for ${JSON.stringify(item)}`, () => {
    const serverEventType = {
      base_hours: item.baseHours,
      base_price_credits: item.basePriceCredits,
      extra_hour_credits: item.extraHourCredits,
    };
    const clientEventType = {
      baseHours: item.baseHours,
      basePriceCredits: item.basePriceCredits,
      extraHourCredits: item.extraHourCredits,
    };
    const authoritative = Number(server.computeQuote(serverEventType, item.hours).quotedCredits);
    assert.equal(creditEstimate(clientEventType, item.hours), authoritative);
  });
}

test('quote preview renders exact cents rather than an integer-rounded estimate', () => {
  assert.match(fmtCredits(10.75), /10\.75/);
  assert.match(app, /fmtCredits\(cost\)/);
});
