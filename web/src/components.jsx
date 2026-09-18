import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useStore } from './store';
import { api } from './api';

export function Section({ children }) {
  return <h2 className="section">{children}</h2>;
}

export function Stat({ num, lbl, style }) {
  return (
    <div className="card stat">
      <div className="num" style={style}>{num}</div>
      <div className="lbl">{lbl}</div>
    </div>
  );
}

export function Pill({ status }) {
  return <span className={`pill ${String(status).toLowerCase().replace(' ', '')}`}>{status}</span>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Toast() {
  const toast = useStore((s) => s.toast);
  return toast ? <div className="toast">{toast}</div> : null;
}

/* ---------------- MapView (Leaflet, dark tiles) ---------------- */
const darkStyle = {
  color: '#ffb020',
  weight: 3,
  opacity: 0.85,
};
export function MapView({ home, stops, line, height = 340, fit = true }) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = L.map(ref.current, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;

    const pts = [];
    if (home) pts.push(home);
    (stops || []).forEach((s) => { pts.push({ lat: s.lat, lng: s.lng }); });

    if (home) {
      L.circleMarker([home.lat, home.lng], { radius: 8, color: '#3ecf8e', fillColor: '#3ecf8e', fillOpacity: 1 }).addTo(map)
        .bindPopup('Home');
    }
    (stops || []).forEach((s, i) => {
      if (s.lat == null) return;
      const n = s.priority ? '★' : String(i + 1);
      L.circleMarker([s.lat, s.lng], { radius: 6, color: '#ffb020', fillColor: '#ffb020', fillOpacity: 1 }).addTo(map)
        .bindPopup(String(s.name || n));
    });

    if (line && line.length > 1) {
      L.polyline(line.map((p) => [p.lat, p.lng]), darkStyle).addTo(map);
    }

    if (fit && pts.length) {
      map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), { padding: [30, 30] });
    } else if (home) {
      map.setView([home.lat, home.lng], 9);
    }
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={ref} style={{ width: '100%', height }} />;
}

/* ---------------- Auth screens ---------------- */
export function AuthScreen() {
  const [mode, setMode] = useState('login');
  const [err, setErr] = useState('');
  return (
    <div style={{ minHeight: '100vh', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div className="card" style={{ width: 400, maxWidth: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'var(--amber)', boxShadow: '0 0 10px var(--amber)' }} />
          <h1 className="disp" style={{ fontSize: 22, margin: '8px 0 2px' }}>Territory HQ</h1>
          <div className="muted">Field sales console for NY cannabis reps</div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          <button className={mode === 'login' ? 'primary' : 'ghost'} style={{ flex: 1 }} onClick={() => { setMode('login'); setErr(''); }}>Sign in</button>
          <button className={mode === 'signup' ? 'primary' : 'ghost'} style={{ flex: 1 }} onClick={() => { setMode('signup'); setErr(''); }}>Create account</button>
        </div>
        {mode === 'signup' && (
          <div><label>Full name</label><input id="authName" placeholder="Your name" /></div>
        )}
        <div><label>Email</label><input id="authEmail" type="email" placeholder="you@company.com" autoComplete="username" /></div>
        <div><label>Password</label><input id="authPass" type="password" placeholder={mode === 'signup' ? 'Choose a password (8+ characters)' : 'Password'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} /></div>
        {err && <div className="muted" style={{ color: 'var(--red)', marginTop: 8 }}>{err}</div>}
        <div className="flexEnd" style={{ marginTop: 14 }}>
          <button className="primary" style={{ width: '100%' }} onClick={submit}>{mode === 'signup' ? 'Create account' : 'Sign in'}</button>
        </div>
        {mode === 'signup' && (
          <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>New accounts are reviewed before activation. You&rsquo;ll get access once approved.</div>
        )}
      </div>
    </div>
  );

  async function submit() {
    const el = (id) => document.getElementById(id);
    const email = el('authEmail').value.trim();
    const pass = el('authPass').value;
    const { signIn } = useStore.getState();
    try {
      if (mode === 'signup') {
        const name = el('authName').value.trim();
        if (!name || !email || pass.length < 8) { setErr('Fill all fields; password needs 8+ characters.'); return; }
        const r = await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password: pass }) });
        const d = await r.json();
        if (!r.ok) { setErr(d.error || 'Sign-up failed.'); return; }
        if (d.token) { signIn(d.token, d.user); }
        else { useStore.setState({ auth: 'pending', pendingReason: '' }); }
      } else {
        const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass }) });
        const d = await r.json();
        if (!r.ok) { setErr(d.error || 'Sign-in failed.'); return; }
        signIn(d.token, d.user);
      }
    } catch (e) { setErr('Network error — try again.'); }
  }
}

export function PendingScreen({ reason }) {
  const expired = reason === 'expired';
  const logout = useStore((s) => s.logout);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, width: '100%' }}>
      <div className="card" style={{ width: 420, maxWidth: '100%', textAlign: 'center' }}>
        <h2 className="disp">{expired ? 'Subscription expired' : 'Account pending approval'}</h2>
        <div className="muted" style={{ margin: '10px 0 16px' }}>
          {expired
            ? 'Your subscription has lapsed. Contact your administrator to renew access.'
            : 'Thanks for signing up! Your account is being reviewed. You\u2019ll have access as soon as it\u2019s approved.'}
        </div>
        <button className="ghost" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}