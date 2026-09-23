import { useEffect, useState } from 'react';
import { useStore } from './store';
import { api, setToken } from './api';
import { todayStr, creditEstimate, fmtDate, fmtMoney } from './utils';

const STATUS_PILL = { requested: 'requested', approved: 'approved', confirmed: 'confirmed', declined: 'declined', cancelled: 'cancelled', completed: 'completed' };

export default function App() {
  const st = useStore();

  useEffect(() => {
    st.init();
    const onUnauth = () => st.set({ auth: 'none', user: null, balance: null, eventTypes: [], bookings: [] });
    window.addEventListener('tp:unauthorized', onUnauth);
    return () => window.removeEventListener('tp:unauthorized', onUnauth);
  }, []);

  const path = window.location.pathname;
  const world = path.startsWith('/staff/') ? 'staff' : 'store';
  const invite = (() => {
    const m = path.match(/^\/(store|staff)\/invite\/([a-f0-9]+)/i);
    return m ? { world: m[1].toLowerCase(), token: m[2] } : null;
  })();

  if (st.auth === 'boot') return <Splash world={world} />;

  if (st.auth === 'none') {
    const inviteRoleAmbassador = invite && invite.world === 'staff';
    return invite
      ? <InviteSignup key={invite.token} token={invite.token} world={invite.world} ambassador={inviteRoleAmbassador} />
      : <Login world={world} />;
  }

  const role = st.user ? st.user.role : null;
  if (role === 'brand_ambassador' && world !== 'staff') {
    window.location.replace('/staff/');
    return <Splash world="staff" />;
  }
  if (role !== 'brand_ambassador' && world !== 'store') {
    window.location.replace('/store/');
    return <Splash world="store" />;
  }

  return (
    <div className={`wrap world-${world}`}>
      {role === 'brand_ambassador' ? <StaffApp /> : <StoreApp />}
      {st.toast && <div className="toast">{st.toast}</div>}
    </div>
  );
}

/* ---------------------------------------------------------- shared chrome */

function Splash({ world }) {
  return (
    <div className="authWrap">
      <Brand center world={world} />
      <div className="card authCard" style={{ marginTop: 18, textAlign: 'center', color: 'var(--sub)' }}>Loading…</div>
    </div>
  );
}

function Brand({ center, world = 'store' }) {
  return (
    <div className={`brand world-${world} ${center ? 'center' : ''}`}>
      <div className="logo">◈</div>
      <div>
        <h1>{world === 'staff' ? 'Ambassador Hub' : 'Store Portal'}</h1>
        <span>{world === 'staff' ? 'Your schedule & events' : 'Credit redemption'}</span>
      </div>
    </div>
  );
}

function Head({ world }) {
  const st = useStore();
  return (
    <div className="topbar">
      <Brand world={world} />
      <div className="userChip">
        <span className="pill soft" style={{ textTransform: 'capitalize' }}>{st.user ? (st.user.name || st.user.email) : ''}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => st.logout()}>Sign out</button>
      </div>
    </div>
  );
}

function Toast() {
  const st = useStore();
  return st.toast ? <div className="toast">{st.toast}</div> : null;
}

/* ---------------------------------------------------------- auth views */

function Login({ world }) {
  const st = useStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  async function go(e) {
    e.preventDefault();
    setBusy(true);
    try { await st.login(email, password); }
    catch (err) { st.showToast(err.message); }
    setBusy(false);
  }
  return (
    <div className="authWrap">
      <Brand center world={world} />
      <div className="card authCard" style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 0, marginBottom: 4 }}>{world === 'staff' ? 'Welcome back' : 'Welcome back'}</h2>
        <div className="muted" style={{ marginBottom: 8 }}>
          {world === 'staff' ? 'Your events and schedule, all in one place.' : 'Book activations & trainings with your credits.'}
        </div>
        <form onSubmit={go}>
          <label>Email</label>
          <input autoFocus type="email" value={email} placeholder="you@store.com" onChange={(e) => setEmail(e.target.value)} />
          <label>Password</label>
          <input type="password" value={password} placeholder="••••••••" onChange={(e) => setPassword(e.target.value)} />
          <div className="flexEnd" style={{ marginTop: 20 }}><button className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></div>
        </form>
      </div>
      <div className="authFaint">Powered by your Territory team</div>
      <Toast />
    </div>
  );
}

function InviteSignup({ token, world, ambassador }) {
  const st = useStore();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [accounts, setAccounts] = useState(null);
  const [q, setQ] = useState('');
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!ambassador) {
      api.get('/api/portal/available-accounts?token=' + encodeURIComponent(token))
        .then(setAccounts)
        .catch(() => setErr('Could not load the store list — the invite may have expired.'));
    }
  }, [token, ambassador]);

  const filtered = (accounts || []).filter((a) => !q || (a.name + ' ' + a.city + ' ' + a.licenseNumber).toLowerCase().includes(q.toLowerCase()));

  async function go(e) {
    e.preventDefault();
    setErr('');
    if (!ambassador && !accountId) { setErr('Pick your store below.'); return; }
    setBusy(true);
    try {
      const r = await api.post('/api/auth/invite-signup', { token, name, password, accountId: ambassador ? undefined : accountId });
      if (!r.token) throw new Error('no session returned');
      setToken(r.token);
      const me = await api.get('/api/me');
      st.set({ user: me, auth: 'app' });
      await st.refresh(me);
      window.history.replaceState({}, '', world === 'staff' ? '/staff/' : '/store/');
      st.showToast(ambassador ? 'Welcome! Your schedule is ready.' : 'Account activated — enjoy your credits!');
    } catch (e2) {
      setErr(e2.message || 'Invite could not be activated');
    }
    setBusy(false);
  }

  return (
    <div className={`wrap world-${world}`} style={{ maxWidth: 520, margin: '0 auto' }}>
      <Brand center world={world} />
      <div className="card authCard" style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 0, marginBottom: 4 }}>Claim your invite</h2>
        <div className="muted" style={{ marginBottom: 8 }}>
          {ambassador ? 'You’re joining the team — set your name and password to get started.' : 'Welcome aboard! Set your name and password, then pick which store you’re from.'}
        </div>
        {err && <div className="onnote">{err}</div>}
        <form onSubmit={go}>
          <label>Your name</label>
          <input autoFocus value={name} placeholder="Alex Rivera" onChange={(e) => setName(e.target.value)} />
          <label>Password</label>
          <input type="password" value={password} placeholder="6+ characters" onChange={(e) => setPassword(e.target.value)} />
          {!ambassador && (
            <>
              <label>Which store are you from?</label>
              <input value={q} placeholder="Search by name or city…" onChange={(e) => setQ(e.target.value)} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {accounts === null && <span className="muted">Loading stores…</span>}
                {(filtered || []).map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className={`btn btn-sm ${accountId === a.id ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setAccountId(a.id)}
                  >
                    {a.name}{a.city ? ` · ${a.city}` : ''}
                  </button>
                ))}
                {!accounts && <span className="muted">No stores loaded.</span>}
                {(filtered || []).length === 0 && accounts && <span className="muted">No matches.</span>}
              </div>
              {accountId && <div className="onnote" style={{ marginTop: 12 }}>You’ll be linked to this store. Your credit balance and bookings stay with it.</div>}
            </>
          )}
          <div className="flexEnd" style={{ marginTop: 20 }}>
            <button className="btn btn-primary" disabled={busy || !name || password.length < 6}>{busy ? 'Activating…' : 'Activate & sign in'}</button>
          </div>
        </form>
      </div>
      <Toast />
    </div>
  );
}

/* ---------------------------------------------------------- STORE WORLD */

function StoreApp() {
  const st = useStore();
  const [view, setView] = useState('home');
  const nav = (id, label) => (
    <button key={id} className={`btn btn-sm ${view === id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView(id)}>{label}</button>
  );
  return (
    <>
      <Head world="store" />
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {nav('home', 'Home')}
        {nav('schedule', 'My bookings')}
      </div>
      {view === 'home' ? <StoreHome onBook={() => setView('schedule')} /> : <StoreSchedule />}
    </>
  );
}

function StoreHome({ onBook }) {
  const st = useStore();
  const [bookingType, setBookingType] = useState(null);
  const { user, balance, eventTypes, bookings } = st;
  const today = todayStr();
  const live = bookings.filter((b) => b.status === 'approved' || b.status === 'confirmed').filter((b) => b.date >= today || (b.date === today));
  const next = [...live].sort((a, b) => a.date.localeCompare(b.date))[0];
  const canBook = st.user.role === 'store_manager';

  return (
    <>
      <div className="hero">
        <div className="lbl">Credit balance</div>
        <div className="num">{balance == null ? '—' : fmtMoney(balance)} <span style={{ fontSize: 15, color: 'var(--sub)' }}>credits</span></div>
        <div className="foot">{user.accountName || user.accountCity || 'Your store'}</div>
        {!canBook && <div className="onnote" style={{ marginTop: 10 }}>
          You have a <b>read-only</b> store account. Ask your store manager to submit booking requests.
        </div>}
      </div>

      {next && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="muted" style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 11, letterSpacing: .6 }}>Next event</div>
          <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 17, marginTop: 4 }}>
            {next.eventTypeName} · {fmtDate(next.date)}{next.startTime ? ` @ ${next.startTime}` : ''}
          </div>
          {next.ambassadorName ? <div className="muted" style={{ marginTop: 2 }}>Your ambassador: {next.ambassadorName}</div> : null}
        </div>
      )}

      <h2 className="sec">Book an activation or training</h2>
      <div className="muted" style={{ marginBottom: 12 }}>
        Pick a program and your Territory team will staff it at your location. The cost comes out of your credit balance once approved.
      </div>
      {eventTypes.length === 0 ? (
        <div className="empty">No programs available yet — your rep is setting them up.</div>
      ) : (
        <div className="row">
          {eventTypes.map((et) => (
            <div className="card tap prog" key={et.id} onClick={() => canBook && setBookingType(et)} style={{ opacity: canBook ? 1 : .7 }}>
              <span className="ic">{String(et.name || '').includes('train') || String(et.name || '').toLowerCase().includes('training') ? '🎓' : '🎉'}</span>
              <span className="name">{et.name}</span>
              <span className="meta">{et.baseHours}h · from {fmtMoney(et.basePriceCredits)} cr</span>
              <span className="muted" style={{ fontSize: 12 }}>{canBook ? 'Book this program →' : 'View only'}</span>
            </div>
          ))}
        </div>
      )}

      <button className="btn btn-ghost btn-sm" style={{ marginTop: 18 }} onClick={onBook}>See all requests & schedule →</button>
      {bookingType && canBook && <BookingModal et={bookingType} onClose={() => setBookingType(null)} />}
    </>
  );
}

function StoreSchedule() {
  const st = useStore();
  const today = todayStr();
  const rows = [...st.bookings].sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
  const live = rows.map((b) => ((b.status === 'approved' || b.status === 'confirmed') && b.date < today ? { ...b, status: 'completed' } : b));
  const upcoming = live.filter((b) => b.date >= today && (b.status === 'requested' || b.status === 'approved' || b.status === 'confirmed'));
  const past = live.filter((b) => b.date < today || b.status === 'completed' || b.status === 'declined' || b.status === 'cancelled').reverse();

  return (
    <>
      <h2 className="sec" style={{ marginTop: 0 }}>My bookings</h2>
      {upcoming.length === 0 && past.length === 0 && <div className="empty">No bookings yet. Submit your first request from Home.</div>}

      {upcoming.length > 0 && <div className="muted" style={{ marginBottom: 8 }}>Upcoming & in review</div>}
      {upcoming.map((b) => (
        <div className="card eve" key={b.id}>
          <div className="badge-day">
            <div className="d">{Number(b.date.slice(8, 10))}</div>
            <div className="m">{b.date.slice(5, 7)}</div>
          </div>
          <div className="main">
            <div className="ttl">{b.eventTypeName}</div>
            <div className="sub">
              {fmtDate(b.date)}{b.startTime ? ` @ ${b.startTime}` : ''} · {Number(b.durationHours) || 0}h
              {b.creditsCharged != null ? ` · ${fmtMoney(b.creditsCharged)} cr` : ''}
              {b.ambassadorName ? ` · ${b.ambassadorName}` : ''}
            </div>
            {b.notesAdmin ? <div className="onnote" style={{ marginTop: 6 }}>Note: {b.notesAdmin}</div> : null}
          </div>
          <span className={`pill ${STATUS_PILL[b.status] || 'soft'}`}>{STATUS_LABEL[b.status] || b.status}</span>
          {b.status === 'requested' && (
            <button className="btn btn-danger btn-sm" onClick={() => { if (confirm('Cancel this request? No credits have been charged yet.')) st.cancelBooking(b.id).then(() => st.showToast('Request cancelled.')).catch((e) => st.showToast(e.message)); }}>
              Cancel request
            </button>
          )}
        </div>
      ))}

      {past.length > 0 && <div className="muted" style={{ margin: '18px 0 8px' }}>History</div>}
      {past.map((b) => (
        <div className="card eve" key={b.id} style={{ opacity: .75 }}>
          <div className="badge-day">
            <div className="d">{Number(b.date.slice(8, 10))}</div>
            <div className="m">{b.date.slice(5, 7)}</div>
          </div>
          <div className="main">
            <div className="ttl">{b.eventTypeName}</div>
            <div className="sub">{fmtDate(b.date)}{b.startTime ? ` @ ${b.startTime}` : ''} · {Number(b.durationHours) || 0}h</div>
          </div>
          <span className={`pill ${STATUS_PILL[b.status] || 'soft'}`}>{STATUS_LABEL[b.status] || b.status}</span>
        </div>
      ))}
    </>
  );
}

const STATUS_LABEL = { requested: 'Requested', approved: 'Approved', confirmed: 'Confirmed', declined: 'Declined', cancelled: 'Cancelled', completed: 'Completed' };

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
      await st.book({ eventTypeId: et.id, date, startTime: startTime || null, durationHours: hours, notes: notes || null });
      st.showToast('Request sent to your rep — you’ll see the status here.');
      setBusy(false); onClose();
    } catch (e) {
      setErr(e.message);
      st.showToast(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modalBg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal card">
        <h3 style={{ marginTop: 0, marginBottom: 4 }}>Book {et.name}</h3>
        <div className="muted" style={{ marginBottom: 8 }}>We’ll confirm the date and staff it with your team.</div>
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
        <div className={`card ${tooLittle ? '' : ''}`} style={{ background: tooLittle ? 'var(--amber-soft)' : 'var(--card2)', marginTop: 8, marginBottom: 0 }}>
          {tooLittle
            ? <>Estimated cost <b style={{ color: 'var(--amber)' }}>{fmtMoney(cost)} cr</b> — <b>above your balance</b> of {fmtMoney(st.balance)} cr.</>
            : <>Estimated cost <b style={{ color: 'var(--accent-ink)' }}>{fmtMoney(cost)} cr</b> on approval. Balance: {fmtMoney(st.balance)} cr.</>}
        </div>
        {err && <div className="onnote">{err}</div>}
        <div className="flexEnd">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" disabled={busy || !date} onClick={submit}>{busy ? 'Sending…' : 'Send request'}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- STAFF WORLD */

function StaffApp() {
  const st = useStore();
  const today = todayStr();
  const live = st.bookings.map((b) => ((b.status === 'approved' || b.status === 'confirmed') && b.date < today ? { ...b, status: 'completed' } : b));
  const up = live.filter((b) => b.date >= today && (b.status === 'approved' || b.status === 'confirmed'));
  const past = live.filter((b) => b.status === 'completed' || b.date < today).sort((a, b) => b.date.localeCompare(a.date));
  const groups = [];
  for (const b of up) {
    const last = groups[groups.length - 1];
    if (last && last.date === b.date) last.items.push(b); else groups.push({ date: b.date, items: [b] });
  }

  return (
    <>
      <Head world="staff" />
      <div className="hero">
        <div className="lbl">Your week</div>
        <div className="num" style={{ fontSize: 24 }}>{up.length} {up.length === 1 ? 'event' : 'events'} coming up</div>
        {up[0] ? (
          <div className="foot" style={{ marginTop: 8 }}>
            <b>Next up:</b> {up[0].eventTypeName} at {up[0].accountName} — {fmtDate(up[0].date)}{up[0].startTime ? ` @ ${up[0].startTime}` : ''}
          </div>
        ) : (
          <div className="foot" style={{ marginTop: 8 }}>Nothing scheduled right now. Your team assigns events from the console.</div>
        )}
      </div>

      {groups.map((g) => (
        <div key={g.date}>
          <div className="muted" style={{ margin: '18px 0 8px', fontWeight: 700, textTransform: 'uppercase', fontSize: 11, letterSpacing: .5 }}>
            {fmtDate(g.date)} <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>· {g.items.length} event{g.items.length > 1 ? 's' : ''}</span>
          </div>
          {g.items.map((b) => (
            <div className="card eve" key={b.id}>
              <div className="badge-day">
                <div className="d">{Number(b.date.slice(8, 10))}</div>
                <div className="m">{b.date.slice(5, 7)}</div>
              </div>
              <div className="main">
                <div className="ttl">{b.eventTypeName}</div>
                <div className="sub">
                  <b>{b.accountName}</b>{b.accountCity ? ` · ${b.accountCity}` : ''} · {b.startTime ? `${b.startTime}` : 'time TBD'} · {Number(b.durationHours) || 0}h
                </div>
                {b.licenseNumber ? <div className="addr">{b.licenseNumber}</div> : null}
                {b.accountAddress ? <div className="addr">{b.accountAddress}</div> : null}
                {b.notesAdmin ? <div className="onnote" style={{ marginTop: 6 }}>Team note: {b.notesAdmin}</div> : null}
              </div>
              <span className={`pill ${STATUS_PILL[b.status] || 'soft'}`}>{STATUS_LABEL[b.status] || b.status}</span>
              {b.status === 'approved' && (
                <div className="actions" style={{ flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                  <button className="btn btn-primary btn-sm" onClick={() => st.acceptBooking(b.id).then(() => st.showToast('Event confirmed — nice!')).catch((e) => st.showToast(e.message))}>Accept</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { if (confirm('Decline this assignment? It will be reopened for reassignment.')) st.declineAssignment(b.id).then(() => st.showToast('Assignment declined.')).catch((e) => st.showToast(e.message)); }}>Decline</button>
                </div>
              )}
              {b.status === 'confirmed' && (
                <button className="btn btn-primary btn-sm" onClick={() => st.completeBooking(b.id).then(() => st.showToast('Marked complete.')).catch((e) => st.showToast(e.message))}>Mark complete</button>
              )}
              {b.accountAddress && (
                <button className="btn btn-ghost btn-sm" onClick={() => window.open('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(b.accountAddress + ', ' + (b.accountCity || '')), '_blank')}>Maps</button>
              )}
            </div>
          ))}
        </div>
      ))}

      {up.length === 0 && <div className="empty" style={{ marginTop: 6 }}>No upcoming events yet.</div>}

      {past.length > 0 && (
        <>
          <div className="muted" style={{ margin: '22px 0 8px', fontWeight: 700, textTransform: 'uppercase', fontSize: 11, letterSpacing: .5 }}>Past</div>
          {past.map((b) => (
            <div className="card eve" key={b.id} style={{ opacity: .72 }}>
              <div className="main">
                <div className="ttl">{b.eventTypeName}</div>
                <div className="sub">{fmtDate(b.date)} · {b.accountName} · {Number(b.durationHours) || 0}h</div>
              </div>
              <span className="pill completed">Completed</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}