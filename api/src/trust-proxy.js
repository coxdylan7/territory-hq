// Express uses this setting to decide whether x-forwarded-proto/host may be
// trusted. No value means no forwarded headers are trusted; an operator must
// opt in with a hop count or an explicit proxy address list.
function trustProxySetting(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  if (text === 'true' || text === '1') return 1;
  if (/^\d+$/.test(text)) return Number(text);

  const entries = text.split(',').map((value) => value.trim()).filter(Boolean);
  if (!entries.length) return false;
  const valid = entries.every((entry) => /^\d+$/.test(entry)
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(entry));
  return valid ? entries : false;
}

module.exports = { trustProxySetting };
