import { useStore, validGmapsKey } from '../store';
import { planForWeek, daysSince, optimizeRoute, optimizeRouteGoogle, optimizeRouteOSRM, mapsUrls } from '../utils';
import { completeRoute, setPlanDay } from '../actions';
import { MapView, Empty, WeekNav } from '../components';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function VisitBadge({ acc }) {
  if (!acc || !acc.lastVisited) return <span className="lvBadge never">never visited</span>;
  const ds = daysSince(acc.lastVisited);
  if (ds === Infinity) return <span className="lvBadge soon">last visit: never</span>;
  return <span className={`lvBadge ${ds >= 21 ? 'soon' : 'ok'}`}>last {ds}d ago · {acc.lastVisited}</span>;
}

export default function RouteTab() {
  const st = useStore();
  const { set } = st;
  const wk = st.planWeek;
  const day = st.routeDay || st.settings.workDays[0] || 'Mon';
  const plan = planForWeek(st.weekPlan, wk);
  const dayStops = st.accounts.filter((a) => plan[a.id] === day);
  const home = st.settings.homeLat != null ? { lat: st.settings.homeLat, lng: st.settings.homeLng } : null;
  const gmapsKey = validGmapsKey(st.settings.gmapsKey);
  const usingGoogle = !!gmapsKey;
  const r = st.routeResult;
  const showingResult = r && r.day === day;

  async function optimize() {
    if (!home) return;
    set({ routeLoading: true, routeError: '' });
    try {
      let result;
      if (usingGoogle) {
        result = await optimizeRouteGoogle(home, dayStops, gmapsKey);
      } else {
        try {
          result = await optimizeRouteOSRM(home, dayStops);
        } catch (osrmErr) {
          const o = optimizeRoute(home, dayStops);
          result = {
            legs: [...o.ordered.map((x) => ({ ...x, distanceText: x.legMiles.toFixed(1) + ' mi' })), { name: 'Back home', isHome: true, distanceText: o.returnLeg.toFixed(1) + ' mi' }],
            totalMiles: o.totalMiles, totalMinutes: 0, skipped: o.skipped, engine: 'straight-line', osrmErr: osrmErr.message,
          };
        }
      }
      result.day = day;
      set({ routeResult: result, routeLoading: false });
    } catch (e) {
      set({ routeLoading: false, routeError: 'Route optimization failed: ' + e.message });
    }
  }

  async function markVisited() {
    if (!r) return;
    set({ visitLoading: true });
    const today = new Date().toISOString().slice(0, 10);
    const visitedStops = r.legs.filter((l) => !l.isHome);
    await completeRoute(today, r.day, visitedStops.map((s) => ({ id: s.id, name: s.name })), r.totalMiles, r.totalMinutes);
    set({ visitLoading: false, routeResult: null });
    st.showToast('Route logged: ' + visitedStops.length + ' stop(s), ' + r.totalMiles.toFixed(1) + ' mi.');
  }

  async function quickAssign(id) {
    const acc = st.accounts.find((a) => a.id === id);
    if (!acc) return;
    await setPlanDay(id, day);
    st.showToast(acc.name + ' added to ' + day + '.');
  }

  const line = showingResult && r.geometry && r.geometry.length > 1
    ? r.geometry
    : showingResult ? [home, ...r.legs.filter((l) => !l.isHome).map((l) => ({ lat: l.lat, lng: l.lng })), home] : null;

  const others = st.accounts.filter((a) => plan[a.id] !== day);
  const dayCounts = DAYS.map((d) => (
    <span key={d} className={`dayChip ${day === d ? 'on' : ''}`} onClick={() => set({ routeDay: d, routeResult: null, routeError: '' })}>
      {d}{st.accounts.filter((a) => plan[a.id] === d).length ? ` · ${st.accounts.filter((a) => plan[a.id] === d).length}` : ''}
    </span>
  ));

  let body;
  if (!home) {
    body = <Empty>Set and locate your home address in Settings first.</Empty>;
  } else if (dayStops.length === 0) {
    body = <Empty>Nothing planned for {day} this week. Add stops below or from the Accounts tab.</Empty>;
  } else {
    body = (
      <>
        <div className="flexEnd" style={{ justifyContent: 'flex-start', marginBottom: 14 }}>
          <button className="primary" onClick={optimize} disabled={st.routeLoading}>
            {st.routeLoading ? 'Optimizing…' : (usingGoogle ? 'Optimize with Google Maps' : 'Optimize with OpenStreetMap')}
          </button>
        </div>
        {st.routeError && <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)', marginBottom: 14 }}>{st.routeError}</div>}

        {!showingResult && (
          <div className="row">
            <div className="card" style={{ flex: 2, minWidth: 340 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>{dayStops.length} stop(s) planned for {day} — not yet optimized</div>
              <div className="stopRow"><div className="stopNum">H</div><div><b>Home</b><div className="muted">{st.settings.homeAddress}</div></div></div>
              {dayStops.map((s) => (
                <div className="stopRow" key={s.id}>
                  <div className="stopNum">{s.priority ? '★' : '•'}</div>
                  <div style={{ flex: 1 }}><b>{s.name}</b><VisitBadge acc={s} /><div className="muted">{s.address}, {s.city}{s.lat == null ? ' — ⚠️ no location found' : ''}</div></div>
                </div>
              ))}
              {dayStops.filter((s) => s.lat == null).length > 0 && (
                <div className="muted" style={{ marginTop: 8 }}>{dayStops.filter((s) => s.lat == null).length} stop(s) have no location and will be skipped until re-saved in Accounts.</div>
              )}
              <div className="muted" style={{ marginTop: 10 }}>Press <b>Optimize</b> to compute the best driving order.</div>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 280, padding: 0, overflow: 'hidden' }}>
              <MapView home={home} stops={dayStops} height={340} />
            </div>
          </div>
        )}

        {showingResult && (
          <div className="row">
            <div className="card" style={{ flex: 2, minWidth: 340 }}>
              <div className="stopRow"><div className="stopNum">H</div><div><b>Home</b><div className="muted">{st.settings.homeAddress}</div></div></div>
              {r.legs.map((s, i) => (
                <div className="stopRow" key={s.isHome ? 'home' : s.id}>
                  <div className="stopNum">{s.isHome ? 'H' : i + 1}</div>
                  <div style={{ flex: 1 }}>
                    <b>{s.isHome ? 'Back home' : s.name}</b> {s.priority ? <span className="priority">★</span> : ''}
                    {!s.isHome && <VisitBadge acc={s} />}
                    <div className="muted">{s.isHome ? '' : `${s.address}, ${s.city} — `}{s.distanceText || ''}{s.durationText ? ' · ' + s.durationText : ''}</div>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 14, fontWeight: 600 }}>
                Total: <span className="disp" style={{ color: 'var(--amber)' }}>{r.totalMiles.toFixed(1)} mi</span>
                {r.totalMinutes ? ` · ${Math.round(r.totalMinutes)} min drive time` : ''}
              </div>
              <div className="row" style={{ marginTop: 10, gap: 10 }}>
                <a className="btnLink" href={mapsUrls(st.settings, r.legs.filter((l) => !l.isHome)).gmaps} target="_blank" rel="noreferrer">Open in Google Maps →</a>
                <a className="btnLink" href={mapsUrls(st.settings, r.legs.filter((l) => !l.isHome)).apple} target="_blank" rel="noreferrer">Open in Apple Maps →</a>
              </div>
              {r.skipped.length > 0 && <div className="muted" style={{ marginTop: 10 }}>{r.skipped.length} stop(s) skipped — no location found. Re-save them in Accounts to geocode.</div>}
              {r.engine === 'straight-line' && r.osrmErr && <div className="muted" style={{ marginTop: 10 }}>OpenStreetMap routing was briefly unavailable, so this used straight-line distance ({r.osrmErr}). Press Optimize again — it's free and needs no API key.</div>}
              <div className="flexEnd" style={{ justifyContent: 'flex-start', marginTop: 14 }}>
                <button className="primary" onClick={markVisited} disabled={st.visitLoading}>{st.visitLoading ? 'Logging…' : 'Complete route → log visits & mileage'}</button>
              </div>
              <div className="muted" style={{ marginTop: 6 }}>Records this route in the Route Log, stamps today's visit date on each stop, and adds a {r.totalMiles.toFixed(1)} mi Mileage expense.</div>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 280, padding: 0, overflow: 'hidden' }}>
              <MapView home={home} stops={r.legs.filter((l) => !l.isHome)} line={line} height={340} />
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 2 }}>
        <h2 className="disp" style={{ fontSize: 20 }}>Weekly route <span className="muted" style={{ fontSize: 13 }}>{wk}</span></h2>
        <WeekNav />
      </div>
      <div className="muted" style={{ marginBottom: 14, maxWidth: 620 }}>
        {usingGoogle ? 'Optimized with live Google driving directions.' : 'Optimized with free OpenStreetMap driving directions — no API key needed.'}
        {' '}Reads the selected week's plan from Accounts. Priority-override accounts are always visited first.
      </div>
      <div style={{ marginBottom: 16 }}>{dayCounts}</div>
      {body}

      <h2 className="section">Add accounts to {day} ({wk})</h2>
      {others.length === 0 ? (
        <div className="muted">Every account is already on {day} this week.</div>
      ) : (
        <div className="row">
          {others.map((a) => (
            <span key={a.id} className="countyChip" onClick={() => quickAssign(a.id)}>
              + {a.name}{plan[a.id] ? <span className="muted"> ({plan[a.id]})</span> : ''}
            </span>
          ))}
        </div>
      )}
    </>
  );
}