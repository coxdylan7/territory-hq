import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { creditEstimate, todayStr } from '../utils';
import { Section, Stat, Empty } from '../components';

const STATUS_PILL = { requested: 'tracking', approved: 'active', declined: 'inactive', cancelled: 'prospect', completed: 'activation' };
const STATUS_LABEL = { requested: 'Requested', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled', completed: 'Completed' };

export default function Bookings() {
  const st = useStore();
  const [approveBk, setApproveBk] = useState(null);
  const [declineBk, setDeclineBk] = useState(null);
  const [invite, setInvite] = useState({ role: 'client', email: '', accountId: '' });
  const [inviteLink, setInviteLink] = useState('');

  async function reload() {
    try {
      const [bookings, credits, eventTypes, portalUsers] = await Promise.all([
        api.get('/api/bookings'), api.get('/api/credits'), api.get('/api/event-types'), api.get('/api/portal-users'),
      ]);
      st.set({ bookings, credits, eventTypes, portalUsers });
    } catch (e) { st.showToast('Reload failed: ' + e.message); }
  }

  const today = todayStr();
  const plus14 = (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10); })();
  const rows = [...st.bookings].sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
  const norm = rows.map((b) => (b.status === 'approved' && b.date < today ? { ...b, status: 'completed' } : b));
  const requests = norm.filter((b) => b.status === 'requested');
  const upcoming = norm.filter((b) => (b.status === 'approved') && b.date >= today && b.date <= plus14);
  const archive = norm.filter((b) => ['declined', 'cancelled', 'completed'].includes(b.status));
  const staff = st.portalUsers.filter((u) => u.role === 'staff');

  const typeById = (id) => st.eventTypes.find((t) => t.id === id) || null;

  async function doApprove(bk) {
    setApproveBk(null);
    try {
      await api.put('/api/bookings/' + bk.id + '/approve', { ambassadorUserId: approveBk.ambassadorUserId || null });
      st.showToast('Approved ' + bk.eventTypeName + ' for ' + bk.accountName + '.');
      await reload();
    } catch (e) { st.showToast('Approve failed: ' + e.message); }
  }

  async function doDecline(bk) {
    setDeclineBk(null);
    try {
      await api.put('/api/bookings/' + bk.id + '/decline', { notes: declineBk.notes || '' });
      st.showToast('Declined ' + bk.eventTypeName + ' for ' + bk.accountName + '.');
      await reload();
    } catch (e) { st.showToast('Decline failed: ' + e.message); }
  }

  async function doCancel(bk) {
    if (!confirm('Cancel this booking? Credits already charged will be refunded.')) return;
    try {
      await api.put('/api/bookings/' + bk.id + '/cancel', {});
      st.showToast('Booking cancelled. Credits refunded.');
      await reload();
    } catch (e) { st.showToast('Cancel failed: ' + e.message); }
  }

  async function createInvite() {
    if (!invite.email || !invite.email.includes('@')) { st.showToast('Enter a valid email.'); return; }
    if (invite.role === 'client' && !invite.accountId) { st.showToast('Pick the client account to link.'); return; }
    try {
      const r = await api.post('/api/portal-invites', invite);
      setInviteLink(r.link);
      st.showToast('Invite created — share the link to activate the account.');
      setInvite({ role: 'client', email: '', accountId: '' });
      await reload();
    } catch (e) { st.showToast('Invite failed: ' + e.message); }
  }

  async function toggleUser(u) {
    await api.put('/api/portal-users/' + u.id + '/status', { status: u.status === 'active' ? 'suspended' : 'active' });
    await reload();
  }

  const pm = (id, n, i) => id === n || id === i;

  return (
    <>
      <h2 className="disp" style={{ fontSize: 20 }}>Store bookings</h2>
      <div className="muted" style={{ margin: '6px 0 14px' }}>
        Stores redeem their credit balance here by requesting brand activations and budtender trainings. Approve a request to charge the client's credits and staff the event.
      </div>
      <div className="cards4">
        <Stat num={requests.length} lbl="Awaiting review" />
        <Stat num={upcoming.length} lbl="Upcoming 14 days" />
        <Stat num={staff.length} lbl="Staff on portal" />
        <Stat num={st.portalUsers.filter((u) => u.role === 'client' && u.status === 'active').length} lbl="Active client users" />
      </div>

      {requests.length > 0 && (
        <>
          <Section>Requests to review</Section>
          {requests.map((b) => (
            <div className="card" style={{ marginBottom: 10 }} key={b.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <b>{b.eventTypeName}</b> <span className="muted">· {b.accountName}{b.licenseNumber ? ` (${b.licenseNumber})` : ''}</span>
                  <div className="muted" style={{ marginTop: 2 }}>
                    {b.date}{b.startTime ? ` @ ${b.startTime}` : ''} · {Number(b.durationHours) || 0}h {typeById(b.eventTypeId) ? `· ~${creditEstimate(typeById(b.eventTypeId), b.durationHours)} cr` : ''}
                    {b.notesClient ? ` · "${b.notesClient}"` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="ghost small" style={{ color: 'var(--red)' }} onClick={() => setDeclineBk({ ...b, notes: '' })}>Decline</button>
                  <button className="primary small" onClick={() => setApproveBk({ ...b, ambassadorUserId: '' })}>Approve & charge</button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      {upcoming.length > 0 && (
        <>
          <Section>Upcoming activations & trainings</Section>
          {upcoming.map((b) => (
            <div className="card" style={{ marginBottom: 10 }} key={b.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <b>{b.eventTypeName}</b> <span className="muted">· {b.accountName}</span>
                  {b.ambassadorName ? <span className="pill active" style={{ marginLeft: 8 }}>{b.ambassadorName}</span> : null}
                  <div className="muted" style={{ marginTop: 2 }}>
                    {b.date}{b.startTime ? ` @ ${b.startTime}` : ''} · {Number(b.durationHours) || 0}h · {b.creditsCharged != null ? `${b.creditsCharged} cr charged` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="ghost small" onClick={() => doCancel(b)}>Cancel & refund</button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      <Section>Pricing — event types</Section>
      <div className="muted" style={{ marginBottom: 10 }}>Clients see these prices when booking. Cost = base credits + extra hours beyond the base duration × extra-hour rate.</div>
      <table>
        <thead><tr><th>Event type</th><th>Base hours</th><th>Base credits</th><th>Extra hour</th><th>On</th><th></th></tr></thead>
        <tbody>
          {st.eventTypes.map((et) => <PricingRow et={et} key={et.id} onSaved={reload} onToast={(m) => st.showToast(m)} />)}
        </tbody>
      </table>

      <Section>Portal invites & staff</Section>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Invite someone to the store portal</div>
        <div className="grid2">
          <div>
            <label>Role</label>
            <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value, accountId: '' })}>
              <option value="client">Client (store staff)</option>
              <option value="staff">Staff (ambassador / trainer)</option>
            </select>
          </div>
          <div>
            <label>Email</label>
            <input value={invite.email} placeholder="name@store.com" onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
          </div>
        </div>
        {invite.role === 'client' && (
          <div>
            <label>Linked client account</label>
            <select value={invite.accountId} onChange={(e) => setInvite({ ...invite, accountId: e.target.value })}>
              <option value="">— select —</option>
              {st.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.city ? ` (${a.city})` : ''}</option>)}
            </select>
          </div>
        )}
        <div className="flexEnd"><button className="primary" onClick={createInvite}>Create invite link</button></div>
        {inviteLink && (
          <div className="card" style={{ background: 'var(--panel2)', marginTop: 10 }}>
            <div className="muted" style={{ marginBottom: 6 }}>Share this link with <b>{invite.email}</b> — it expires in 7 days and works once:</div>
            <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all', background: 'var(--panel)', padding: 10, borderRadius: 8 }}>{inviteLink}</div>
            <div className="flexEnd"><button className="ghost small" onClick={() => { navigator.clipboard.writeText(inviteLink); st.showToast('Invite link copied.'); }}>Copy</button></div>
          </div>
        )}
      </div>

      {st.portalUsers.length === 0 ? <Empty>No portal users yet. Create invites above for your stores and ambassadors.</Empty> : (
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Linked to</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {st.portalUsers.map((u) => (
              <tr key={u.id}>
                <td data-label="Name"><b>{u.name || '—'}</b></td>
                <td data-label="Email">{u.email}</td>
                <td data-label="Role"><span className="pill">{u.role}</span></td>
                <td data-label="Linked to">{pm(u.role, 'client') ? (u.accountName || '—') : '—'}</td>
                <td data-label="Status"><span className={`pill ${u.status === 'active' ? 'active' : 'inactive'}`}>{u.status}</span></td>
                <td data-label=""><button className="ghost small" style={{ color: u.status === 'active' ? 'var(--red)' : 'var(--green)' }} onClick={() => toggleUser(u)}>{u.status === 'active' ? 'Suspend' : 'Reactivate'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {archive.length > 0 && (
        <>
          <Section>Archive</Section>
          {archive.slice(0, 50).map((b) => (
            <div className="stopRow" key={b.id} style={{ fontSize: 13 }}>
              <span className={`pill ${STATUS_PILL[b.status] || 'prospect'}`} style={{ minWidth: 74, textAlign: 'center' }}>{STATUS_LABEL[b.status] || b.status}</span>
              <div style={{ flex: 1 }}><b>{b.eventTypeName}</b> <span className="muted">· {b.accountName}</span></div>
              <span className="muted">{b.date}{b.creditsCharged != null ? ` · ${b.creditsCharged} cr` : ''}</span>
            </div>
          ))}
        </>
      )}

      {approveBk && <ApproveModal bk={approveBk} setBk={setApproveBk} onApprove={doApprove} staff={staff} type={typeById(approveBk.eventTypeId)} />}
      {declineBk && <DeclineModal bk={declineBk} setBk={setDeclineBk} onDecline={doDecline} />}
    </>
  );
}

function PricingRow({ et, onSaved, onToast }) {
  const [f, setF] = useState({ ...et });
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await api.put('/api/event-types/' + et.id, { ...f, baseHours: Number(f.baseHours), basePriceCredits: Number(f.basePriceCredits), extraHourCredits: Number(f.extraHourCredits) });
      onToast('Pricing saved.');
      await onSaved();
    } catch (e) { onToast('Save failed: ' + e.message); }
    setSaving(false);
  }
  return (
    <tr>
      <td data-label="Event type">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ minWidth: 150 }} />
      </td>
      <td data-label="Base hours"><input type="number" step="0.5" value={f.baseHours} style={{ width: 70 }} onChange={(e) => setF({ ...f, baseHours: e.target.value })} /></td>
      <td data-label="Base credits"><input type="number" step="1" value={f.basePriceCredits} style={{ width: 80 }} onChange={(e) => setF({ ...f, basePriceCredits: e.target.value })} /></td>
      <td data-label="Extra hour"><input type="number" step="1" value={f.extraHourCredits} style={{ width: 80 }} onChange={(e) => setF({ ...f, extraHourCredits: e.target.value })} /></td>
      <td data-label="On">
        <label className="checkline" style={{ margin: 0 }}>
          <input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
        </label>
      </td>
      <td data-label=""><button className="ghost small" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></td>
    </tr>
  );
}

function ApproveModal({ bk, setBk, onApprove, staff, type }) {
  const [amb, setAmb] = useState('');
  const [notes, setNotes] = useState('');
  const cost = creditEstimate(type, bk.durationHours);
  return (
    <div className="modalBg" onClick={(e) => { if (e.target === e.currentTarget) setBk(null); }}>
      <div className="modal card">
        <h3>Approve & charge</h3>
        <div className="muted" style={{ marginBottom: 10 }}>
          <b>{bk.eventTypeName}</b> · {bk.accountName} · {bk.date}{bk.startTime ? ` @ ${bk.startTime}` : ''} · {Number(bk.durationHours) || 0}h
        </div>
        <div className="card" style={{ background: 'var(--panel2)', marginBottom: 10 }}>
          This will charge the client <b className="disp" style={{ color: 'var(--amber)' }}>{cost} credits</b> and staff the event.
        </div>
        <label>Assign ambassador / trainer</label>
        <select value={amb} onChange={(e) => setAmb(e.target.value)}>
          <option value="">— unassigned (assign later) —</option>
          {staff.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` (${u.email})` : ''}</option>)}
        </select>
        <label>Note (seen by staff / client)</label>
        <input value={notes} placeholder="e.g. bring sampler kit" onChange={(e) => setNotes(e.target.value)} />
        <div className="flexEnd">
          <button className="ghost" onClick={() => setBk(null)}>Cancel</button>
          <button className="primary" onClick={() => onApprove({ ...bk, ambassadorUserId: amb, notes })}>Approve & charge</button>
        </div>
      </div>
    </div>
  );
}

function DeclineModal({ bk, setBk, onDecline }) {
  const [notes, setNotes] = useState('');
  return (
    <div className="modalBg" onClick={(e) => { if (e.target === e.currentTarget) setBk(null); }}>
      <div className="modal card">
        <h3>Decline request</h3>
        <div className="muted" style={{ marginBottom: 10 }}>Declining <b>{bk.eventTypeName}</b> for <b>{bk.accountName}</b> on {bk.date} — no credits are charged.</div>
        <label>Reason (shown to client)</label>
        <textarea rows="2" value={notes} placeholder="e.g. no availability that week" onChange={(e) => setNotes(e.target.value)} />
        <div className="flexEnd">
          <button className="ghost" onClick={() => setBk(null)}>Cancel</button>
          <button className="ghost" style={{ color: 'var(--red)' }} onClick={() => onDecline({ ...bk, notes })}>Decline request</button>
        </div>
      </div>
    </div>
  );
}