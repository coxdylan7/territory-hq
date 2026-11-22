'use strict';

// Single source of truth for both the HQ API and the HQ browser client.
// The server enforces the cap; the client only uses it to pre-chunk a large
// selection so that no request is rejected for being oversize.
const BLAST_LIMITS = Object.freeze({
  maxRecipients: 10,
  concurrency: 5,
  twilioTimeoutMs: 8000,
  netlifySyncLimitMs: 60000,
  requiredHeadroomMs: 12000,
});

// Recipients run in fixed-size waves. Every Twilio attempt is aborted after
// twilioTimeoutMs, so this is the deterministic send-side wall-clock bound.
function worstCaseBlastDurationMs(limits = BLAST_LIMITS) {
  const waves = Math.ceil(limits.maxRecipients / limits.concurrency);
  return waves * limits.twilioTimeoutMs;
}

module.exports = { BLAST_LIMITS, worstCaseBlastDurationMs };
