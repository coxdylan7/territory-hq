import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { currentWeekKey, currentPlan, planForWeek, pendingReviews, recommendations, optimizeRoute } from '../utils';
import { completeRoute, setPlanDay, autoPlanWeek } from '../actions';
import { Section, Stat, Pill, Empty, WeekNav } from '../components';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Dashboard() {
  const st = useStore();
  const { set, accounts, ocmResults, ocmSeen, weekPlan, routeLog } = st;
  const wk = currentWeekKey();
  const wkSel = st.planWeek;
  const isCurrent = wkSel === wk;
  const plan = planForWeek(weekPlan, wkSel);
  const [planning, setPlanning] = useState(false);
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short' });
  const plannedCount = Object.keys(plan).length;
  const todaysStops = accounts.filter((a) => currentPlan(weekPlan)[a.id] === today);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthSpend = st.expenses.filter((e) => e.date?.startsWith(thisMonth)).reduce((s, e) => s + Number(e.amount || 0), 0);
  const newCount = ocmResults.filter((r) => !ocmSeen.includes(r.license_number)).length;
  const reviews = pendingReviews(weekPlan, routeLog);
  const recs = recommendations(accounts, plan);

  async function runAutoPlan() {
    setPlanning(true);
    try { await autoPlanWeek(wkSel); } finally { setPlanning(false); }
  }

  async function approve(date) {
    const rv = reviews.find((r) => r.date === date);
    if (!rv) return;
    const checked = st[`chk_${date}`] || {};
    const stops = rv.accountIds
      .filter((id) => checked[id] !== false)
      .map((id) => { const a = accounts.find((x) => x.id === id); return a ? { id: a.id, name: a.name } : null; })
      .filter(Boolean);
    if (stops.length === 0) { st.showToast('No stops checked.'); return; }
    let miles = 0, minutes = 0;
    const home = st.settings.homeLat != null ? { lat: st.settings.homeLat, lng: st.settings.homeLng } : null;
    if (home) {
      const accs = stops.map((s) => accounts.find((a) => a.id === s.id)).filter(Boolean);
      try { miles = optimizeRoute(home, accs).totalMiles; } catch (e) {}
    }
    await completeRoute(date, rv.day, stops, miles, minutes);
    st.showToast('Approved ' + stops.length + ' visit(s) for ' + date + '.');
  }

  async function dismiss(date) {
    const rv = reviews.find((r) => r.date === date);
    const logEntry = { id: 'log' + Date.now(), date, day: rv ? rv.day : '', stops: [], miles: 0, minutes: 0, dismissed: true };
    await api.post('/api/route-log', logEntry);
    set({ routeLog: [...routeLog, logEntry] });
    st.showToast('Dismissed ' + date + '.');
  }

  async function assign(id, day) {
    if (!day) return;
    await setPlanDay(id, day);
    const a = accounts.find((x) => x.id === id);
    st.showToast((a ? a.name : 'Account') + ' added to ' + day + ' this week.');
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div>
          <h2 className="disp" style={{ fontSize: 22, marginBottom: 2 }}>Good to see you.</h2>
          <div className="muted">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · Week {wk}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="primary" onClick={runAutoPlan} disabled={planning}>
            {planning ? 'Planning…' : (isCurrent ? '⚡ Auto-plan this week' : `⚡ Auto-plan ${wkSel}`)}
          </button>
          <WeekNav />
        </div>
      </div>
      <div className="cards4">
        <Stat num={accounts.length} lbl="Tracked accounts" />
        <Stat num={plannedCount} lbl={isCurrent ? 'Planned this week' : `Planned ${wkSel}`} />
        <Stat num={todaysStops.length} lbl={`Stops today (${today})`} />
        <Stat num={newCount} lbl="New OCM stores" />
      </div>

      {reviews.length > 0 && (
        <>
          <Section>⚠️ Routes to review & approve</Section>
          <div className="muted" style={{ marginBottom: 10 }}>
            These days were planned but not yet logged. Approve to record the visits, stamp last-visit dates, and log mileage.
          </div>
          {reviews.map((rv) => {
            const accts = rv.accountIds.map((id) => accounts.find((a) => a.id === id)).filter(Boolean);
            return (
              <div className="card" style={{ marginBottom: 10 }} key={rv.date}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div><b>{rv.day}, {rv.date}</b> <span className="muted">— {accts.length} planned stop(s)</span></div>
                  <div>
                    <button className="ghost small" onClick={() => dismiss(rv.date)}>Dismiss</button>
                    <button className="primary small" onClick={() => approve(rv.date)}>Approve & log</button>
                  </div>
                </div>
                <div style={{ marginTop: 8 }}>
                  {accts.map((a) => (
                    <label className="checkline" key={a.id} style={{ margin: '4px 0', fontSize: 13, color: 'var(--text)' }}>
                      <input type="checkbox" defaultChecked onChange={(e) => set({ [`chk_${rv.date}`]: { ...(st[`chk_${rv.date}`] || {}), [a.id]: e.target.checked } })} />
                      {a.name} <span className="muted">{a.city || ''}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}

      {recs.length > 0 && (
        <>
          <Section>Recommended stops to schedule</Section>
          <div className="muted" style={{ marginBottom: 10 }}>Based on time since last visit, status, and your notes. Tap to add to {wkSel}.</div>
          {recs.map((r) => (
            <div className="card" style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }} key={r.account.id}>
              <div>
                <b>{r.account.name}</b> <Pill status={r.account.status} />
                <div className="muted" style={{ marginTop: 2 }}>{r.reason}</div>
              </div>
              <select style={{ width: 'auto' }} value="" onChange={(e) => assign(r.account.id, e.target.value)}>
                <option value="">Add to day…</option>
                {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          ))}
        </>
      )}

      <Section>This month</Section>
      <div className="row">
        <div className="card" style={{ flex: 1, minWidth: 220 }}>
          <div className="muted">Expenses logged</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }} className="disp">${monthSpend.toFixed(2)}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 220 }}>
          <div className="muted">Routes completed (all time)</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }} className="disp">{routeLog.length}</div>
        </div>
      </div>

      <UpcomingBookingStrip bookings={st.bookings} accounts={accounts} />
      {accounts.length === 0 && <Empty>No accounts yet. Add one manually, or pull candidates from OCM Watch.</Empty>}
    </>
  );
}

function UpcomingBookingStrip({ bookings, accounts }) {
  const today = new Date().toISOString().slice(0, 10);
  const in7 = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();
  const up = (bookings || [])
    .filter((b) => b.status === 'approved' && b.date >= today && b.date <= in7)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!up.length) return null;
  const addr = (id) => { const a = accounts.find((x) => x.id === id); return a && a.address ? `${a.address}, ${a.city}` : ''; };
  return (
    <>
      <Section>🎟️ Upcoming activations & trainings</Section>
      <div className="row">
        {up.map((b) => (
          <div className="card" key={b.id} style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 13, color: 'var(--amber)', fontWeight: 700 }}>{b.date}</div>
            <div style={{ fontWeight: 600, marginTop: 2 }}>{b.eventTypeName}</div>
            <div className="muted">{b.accountName}{b.ambassadorName ? ` · ${b.ambassadorName}` : ''}</div>
            {addr(b.accountId) && <a className="btnLink" style={{ fontSize: 12 }} href={'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr(b.accountId))} target="_blank" rel="noreferrer">Open in Maps →</a>}
          </div>
        ))}
      </div>
    </>
  );
}