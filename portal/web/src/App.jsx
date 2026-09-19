import { useEffect, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import { todayStr, creditEstimate, fmtDate, fmtMoney } from './utils';

const STATUS_PILL = { requested: 'tracking', approved: 'active', declined: 'inactive', cancelled: 'prospect', completed: 'activation' };
const STATUS_LABEL = { requested: 'Requested', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled', completed: 'Completed' };

export default function App() {
  const st = useStore();

  useEffect(() => {
    st.init();
    const onUnauth = () => st.set({ auth: 'none', user: null, balance: null, eventTypes: [], bookings: [] });
    window.addEventListener('tp:unauthorized', onUnauth);
    return () => window.removeEventListener('tp:unauthorized', onUnauth);
  }, []);

  const invite = (() => {
    const m = window.location.pathname.match(/^\/invite\/([a-f0-9]+)/i);
    return m ? m[1] : null;
  })();

  let view;
  if (st.auth === 'boot') view = <Splash />;
  else if (st.auth === 'none') view = invite ? <InviteSignup token={invite} /> : <Login />;
  else if (st.user && st.user.role === 'staff') view = <StaffHome />;
  else if (st.user) view = <ClientHome />;
  else view = <Splash />;

  return (
    <div className="portalRoot">
      {view}
      {st.toast && <div className="toast">{st.toast}</div>}
    </div>
  );
}

function Splash() {
  return (
    <div className="authShell">
      <Brand />
      <div className="card authCard" style={{ marginTop: 18 }}>
        <div style={{ color: 'var(--sub)', textAlign: 'center' }}>Loading…</div>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="portalBrand" style={{ justifyContent: 'center' }}>
      <div className="logo">◈</div>
      <div>
        <h1>Territory Portal</h1>
        <span>Store credit redemption</span>
      </div>
    </div>
  );
}

function AuthShell({ title, sub, children }) {
  return (
    <div className="authShell">
      <Brand />
      <div className="card authCard" style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 0, marginBottom: 4 }}>{title}</h2>
        {sub && <div className="muted" style={{ marginBottom: 16 }}>{sub}</div>}
        {children}
      </div>
      <div className="authFaint">Powered by your Territory rep</div>
    </div>
  );
}

function Login() {
  const st = useStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  async function go(e) {
    e.preventDefault();
    setBusy(true);
    try { await st.login(email, password); st.showToast('Welcome back.'); }
    catch (err) { st.showToast(err.message); if (err.message.includes('suspended')) st.showToast('Account suspended — contact your Territory rep.'); }
    setBusy(false);
  }
  return (
    <AuthShell title="Sign in" sub="Manage your brand activations and budtender trainings here.">
      <form onSubmit={go}>
        <label>Email</label>
        <input autoFocus type="email" value={email} placeholder="you@store.com" onChange={(e) => setEmail(e.target.value)} />
        <label>Password</label>
        <input type="password" value={password} placeholder="••••••••" onChange={(e) => setPassword(e.target.value)} />
        <div className="flexEnd" style={{ marginTop: 18 }}><button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></div>
      </form>
    </AuthShell>
  );
}

function InviteSignup({ token }) {
  const st = useStore();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  async function go(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/api/auth/invite-signup', { token, name, password });
      st.set({ user: r.user, auth: 'app' });
      await st.refresh(r.user);
      window.history.replaceState({}, '', '/');
      st.showToast('Account activated — welcome!');
    } catch (err) {
      st.showToast(err.message || 'Invite could not be activated');
    }
    setBusy(false);
  }
  return (
    <AuthShell title="Claim your invite" sub="Set your name and a password to activate this store portal account.">
      <form onSubmit={go}>
        <label>Your name</label>
        <input autoFocus value={name} placeholder="Alex Rivera" onChange={(e) => setName(e.target.value)} />
        <label>Password</label>
        <input type="password" value={password} placeholder="6+ characters" onChange={(e) => setPassword(e.target.value)} />
        <div className="flexEnd" style={{ marginTop: 18 }}><button className="primary" disabled={busy || !name || password.length < 6}>{busy ? 'Activating…' : 'Activate & sign in'}</button></div>
      </form>
    </AuthShell>
  );
}

function Head() {
  const st = useStore();
  const u = st.user;
  return (
    <div className="portalHead">
      <Brand />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="pill active" style={{ textTransform: 'capitalize' }}>{u ? u.name : ''}</span>
        <button className="ghost small" onClick={() => st.logout()}>Sign out</button>
      </div>
    </div>
  );
}

function ClientHome() {
  const st = useStore();
  const [bookingType, setBookingType] = useState(null);
  const { user, balance, eventTypes, bookings } = st;
  const today = todayStr();
  const rows = [...bookings].sort((a, b) => (b.date + (b.startTime || '')).localeCompare(a.date + (a.startTime || '')));

  return (
    <>
      <Head />
      <div className="balanceCard">
        <div className="lbl">Credit balance</div>
        <div className="num">{balance == null ? '—' : fmtMoney(balance)} <span style={{ fontSize: 15, color: 'var(--sub)' }}>credits</span></div>
        <div className="muted" style={{ marginTop: 4 }}>{user.accountName || user.accountCity || 'Your store'}</div>
      </div>

      <h2 style={{ fontSize: 17, marginTop: 0, marginBottom: 4 }}>Book an activation or training</h2>
      <div className="muted" style={{ marginBottom: 14 }}>Pick a program and your Territory team will staff it at your location. Cost is reserved from your balance when approved.</div>
      {eventTypes.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--sub)', padding: 24 }}>No programs available yet — your rep is setting them up.</div>
      ) : (
        <div className="row" style={{ marginBottom: 8 }}>
          {eventTypes.map((et) => (
            <div className="card bookingBig" key={et.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }} onClick={() => setBookingType(et)}>
              <div>
                <div style={{ fontWeight: 700 }}>{et.name}</div>
                <div className="muted">{et.baseHours}h · from {fmtMoney(et.basePriceCredits)} cr</div>
              </div>
              <div style={{ fontSize: 20, color: 'var(--brand)' }}>+</div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 17, marginBottom: 12, marginTop: 26 }}>Your bookings</h2>
      {rows.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--sub)', padding: 24 }}>No bookings yet. Redemption requests you submit appear here.</div>
      ) : (
        rows.map((b) => {
          const canCancel = b.status === 'requested';
          const passed = b.date < today && b.status === 'approved';
          return (
            <div className="card" key={b.id} style={{ marginBottom: 10 }}>
              <div className="statusLine">
                <span className={`pill ${passed ? STATUS_PILL.completed : (STATUS_PILL[b.status] || 'prospect')}`} style={{ minWidth: 84, textAlign: 'center' }}>{passed ? 'Completed' : (STATUS_LABEL[b.status] || b.status)}</span>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <b>{b.eventTypeName}</b>
                  <div className="muted">{fmtDate(b.date)}{b.startTime ? ` @ ${b.startTime}` : ''} · {Number(b.durationHours) || 0}h{b.creditsCharged != null ? ` · ${fmtMoney(b.creditsCharged)} cr` : ''}</div>
                </div>
                {canCancel && <button className="ghost small" style={{ color: 'var(--red)' }} onClick={() => { if (confirm('Cancel this request? No credits have been charged yet.')) st.cancelBooking(b.id).then(() => st.showToast('Request cancelled.')).catch((e) => st.showToast(e.message)); }}>Cancel request</button>}
              </div>
            </div>
          );
        })
      )}

      {bookingType && <BookingModal et={bookingType} onClose={() => setBookingType(null)} />}
    </>
  );
}

function BookingModal({ et, onClose }) {
  const st = useStore();
  const [date, setDate] = useState(todayStr());
  const [startTime, setStartTime] = useState('');
  const [duration, setDuration] = useState(String(et.baseHours || 0));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const hours = Number(duration) > 0 ? Number(duration) : Number(et.baseHours || 0);
  const cost = creditEstimate(et, hours);
  const tooLittle = st.balance != null && st.balance < cost;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await st.book({ eventTypeId: et.id, date, startTime: startTime || null, durationHours: hours, notes: notes || null });
      st.showToast('Request sent to your rep — status updates here as soon as it’s approved.');
      setBusy(false); onClose();
    } catch (e) {
      setErr(e.message);
      if (e.message.includes('insufficient credits')) st.showToast('Not enough credits for this booking yet.');
      else st.showToast(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modalBg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal card">
        <h3 style={{ marginTop: 0 }}>Book {et.name}</h3>
        <label>Date</label>
        <input type="date" min={todayStr()} value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="grid2">
          <div>
            <label>Start time</label>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div>
            <label>Duration (hours)</label>
            <input type="number" min="1" max="24" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
        </div>
        <label>Anything the team should know?</label>
        <textarea rows="2" value={notes} placeholder="e.g. high-volume Friday, sample fridge request" onChange={(e) => setNotes(e.target.value)} />
        <div className="card" style={{ background: tooLittle ? 'var(--amber-soft)' : 'var(--panel2)', marginTop: 6, marginBottom: 0 }}>
          {tooLittle
            ? <>Estimated cost <b style={{ color: 'var(--amber)' }}>{fmtMoney(cost)} cr</b> — <b>above your balance</b> of {fmtMoney(st.balance)} cr.</>
            : <>Estimated cost <b style={{ color: 'var(--amber)' }}>{fmtMoney(cost)} cr</b> on approval. Balance: {fmtMoney(st.balance)} cr.</>}
        </div>
        {err && <div style={{ color: 'var(--red)', marginTop: 8, fontSize: 12.5 }}>{err}</div>}
        <div className="flexEnd">
          <button className="ghost" onClick={onClose}>Close</button>
          <button className="primary" disabled={busy || !date} onClick={submit}>{busy ? 'Sending…' : 'Send request'}</button>
        </div>
      </div>
    </div>
  );
}

function StaffHome() {
  const st = useStore();
  const { user, bookings } = st;
  const today = todayStr();
  const up = bookings.filter((b) => b.status === 'approved' && b.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = bookings.filter((b) => b.date < today || b.status === 'completed').sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <Head />
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ margin: 0 }}>My events</h2>
        <div className="muted" style={{ marginTop: 2 }}>Assignments for {user.name} from the Territory HQ console.</div>
      </div>

      <h2 style={{ fontSize: 15, marginBottom: 10, marginTop: 0 }}>Upcoming</h2>
      {up.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--sub)', padding: 24 }}>Nothing scheduled yet.</div>
      ) : (
        up.map((b) => (
          <div className="card" key={b.id} style={{ marginBottom: 10 }}>
            <div className="statusLine">
              <span className="pill active" style={{ minWidth: 84, textAlign: 'center' }}>{fmtDate(b.date)}</span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <b>{b.eventTypeName}</b>
                <div className="muted">{b.accountName}{b.accountCity ? ` · ${b.accountCity}` : ''}{b.startTime ? ` @ ${b.startTime}` : ''} · {Number(b.durationHours) || 0}h</div>
              </div>
              <div className="muted">{b.creditsCharged != null ? `${fmtMoney(b.creditsCharged)} cr` : ''}</div>
            </div>
          </div>
        ))
      )}

      <h2 style={{ fontSize: 15, marginBottom: 10 }}>Past</h2>
      {past.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--sub)', padding: 24 }}>No completed events yet.</div>
      ) : (
        past.map((b) => (
          <div className="card" key={b.id} style={{ marginBottom: 8, padding: 12 }}>
            <div className="statusLine">
              <span className="pill activation" style={{ minWidth: 84, textAlign: 'center' }}>{fmtDate(b.date)}</span>
              <b>{b.eventTypeName}</b>
              <span className="muted">{b.accountName} · {Number(b.durationHours) || 0}h</span>
            </div>
          </div>
        ))
      )}
    </>
  );
}