export function todayStr() { return new Date().toISOString().slice(0, 10); }

export function creditEstimate(et, hours) {
  if (!et) return 0;
  const h = Math.max(0, Number(hours) || 0);
  const baseH = Number(et.baseHours) || 0;
  return Math.round((Number(et.basePriceCredits) || 0) + Math.max(0, h - baseH) * (Number(et.extraHourCredits) || 0));
}

export function fmtDate(d) {
  if (!d) return '';
  const x = new Date(d + 'T12:00:00');
  return x.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtMoney(n) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}