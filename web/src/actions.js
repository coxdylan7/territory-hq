// Cross-tab data actions — ports of helpers from the original single-file app.
import { api } from './api';
import { useStore } from './store';
import { currentWeekKey, geocode, daysSince, haversineMiles } from './utils';

export function creditBalance(state, accountId) {
  return state.credits.filter((c) => c.accountId === accountId).reduce((s, c) => s + Number(c.amount || 0), 0);
}

export function creditEmail(entry, balance) {
  const settings = useStore.getState().settings;
  const to = settings.alertEmail || '(set marketing email in Settings)';
  return `To: ${to}
Subject: Credits added — ${entry.accountName}

${entry.amount} credits were added to ${entry.accountName}${entry.city ? ` (${entry.city})` : ''} on ${entry.date}.${entry.note ? `
Reason: ${entry.note}` : ''}
New account balance: ${balance} credits.${entry.licenseNumber ? `
OCM license: ${entry.licenseNumber}` : ''}

Logged from Territory HQ.`;
}

export async function addCredits(accountId, amount, note) {
  const st = useStore.getState();
  const acc = st.accounts.find((a) => a.id === accountId);
  if (!acc) return;
  amount = Number(amount) || 0;
  if (!amount) { st.showToast('Enter a credit amount.'); return; }
  const date = new Date().toISOString().slice(0, 10);
  const entry = { id: 'cr' + Date.now(), accountId, accountName: acc.name, licenseNumber: acc.licenseNumber || '', city: acc.city || '', amount, note: note || '', date };
  await api.post('/api/credits', entry);
  st.set({ credits: [...st.credits, entry] });
  st.lastCreditDraft = creditEmail(entry, creditBalance({ ...st, credits: [...st.credits, entry] }, accountId));
  st.set({ lastCreditDraft: st.lastCreditDraft });
  st.showToast(`Added ${amount} credits to ${acc.name}. New balance: ${creditBalance({ ...st, credits: [...st.credits, entry] }, accountId)}.`);
}

export async function setPlanDay(accountId, day, wk) {
  const st = useStore.getState();
  wk = wk || st.planWeek || currentWeekKey();
  const plan = { ...(st.weekPlan[wk] || {}) };
  if (day) plan[accountId] = day; else delete plan[accountId];
  const weekPlan = { ...st.weekPlan, [wk]: plan };
  st.set({ weekPlan });
  await api.put('/api/week-plan', weekPlan);
}

export async function saveWeekPlan(weekPlan) {
  await api.put('/api/week-plan', weekPlan);
}

/* ---------------- auto-plan a week ---------------- */
// Urgency score for "needs a visit": time since last visit, status rules,
// plus priority and follow-up-note bonuses. Mirrors the dashboard recs.
export function visitUrgency(a) {
  const ds = a.lastVisited ? daysSince(a.lastVisited) : Infinity;
  let u = 0;
  if (a.status === 'Active') u = ds >= 28 ? ds : 0;
  else if (a.status === 'Prospect' && ds === Infinity) u = 25;
  else if (a.status === 'Tracking') u = ds >= 30 ? ds - 10 : 0;
  else if (ds >= 45) u = ds;
  if (u > 0 && a.priority) u += 20;
  const note = (a.notes || '').toLowerCase();
  if (/follow.?up|circle back|call back|check in|reorder/.test(note)) u += 15;
  return u;
}

// Automatically draft a week's plan: pick the accounts that need visiting,
// cluster them geographically so each work day covers a nearby group, and
// assign the most-urgent cluster to the earliest work day. Existing manual
// assignments for that week are preserved.
export async function autoPlanWeek(wk) {
  const st = useStore.getState();
  wk = wk || st.planWeek || currentWeekKey();
  const days = st.settings.workDays && st.settings.workDays.length ? st.settings.workDays : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const N = days.length;
  if (!N) { st.showToast('Enable at least one work day in Settings first.'); return; }
  const current = st.weekPlan[wk] || {};
  const needs = st.accounts
    .filter((a) => a.lat != null && a.lng != null && !current[a.id])
    .map((a) => ({ a, u: visitUrgency(a) }))
    .filter((x) => x.u > 0)
    .sort((x, y) => y.u - x.u);
  if (!needs.length) { st.showToast('No accounts need a visit that week — the plan is already handled.'); return; }

  const k = Math.min(N, needs.length);
  const pts = needs.map((x) => ({ lat: x.a.lat, lng: x.a.lng }));
  let centroids = needs.slice(0, k).map((x) => ({ lat: x.a.lat, lng: x.a.lng }));
  const clusters = Array.from({ length: k }, () => []);
  const idOf = (j) => { let lat = 0, lng = 0; clusters[j].forEach((i) => { lat += pts[i].lat; lng += pts[i].lng; }); return { lat: lat / clusters[j].length, lng: lng / clusters[j].length }; };

  for (let iter = 0; iter < 20; iter++) {
    clusters.forEach((c) => { c.length = 0; });
    needs.forEach((x, i) => {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = haversineMiles(centroids[j], pts[i]);
        if (d < bd) { bd = d; best = j; }
      }
      clusters[best].push(i);
    });
    let changed = false;
    for (let j = 0; j < k; j++) {
      if (!clusters[j].length) continue;
      const nc = idOf(j);
      if (haversineMiles(nc, centroids[j]) > 0.001) changed = true;
      centroids[j] = nc;
    }
    if (!changed) break;
  }

  // Most-urgent cluster → earliest work day, so high-priority accounts get the front of the week.
  const nonEmpty = clusters
    .map((c, j) => ({ j, maxU: c.reduce((m, i) => Math.max(m, needs[i].u), 0) }))
    .filter((c) => c.maxU > 0)
    .sort((a, b) => b.maxU - a.maxU);
  const plan = {};
  nonEmpty.forEach((c, idx) => {
    const day = days[idx];
    if (!day) return;
    clusters[c.j].forEach((i) => { plan[needs[i].a.id] = day; });
  });

  const merged = { ...current, ...plan };
  const weekPlan = { ...st.weekPlan, [wk]: merged };
  st.set({ weekPlan });
  await api.put('/api/week-plan', weekPlan);

  const noLoc = st.accounts.filter((a) => !current[a.id] && visitUrgency(a) > 0 && (a.lat == null || a.lng == null)).length;
  st.showToast(`Auto-planned ${Object.keys(plan).length} stop(s) across ${nonEmpty.length} day(s)` + (noLoc ? ` · ${noLoc} unlocated skipped` : '') + '.');
}

export async function completeRoute(date, day, stops, miles, minutes) {
  const st = useStore.getState();
  let accounts = [...st.accounts];
  for (const stop of stops) {
    const acc = accounts.find((a) => a.id === stop.id);
    if (!acc) continue;
    const updated = { ...acc, lastVisited: date };
    await api.put('/api/accounts/' + acc.id, updated);
    accounts = accounts.map((a) => a.id === acc.id ? updated : a);
  }
  const names = stops.map((s) => s.name).join(', ');
  const roundedMiles = Math.round((miles || 0) * 10) / 10;
  const expense = { id: 'e' + Date.now(), date, category: 'Mileage', amount: Math.round(roundedMiles * (st.settings.mileageRate || 0) * 100) / 100, miles: roundedMiles, notes: `Route ${day} ${date}: ${names}` };
  await api.post('/api/expenses', expense);
  const logEntry = { id: 'log' + Date.now(), date, day, stops, miles: miles || 0, minutes: minutes || 0 };
  await api.post('/api/route-log', logEntry);
  st.set({ accounts, expenses: [...st.expenses, expense], routeLog: [...st.routeLog, logEntry] });
}

export async function logMessage(acc, channel, purpose, body, to) {
  const st = useStore.getState();
  const entry = {
    id: 'msg' + Date.now(), accountId: acc.id, accountName: acc.name, licenseNumber: acc.licenseNumber || '',
    city: acc.city || '', channel, purpose: purpose || '', body: body || '', to: to || '', direction: 'outbound',
    date: new Date().toISOString(),
  };
  await api.post('/api/messages', entry);
  st.set({ messages: [...st.messages, entry] });
  return entry;
}

export async function addAccountFromOCM(r) {
  const st = useStore.getState();
  const existing = st.accounts.find((a) => a.licenseNumber === r.license_number);
  if (existing) { st.showToast(existing.name + ' is already an account.'); return; }
  const addr = `${r.address_line_1}, ${r.city}, NY ${r.zip_code || ''}`;
  st.showToast('Adding ' + (r.dba || r.entity_name) + '…');
  const loc = await Promise.race([
    geocode(addr, st.settings.gmapsKey),
    new Promise((r2) => setTimeout(() => r2(null), 8000)),
  ]);
  const acct = {
    id: 'a' + Date.now(), name: r.dba || r.entity_name, dba: r.dba || '', address: r.address_line_1 || '',
    city: r.city || '', county: r.county || '', phone: '', email: '', contactName: '', status: 'Prospect',
    priority: false, priorityRank: 1, notes: 'License #' + r.license_number + ' — added from OCM Watch.',
    lat: loc ? loc.lat : null, lng: loc ? loc.lng : null, source: 'ocm', licenseNumber: r.license_number,
  };
  try {
    await api.post('/api/accounts', acct);
    st.set({ accounts: [...st.accounts, acct] });
    st.showToast('Added ' + acct.name + ' to accounts.');
  } catch (err) {
    st.showToast((err.message || '').includes('409') ? 'That license is already on another account.' : 'Add failed: ' + err.message);
  }
}