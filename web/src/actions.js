// Cross-tab data actions — ports of helpers from the original single-file app.
import { api } from './api';
import { useStore } from './store';
import { currentWeekKey, geocode } from './utils';

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

export async function setPlanDay(accountId, day) {
  const st = useStore.getState();
  const wk = currentWeekKey();
  const plan = { ...(st.weekPlan[wk] || {}) };
  if (day) plan[accountId] = day; else delete plan[accountId];
  const weekPlan = { ...st.weekPlan, [wk]: plan };
  st.set({ weekPlan });
  await api.put('/api/week-plan', weekPlan);
}

export async function saveWeekPlan(weekPlan) {
  await api.put('/api/week-plan', weekPlan);
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
  const expense = { id: 'e' + Date.now(), date, category: 'Mileage', amount: 0, miles: Math.round((miles || 0) * 10) / 10, notes: `Route ${day} ${date}: ${names}` };
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
  st.showToast('Adding & locating…');
  const loc = await geocode(addr, st.settings.gmapsKey);
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