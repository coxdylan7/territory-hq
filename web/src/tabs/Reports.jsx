import { useStore } from '../store';
import { daysSince } from '../utils';
import { Stat, Section, Pill } from '../components';

const PERIODS = ['day', 'week', 'month', 'quarter'];

export function periodRange(period, ref) {
  const now = ref ? new Date(ref) : new Date();
  let start, end, label;
  if (period === 'day') {
    start = new Date(now); start.setHours(0, 0, 0, 0);
    end = new Date(start); end.setDate(end.getDate() + 1);
    label = start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  } else if (period === 'week') {
    const dow = (now.getDay() + 6) % 7;
    start = new Date(now); start.setDate(now.getDate() - dow); start.setHours(0, 0, 0, 0);
    end = new Date(start); end.setDate(end.getDate() + 7);
    label = `Week of ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  } else {
    const q = Math.floor(now.getMonth() / 3);
    start = new Date(now.getFullYear(), q * 3, 1);
    end = new Date(now.getFullYear(), q * 3 + 3, 1);
    label = `Q${q + 1} ${now.getFullYear()}`;
  }
  return { start, end, label, startStr: start.toISOString().slice(0, 10), endStr: end.toISOString().slice(0, 10) };
}

export default function Reports() {
  const st = useStore();
  const { set } = st;
  const period = st.reportPeriod;
  const { startStr, endStr, label } = periodRange(period, st.reportRef);
  const inRange = (d) => d && d >= startStr && d < endStr;

  const logs = st.routeLog.filter((l) => inRange(l.date));
  const visitsCompleted = logs.reduce((s, l) => s + l.stops.length, 0);
  const milesDriven = logs.reduce((s, l) => s + (l.miles || 0), 0);
  const routesRun = logs.length;

  const exp = st.expenses.filter((e) => inRange(e.date));
  const totalSpend = exp.reduce((s, e) => s + Number(e.amount || 0), 0);
  const mileageReimb = exp.filter((e) => e.category === 'Mileage').reduce((s, e) => s + Number(e.miles || 0) * st.settings.mileageRate, 0);
  const byCat = {};
  exp.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount || 0); });

  const newStores = st.ocmResults.filter((r) => inRange(r.retail_date_opened_to_public));

  const neglected = st.accounts.filter((a) => { const ds = daysSince(a.lastVisited); return ds === Infinity || ds >= 30; })
    .sort((a, b) => daysSince(b.lastVisited) - daysSince(a.lastVisited));

  const uniqueVisited = new Set();
  logs.forEach((l) => l.stops.forEach((s) => uniqueVisited.add(s.id)));

  const creditsInRange = st.credits.filter((c) => inRange(c.date));
  const creditsTotal = creditsInRange.reduce((s, c) => s + Number(c.amount || 0), 0);

  const msgsInRange = st.messages.filter((m) => inRange((m.date || '').slice(0, 10)));
  const msgTexts = msgsInRange.filter((m) => m.channel === 'text').length;
  const msgEmails = msgsInRange.filter((m) => m.channel === 'email').length;

  const byStatus = {};
  st.accounts.forEach((a) => { byStatus[a.status] = (byStatus[a.status] || 0) + 1; });
  const avgMiles = routesRun ? milesDriven / routesRun : 0;

  function reportAsText() {
    return `TERRITORY HQ REPORT — ${label} (${startStr} to ${endStr})
Routes run: ${logs.length}
Visits completed: ${visitsCompleted}
Miles driven: ${milesDriven.toFixed(1)}
Total expenses: $${totalSpend.toFixed(2)}
Credits issued: ${creditsTotal}
Messages sent: ${msgsInRange.length}
New OCM stores opened: ${newStores.length}`;
  }

  function exportPDF() {
    const row = (a, b) => `<tr><td>${a}</td><td style="text-align:right">${b}</td></tr>`;
    const m = logs.filter((l) => inRange(l.date) && !l.dismissed);
    const uniq = new Set(); m.forEach((l) => l.stops.forEach((s) => uniq.add(s.id)));
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Territory HQ Report — ${label}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;padding:32px;max-width:760px;margin:0 auto;}
  h1{font-size:22px;margin:0 0 2px;} .sub{color:#666;margin-bottom:20px;font-size:13px;}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#888;border-bottom:1px solid #ddd;padding-bottom:4px;margin:24px 0 10px;}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px;}
  td,th{padding:5px 8px;border-bottom:1px solid #eee;text-align:left;}
  .kpis{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px;}
  .kpi{flex:1;min-width:110px;border:1px solid #e5e5e5;border-radius:8px;padding:12px;}
  .kpi .n{font-size:24px;font-weight:700;color:#b8860b;} .kpi .l{font-size:11px;color:#777;text-transform:uppercase;}
  .foot{margin-top:30px;color:#aaa;font-size:11px;}
</style></head><body>
  <h1>Territory HQ — ${period[0].toUpperCase() + period.slice(1)} Report</h1>
  <div class="sub">${label} · ${startStr} to ${endStr} · generated ${new Date().toLocaleDateString()}</div>
  <div class="kpis">
    <div class="kpi"><div class="n">${logs.length}</div><div class="l">Routes run</div></div>
    <div class="kpi"><div class="n">${visitsCompleted}</div><div class="l">Visits</div></div>
    <div class="kpi"><div class="n">${milesDriven.toFixed(0)}</div><div class="l">Miles</div></div>
    <div class="kpi"><div class="n">$${totalSpend.toFixed(0)}</div><div class="l">Expenses</div></div>
    <div class="kpi"><div class="n">${creditsTotal}</div><div class="l">Credits</div></div>
    <div class="kpi"><div class="n">${msgsInRange.length}</div><div class="l">Messages</div></div>
  </div>
  <h2>Expenses by category</h2>
  <table>${Object.keys(byCat).length ? Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => row(c, '$' + v.toFixed(2))).join('') : row('None', '')}
    ${row('<b>Est. mileage reimbursement</b>', '<b>$' + mileageReimb.toFixed(2) + '</b>')}</table>
  <h2>Coverage & activity</h2>
  <table>${row('Unique accounts visited', uniq.size + ' of ' + st.accounts.length)}
    ${row('Credits issued', creditsInRange.length + ' entries (' + creditsTotal + ' credits)')}
    ${row('Messages sent', msgsInRange.length + ' (' + msgTexts + ' text, ' + msgEmails + ' email)')}
    ${row('New OCM stores opened', newStores.length)}
    ${row('Accounts neglected (30d+)', neglected.length)}</table>
  <h2>Accounts by status</h2>
  <table>${Object.entries(byStatus).map(([s, n]) => row(s, n)).join('')}${row('<b>Total</b>', '<b>' + st.accounts.length + '</b>')}</table>
  ${logs.length ? `<h2>Routes completed</h2><table><tr><th>Date</th><th>Day</th><th>Stops</th><th style="text-align:right">Miles</th></tr>
    ${logs.slice().sort((a, b) => a.date.localeCompare(b.date)).map((l) => `<tr><td>${l.date}</td><td>${l.day || ''}</td><td>${l.stops.map((s) => s.name).join(', ')}</td><td style="text-align:right">${(l.miles || 0).toFixed(1)}</td></tr>`).join('')}</table>` : ''}
  ${creditsInRange.length ? `<h2>Credits issued</h2><table><tr><th>Date</th><th>Client</th><th style="text-align:right">Amount</th><th>Reason</th></tr>
    ${creditsInRange.slice().sort((a, b) => b.date.localeCompare(a.date)).map((c) => `<tr><td>${c.date}</td><td>${c.accountName}</td><td style="text-align:right">${c.amount}</td><td>${c.note || ''}</td></tr>`).join('')}</table>` : ''}
  ${msgsInRange.length ? `<h2>Messages sent</h2><table><tr><th>Date</th><th>Client</th><th>Channel</th><th>Message</th></tr>
    ${msgsInRange.slice().sort((a, b) => b.date.localeCompare(a.date)).map((m) => `<tr><td>${(m.date || '').slice(0, 10)}</td><td>${m.accountName}</td><td>${m.channel}</td><td>${(m.body || '').slice(0, 70).replace(/\n/g, ' ')}</td></tr>`).join('')}</table>` : ''}
  ${newStores.length ? `<h2>New OCM stores opened</h2><table><tr><th>Name</th><th>County</th><th>Opened</th></tr>
    ${newStores.map((r) => `<tr><td>${(r.dba || r.entity_name || '')}</td><td>${r.county || ''}</td><td>${r.retail_date_opened_to_public || ''}</td></tr>`).join('')}</table>` : ''}
  ${neglected.length ? `<h2>Most neglected accounts</h2><table><tr><th>Name</th><th>Status</th><th>Last visit</th></tr>
    ${neglected.slice(0, 15).map((a) => { const ds = daysSince(a.lastVisited); return `<tr><td>${a.name}</td><td>${a.status}</td><td>${a.lastVisited ? a.lastVisited + ' (' + ds + 'd)' : 'Never'}</td></tr>`; }).join('')}</table>` : ''}
  <div class="foot">Generated by Territory HQ</div>
  <script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>
</body></html>`;
    const w = window.open('', '_blank');
    if (!w) { st.showToast('Allow pop-ups to export the PDF.'); return; }
    w.document.write(html); w.document.close();
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 className="disp" style={{ fontSize: 20 }}>Reports</h2>
        <div>
          {PERIODS.map((p) => (
            <span key={p} className={`dayChip ${period === p ? 'on' : ''}`} onClick={() => set({ reportPeriod: p })}>
              {p[0].toUpperCase() + p.slice(1)}
            </span>
          ))}
        </div>
      </div>
      <div className="muted" style={{ margin: '6px 0 16px' }}>{label} · {startStr} → {endStr}</div>

      <div className="cards4">
        <Stat num={routesRun} lbl="Routes run" />
        <Stat num={visitsCompleted} lbl="Visits completed" />
        <Stat num={milesDriven.toFixed(0)} lbl="Miles driven" />
        <Stat num={'$' + totalSpend.toFixed(0)} lbl="Total expenses" />
      </div>
      <div className="cards4">
        <Stat num={creditsTotal} lbl="Credits issued" />
        <Stat num={msgsInRange.length} lbl="Messages sent" />
        <Stat num={newStores.length} lbl="New OCM stores" />
        <Stat num={uniqueVisited.size} lbl="Clients visited" />
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <div className="card" style={{ flex: 1, minWidth: 240 }}>
          <div className="muted" style={{ marginBottom: 6 }}>Expenses by category</div>
          {Object.keys(byCat).length
            ? Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }} key={c}><span>{c}</span><span>${v.toFixed(2)}</span></div>
            ))
            : <div className="muted">None</div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', borderTop: '1px solid var(--line)', marginTop: 6, fontWeight: 600, fontSize: 13 }}>
            <span>Est. mileage reimbursement</span><span>${mileageReimb.toFixed(2)}</span>
          </div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 240 }}>
          <div className="muted" style={{ marginBottom: 6 }}>Activity</div>
          <div style={{ fontSize: 13, padding: '3px 0' }}>Avg miles per route: <b>{avgMiles.toFixed(1)}</b></div>
          <div style={{ fontSize: 13, padding: '3px 0' }}>Messages: <b>{msgTexts}</b> text, <b>{msgEmails}</b> email</div>
          <div style={{ fontSize: 13, padding: '3px 0' }}>Credit entries: <b>{creditsInRange.length}</b></div>
          <div style={{ fontSize: 13, padding: '3px 0' }}>Accounts neglected (30d+): <b style={{ color: 'var(--amber)' }}>{neglected.length}</b></div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 200 }}>
          <div className="muted" style={{ marginBottom: 6 }}>Accounts by status</div>
          {Object.entries(byStatus).map(([s, n]) => (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }} key={s}><span><Pill status={s} /></span><span>{n}</span></div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', borderTop: '1px solid var(--line)', marginTop: 6, fontWeight: 600, fontSize: 13 }}>
            <span>Total accounts</span><span>{st.accounts.length}</span>
          </div>
        </div>
      </div>

      {routesRun > 0 && (
        <>
          <Section>Routes completed ({label})</Section>
          <table>
            <thead><tr><th>Date</th><th>Day</th><th>Stops</th><th>Miles</th></tr></thead>
            <tbody>
              {logs.slice().sort((a, b) => a.date.localeCompare(b.date)).map((l) => (
                <tr key={l.id}><td data-label="Date">{l.date}</td><td data-label="Day">{l.day || ''}</td><td data-label="Stops">{l.stops.map((s) => s.name).join(', ')}</td><td data-label="Miles">{(l.miles || 0).toFixed(1)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {creditsInRange.length > 0 && (
        <>
          <Section>Credits issued ({label})</Section>
          <table>
            <thead><tr><th>Date</th><th>Client</th><th>Amount</th><th>Reason</th></tr></thead>
            <tbody>
              {creditsInRange.slice().sort((a, b) => b.date.localeCompare(a.date)).map((c) => (
                <tr key={c.id}><td data-label="Date">{c.date}</td><td data-label="Client">{c.accountName}</td><td data-label="Amount">{c.amount}</td><td data-label="Reason" className="muted">{c.note || ''}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {msgsInRange.length > 0 && (
        <>
          <Section>Messages sent ({label})</Section>
          <table>
            <thead><tr><th>Date</th><th>Client</th><th>Channel</th><th>Message</th></tr></thead>
            <tbody>
              {msgsInRange.slice().sort((a, b) => b.date.localeCompare(a.date)).map((m) => (
                <tr key={m.id}>
                  <td data-label="Date">{(m.date || '').slice(0, 10)}</td>
                  <td data-label="Client">{m.accountName}</td>
                  <td data-label="Channel">{m.channel}</td>
                  <td data-label="Message" className="muted">{(m.body || '').slice(0, 60)}{(m.body || '').length > 60 ? '…' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {newStores.length > 0 && (
        <>
          <Section>New OCM stores opened ({label})</Section>
          <table>
            <thead><tr><th>Name</th><th>County</th><th>Opened</th></tr></thead>
            <tbody>
              {newStores.map((r) => (
                <tr key={r.license_number}><td data-label="Name">{r.dba || r.entity_name}</td><td data-label="County">{r.county}</td><td data-label="Opened">{r.retail_date_opened_to_public}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {neglected.length > 0 && (
        <>
          <Section>Most neglected accounts</Section>
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Last visit</th></tr></thead>
            <tbody>
              {neglected.slice(0, 12).map((a) => { const ds = daysSince(a.lastVisited); return (
                <tr key={a.id}>
                  <td data-label="Name">{a.name}</td>
                  <td data-label="Status"><Pill status={a.status} /></td>
                  <td data-label="Last visit"><span style={{ color: 'var(--amber)' }}>{a.lastVisited ? a.lastVisited + ' (' + ds + 'd)' : 'Never'}</span></td>
                </tr>
              ); })}
            </tbody>
          </table>
        </>
      )}

      <div className="flexEnd" style={{ justifyContent: 'flex-start', marginTop: 18, gap: 8 }}>
        <button className="primary" onClick={exportPDF}>Export PDF</button>
        <button className="ghost" onClick={() => { navigator.clipboard.writeText(reportAsText()); st.showToast('Report copied.'); }}>Copy as text</button>
      </div>
    </>
  );
}