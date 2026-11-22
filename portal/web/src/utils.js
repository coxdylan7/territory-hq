export function todayStr() { return new Date().toISOString().slice(0, 10); }

// Mirror the API's cent-based quote math. Decimal rates and durations must be
// converted to integer cents before rounding the extra-hour charge, otherwise
// the preview can disagree with the server's authoritative validation.
function creditCents(value) {
  const text = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) return 0;
  return Math.round(Number(text) * 100);
}

export function creditEstimate(et, hours) {
  if (!et) return 0;
  const h = Math.max(0, creditCents(hours));
  const baseH = Math.max(0, creditCents(et.baseHours));
  const baseCredits = Math.max(0, creditCents(et.basePriceCredits));
  const extraRate = Math.max(0, creditCents(et.extraHourCredits));
  const extraCredits = Math.round((Math.max(0, h - baseH) * extraRate) / 100);
  return (baseCredits + extraCredits) / 100;
}

export function fmtCredits(n) {
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(d) {
  if (!d) return '';
  const x = new Date(d + 'T12:00:00');
  return x.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtMoney(n) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}