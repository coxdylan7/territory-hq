import { useStore } from '../store';
import { Empty } from '../components';

export default function RouteLog() {
  const routeLog = useStore((s) => s.routeLog);
  const logs = [...routeLog].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <h2 className="disp" style={{ fontSize: 20 }}>Route log</h2>
      <div className="muted" style={{ marginBottom: 14 }}>Every completed route, kept permanently. {logs.length} record(s).</div>
      {logs.length === 0 ? (
        <Empty>No completed routes yet. Optimize a route and hit "Complete route", or approve a pending day from the Dashboard.</Empty>
      ) : (
        <table>
          <thead><tr><th>Date</th><th>Day</th><th>Stops</th><th>Miles</th><th>Drive time</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td data-label="Date"><b>{l.date}</b></td>
                <td data-label="Day">{l.day || '—'}</td>
                <td data-label="Stops">{l.stops.map((s) => s.name).join(', ')}</td>
                <td data-label="Miles">{(l.miles || 0).toFixed(1)}</td>
                <td data-label="Drive time">{l.minutes ? Math.round(l.minutes) + ' min' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}