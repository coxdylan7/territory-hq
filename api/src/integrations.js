// Twilio SMS + Anthropic proxy — ports of the original integrations
const crypto = require('crypto');

/* ---------------- Twilio (optional) ---------------- */
function smsConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}
async function sendSmsTwilio(to, bodyText) {
  if (!smsConfigured()) return { sent: false, reason: 'not_configured' };
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM_NUMBER;
  const auth = Buffer.from(sid + ':' + token).toString('base64');
  const params = new URLSearchParams({ To: to, From: from, Body: bodyText });
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    if (!res.ok) return { sent: false, reason: data.message || ('http ' + res.status) };
    return { sent: true, sid: data.sid };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

/* ---------------- Anthropic proxy ---------------- */
async function proxyAnthropic(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { content: [{ type: 'text', text: '(No ANTHROPIC_API_KEY configured on this site.)' }] };
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
  });
  return await res.json();
}

module.exports = { smsConfigured, sendSmsTwilio, proxyAnthropic };