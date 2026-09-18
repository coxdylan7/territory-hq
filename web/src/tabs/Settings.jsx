import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { geocode } from '../utils';
import { Section } from '../components';

const ALL_COUNTIES = [
  'Albany', 'Allegany', 'Bronx', 'Broome', 'Cattaraugus', 'Cayuga', 'Chautauqua', 'Chemung', 'Chenango',
  'Clinton', 'Columbia', 'Cortland', 'Delaware', 'Dutchess', 'Erie', 'Essex', 'Franklin', 'Fulton',
  'Genesee', 'Greene', 'Hamilton', 'Herkimer', 'Jefferson', 'Kings', 'Lewis', 'Livingston', 'Madison',
  'Monroe', 'Montgomery', 'Nassau', 'New York', 'Niagara', 'Oneida', 'Onondaga', 'Ontario', 'Orange',
  'Orleans', 'Oswego', 'Otsego', 'Putnam', 'Queens', 'Rensselaer', 'Richmond', 'Rockland', 'St. Lawrence',
  'Saratoga', 'Schenectady', 'Schoharie', 'Schuyler', 'Seneca', 'Steuben', 'Suffolk', 'Sullivan', 'Tioga',
  'Tompkins', 'Ulster', 'Warren', 'Washington', 'Wayne', 'Westchester', 'Wyoming', 'Yates',
];
const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Settings() {
  const st = useStore();
  const { set } = st;
  const [s, setS] = useState(() => ({ ...st.settings, counties: [...(st.settings.counties || [])], workDays: [...(st.settings.workDays || [])] }));
  const [dirty, setDirty] = useState(false);
  const [homeInput, setHomeInput] = useState('');
  const [geocoding, setGeocoding] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [showKey, setShowKey] = useState(false);

  function setState(p) {
    setS(p.settings);
    setDirty(p.dirty);
  }

  async function save() {
    setSaveMsg('');
    try {
      await api.put('/api/settings', s);
      set({ settings: s });
      setDirty(false);
      setSaveMsg('Saved.');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (err) { setSaveMsg('Save failed: ' + err.message); }
  }

  function toggleCounty(c) {
    const cs = s.counties.includes(c) ? s.counties.filter((x) => x !== c) : [...s.counties, c].sort();
    setState({ settings: { ...s, counties: cs }, dirty: true });
  }
  function toggleDay(d) {
    const ds = s.workDays.includes(d) ? s.workDays.filter((x) => x !== d) : [...s.workDays, d];
    setState({ settings: { ...s, workDays: ds }, dirty: true });
  }

  async function locateHome() {
    if (!homeInput.trim()) { st.showToast('Enter a home address.'); return; }
    setGeocoding(true);
    const loc = await geocode(homeInput, s.gmapsKey);
    if (loc) {
      setState({ settings: { ...s, homeAddress: homeInput, homeLat: loc.lat, homeLng: loc.lng }, dirty: true });
      st.showToast('Home located.');
    } else st.showToast('Could not locate that address (try "123 Main St, Anyville, NY").');
    setGeocoding(false);
  }

  const keyVal = s ? s.gmapsKey : '';
  const home = s && s.homeLat != null;

  return (
    <>
      <h2 className="disp" style={{ fontSize: 20 }}>Settings</h2>
      <div className="muted" style={{ margin: '6px 0 14px' }}>Your territory setup: where you live (the start/end of every route), which counties to watch in OCM Watch, the days you work, and the integrations you use.</div>

      <div className="card" style={{ maxWidth: 640 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Home location</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input style={{ flex: 1, minWidth: 220 }} placeholder={home ? s.homeAddress : 'e.g. 311 N. Clinton St, Syracuse, NY'} value={homeInput} onChange={(e) => setHomeInput(e.target.value)} />
          <button className="primary" onClick={locateHome} disabled={geocoding}>{geocoding ? 'Locating…' : home ? 'Re-locate' : 'Locate'}</button>
        </div>
        {home && <div className="muted" style={{ marginTop: 6 }}>Home is set at {s.homeLat.toFixed(5)}, {s.homeLng.toFixed(5)} — every route starts and ends here.</div>}
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Counties to watch in OCM Watch</div>
        <div className="muted" style={{ marginBottom: 8 }}>New openings and direct searches are filtered to these counties. Pick the ones where you work.</div>
        <div className="chips">
          {ALL_COUNTIES.map((c) => (
            <span key={c} className={`chip ${s.counties.includes(c) ? 'on' : ''}`} onClick={() => toggleCounty(c)}>{c}</span>
          ))}
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Work days</div>
        <div className="muted" style={{ marginBottom: 8 }}>Your typical field days — used as defaults for the weekly route planner.</div>
        <div className="chips">
          {ALL_DAYS.map((d) => (
            <span key={d} className={`chip ${s.workDays.includes(d) ? 'on' : ''}`} onClick={() => toggleDay(d)}>{d}</span>
          ))}
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Field costs & alerts</div>
        <div className="grid2">
          <div>
            <label>Mileage rate ($/mi)</label>
            <input type="number" step="0.01" value={s.mileageRate} onChange={(e) => setState({ settings: { ...s, mileageRate: Number(e.target.value) || 0 }, dirty: true })} />
            <div className="muted" style={{ fontSize: 12 }}>Used for reimbursement estimates in Expenses & Reports.</div>
          </div>
          <div>
            <label>Marketing alert email (optional)</label>
            <input value={s.alertEmail} onChange={(e) => setState({ settings: { ...s, alertEmail: e.target.value }, dirty: true })} />
            <div className="muted" style={{ fontSize: 12 }}>Filled in on credit-alert emails so you can send them right from the Credits tab.</div>
          </div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Integrations</div>
        <div className="grid2">
          <div>
            <label>Google Maps API key (optional)</label>
            <input type={showKey ? 'text' : 'password'} value={keyVal}
              onChange={(e) => setState({ settings: { ...s, gmapsKey: e.target.value.trim() }, dirty: true })}
              placeholder="AIza..." />
            <div className="muted" style={{ fontSize: 12 }}>Enables: real driving-time route optimization, live directions, and better geocoding. Get one at the Google Cloud Console and enable Maps JavaScript + Directions APIs. Without it, routes use straight-line distance and the map uses free OpenStreetMap tiles — everything still works.</div>
          </div>
          <div>
            <div style={{ height: 14 }} />
            <button className="ghost small" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide key' : 'Show key'}</button>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Tip: in production, set GMAPS_KEY in your environment and leave this blank to use that instead.</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20 }}>
        <button className="primary" onClick={save} disabled={!dirty}>Save changes</button>
        {!dirty && <span className="muted">No unsaved changes.</span>}
        {dirty && <span className="muted" style={{ color: 'var(--amber)' }}>You have unsaved changes.</span>}
        {saveMsg && <span className="muted" style={{ color: 'var(--green)' }}>{saveMsg}</span>}
      </div>

      <Section>Account</Section>
      <div className="card" style={{ maxWidth: 640 }}>
        <div style={{ fontSize: 14 }}>Signed in as <b>{st.user ? st.user.email : ''}</b> (<span className="pill">{st.user ? st.user.role : ''}</span>)</div>
        <div className="muted" style={{ marginBottom: 10 }}>Members see Dashboard, Accounts, OCM Watch, Route Planner, Route Log, Reports, Messages, Credits, and Expenses.</div>
        <button className="ghost" onClick={() => { st.logout(); const x = new URL(location.href); x.search = 'auth=off'; location.href = x.toString(); }}>Sign out</button>
      </div>
    </>
  );
}