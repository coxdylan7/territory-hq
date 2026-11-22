'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendSmsTwilio } = require('../src/integrations');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
};

function restore() {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('a Twilio request is aborted with a machine-readable timeout result', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  process.env.TWILIO_FROM_NUMBER = '+15550000000';

  let observedSignal;
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    observedSignal = options.signal;
    if (!observedSignal) return;
    observedSignal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  try {
    const result = await Promise.race([
      sendSmsTwilio('+15551234567', 'hello', { timeoutMs: 20 }),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('Twilio call was not bounded')), 1000);
      }),
    ]);

    assert.equal(result.sent, false);
    assert.match(result.reason, /timeout/i);
    assert.equal(observedSignal && observedSignal.aborted, true);
  } finally {
    restore();
  }
});
