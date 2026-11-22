import { useStore } from '../store';
import { daysSince, expenseValue } from '../utils';
import { buildReportHtml } from '../report-html';
import { openPrintWindow } from '../report-window';
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
  const totalSpend = exp.reduce((s, e) => s + expenseValue(e, st.settings.mileageRate), 0);
  const byCat = {};
  exp.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + expenseValue(e, st.settings.mileageRate); });

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
    const m = logs.filter((l) => inRange(l.date) && !l.dismissed);
    const uniq = new Set(); m.forEach((l) => l.stops.forEach((s) => uniq.add(s.id)));
    const tables = [
      {
        title: 'Expenses by category',
        rows: Object.keys(byCat).length
          ? Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => [c, '$' + v.toFixed(2)])
          : [['None', '']],
        valueRight: true,
      },
      {
        title: 'Coverage & activity',
        rows: [
          ['Unique accounts visited', uniq.size + ' of ' + st.accounts.length],
          ['Credits issued', creditsInRange.length + ' entries (' + creditsTotal + ' credits)'],
          ['Messages sent', msgsInRange.length + ' (' + msgTexts + ' text, ' + msgEmails + ' email)'],
          ['New OCM stores opened', newStores.length],
          ['Accounts neglected (30d+)', neglected.length],
        ],
        valueRight: true,
      },
      {
        title: 'Accounts by status',
        rows: Object.entries(byStatus).map(([s, n]) => [s, n]),
        valueRight: true,
        total: st.accounts.length,
      },
    ];
    if (logs.length) tables.push({
      title: 'Routes completed',
      header: ['Date', 'Day', 'Stops', 'Miles'],
      rows: logs.slice().sort((a, b) => a.date.localeCompare(b.date)).map((l) => [
        l.date, l.day || '', l.stops.map((s) => s.name).join(', '), (l.miles || 0).toFixed(1),
      ]),
      lastRight: true,
    });
    if (creditsInRange.length) tables.push({
      title: 'Credits issued',
      header: ['Date', 'Client', 'Amount', 'Reason'],
      rows: creditsInRange.slice().sort((a, b) => b.date.localeCompare(a.date)).map((c) => [
        c.date, c.accountName, c.amount, c.note || '',
      ]),
      amountRight: true,
    });
    if (msgsInRange.length) tables.push({
      title: 'Messages sent',
      header: ['Date', 'Client', 'Channel', 'Message'],
      rows: msgsInRange.slice().sort((a, b) => b.date.localeCompare(a.date)).map((m) => [
        (m.date || '').slice(0, 10), m.accountName, m.channel, (m.body || '').slice(0, 70).replace(/\n/g, ' '),
      ]),
    });
    if (newStores.length) tables.push({
      title: 'New OCM stores opened',
      header: ['Name', 'County', 'Opened'],
      rows: newStores.map((r) => [r.dba || r.entity_name || '', r.county || '', r.retail_date_opened_to_public || '']),
    });
    if (neglected.length) tables.push({
      title: 'Most neglected accounts',
      header: ['Name', 'Status', 'Last visit'],
      rows: neglected.slice(0, 15).map((a) => {
        const ds = daysSince(a.lastVisited);
        return [a.name, a.status, a.lastVisited ? a.lastVisited + ' (' + ds + 'd)' : 'Never'];
      }),
    });

    const html = buildReportHtml({
      label,
      period: period[0].toUpperCase() + period.slice(1),
      startStr,
      endStr,
      generated: new Date().toLocaleDateString(),
      kpis: [
        [logs.length, 'Routes run'],
        [visitsCompleted, 'Visits'],
        [milesDriven.toFixed(0), 'Miles'],
        ['$' + totalSpend.toFixed(0), 'Expenses'],
        [creditsTotal, 'Credits'],
        [msgsInRange.length, 'Messages'],
      ],
      tables,
    });
    if (!openPrintWindow(html)) st.showToast('Allow pop-ups to export the PDF.');
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