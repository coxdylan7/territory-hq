import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { planForWeek, daysSince, geocode } from '../utils';
import { setPlanDay, creditBalance } from '../actions';
import { Pill, Empty, WeekNav } from '../components';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Accounts() {
  const st = useStore();
  const { accounts, acctSort, set } = st;
  const [editing, setEditing] = useState(null);

  let rows = [...accounts];
  if (acctSort === 'overdue') rows.sort((a, b) => daysSince(b.lastVisited) - daysSince(a.lastVisited));
  const plan = planForWeek(st.weekPlan, st.planWeek);

  async function onChangePlan(id, day) {
    await setPlanDay(id, day);
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 className="disp" style={{ fontSize: 20 }}>Accounts</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <WeekNav />
          <button className="ghost" onClick={() => set({ acctSort: acctSort === 'overdue' ? 'recent' : 'overdue' })}>
            {acctSort === 'overdue' ? 'Sorted: needs a visit first' : 'Sort by last visit'}
          </button>
          <button className="primary" onClick={() => setEditing({})}>+ New account</button>
        </div>
      </div>
      <div className="muted" style={{ margin: '6px 0 14px' }}>
        The <b>This week</b> column sets each account's visit day for week <b>{st.planWeek}</b>. It resets to a blank plan each new week; past weeks are kept in the Route Log.
      </div>

      {rows.length === 0 ? <Empty>No accounts yet. Add one manually, or pull candidates from OCM Watch.</Empty> : (
        <table>
          <thead><tr><th>Name</th><th>Status</th><th>This week</th><th>Priority</th><th>City</th><th>Last visit</th><th></th></tr></thead>
          <tbody>
            {rows.map((a) => {
              const ds = daysSince(a.lastVisited);
              const overdue = ds === Infinity || ds >= 21;
              const visitLabel = a.lastVisited ? `${a.lastVisited} (${ds}d ago)` : 'Never';
              const planned = plan[a.id] || '';
              return (
                <tr key={a.id}>
                  <td data-label="Name">
                    <b>{a.name}</b>
                    {a.dba ? <div className="muted">{a.dba}</div> : null}
                    {a.licenseNumber ? <div className="muted mono" style={{ fontSize: 11 }}>{a.licenseNumber}</div> : null}
                  </td>
                  <td data-label="Status"><Pill status={a.status} /></td>
                  <td data-label="This week">
                    <select style={{ width: 'auto', minWidth: 110 }} value={planned} onChange={(e) => onChangePlan(a.id, e.target.value)}>
                      <option value="">— not this week —</option>
                      {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </td>
                  <td data-label="Priority">{a.priority ? <span className="priority">★ {a.priorityRank || 1}</span> : '—'}</td>
                  <td data-label="City">{a.city}</td>
                  <td data-label="Last visit">{overdue ? <span style={{ color: 'var(--amber)', fontWeight: 600 }}>{visitLabel}</span> : visitLabel}</td>
                  <td data-label=""><button className="ghost small" onClick={() => setEditing(a)}>Edit</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {editing && <AccountModal existing={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

const COUNTIES = ['Albany', 'Bronx', 'Broome', 'Erie', 'Kings', 'Nassau', 'New York', 'Onondaga', 'Orange', 'Queens', 'Richmond', 'Suffolk', 'Westchester'];

function AccountModal({ existing, onClose }) {
  const st = useStore();
  const isEdit = existing.id ? true : false;
  const [form, setForm] = useState(() => ({
    licenseNumber: existing.licenseNumber || '',
    name: existing.name || '',
    dba: existing.dba || '',
    address: existing.address || '',
    city: existing.city || '',
    county: existing.county || '',
    contactName: existing.contactName || '',
    status: existing.status || 'Prospect',
    phone: existing.phone || '',
    email: existing.email || '',
    priority: !!existing.priority,
    priorityRank: existing.priorityRank || 1,
    notes: existing.notes || '',
  }));
  const [dupWarning, setDupWarning] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function submit(e) {
    e.preventDefault();
    const licenseNumber = form.licenseNumber.trim();
    if (!licenseNumber) { setDupWarning('License number is required.'); return; }
    const clash = st.accounts.find((a) => a.licenseNumber && a.licenseNumber === licenseNumber && (!isEdit || a.id !== existing.id));
    if (clash) { setDupWarning('An account with this license number already exists: ' + clash.name); return; }
    setDupWarning('');
    setSaving(true);
    st.showToast('Saving & locating…');
    const addr = form.address + ', ' + form.city + ', NY';
    const loc = await geocode(addr, st.settings.gmapsKey);
    const data = {
      id: isEdit ? existing.id : 'a' + Date.now(),
      name: form.name, dba: form.dba, address: form.address, city: form.city,
      county: form.county, phone: form.phone, email: form.email, contactName: form.contactName,
      status: form.status, priority: form.priority, priorityRank: parseInt(form.priorityRank) || 1,
      notes: form.notes, licenseNumber,
      lat: loc ? loc.lat : (isEdit ? existing.lat : null), lng: loc ? loc.lng : (isEdit ? existing.lng : null),
      source: isEdit ? existing.source : 'manual', lastVisited: isEdit ? existing.lastVisited : null,
    };
    try {
      if (isEdit) {
        await api.put('/api/accounts/' + existing.id, data);
        st.set({ accounts: st.accounts.map((a) => a.id === existing.id ? data : a) });
      } else {
        await api.post('/api/accounts', data);
        st.set({ accounts: [...st.accounts, data] });
      }
      onClose();
      st.showToast(loc ? 'Saved and located.' : 'Saved — address could not be located, route will skip it.');
    } catch (err) {
      if ((err.message || '').includes('409') || (err.message || '').toLowerCase().includes('duplicate')) {
        st.showToast('That license number is already on another account.');
      } else {
        st.showToast('Save failed: ' + err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function deleteAccount() {
    await api.del('/api/accounts/' + existing.id);
    st.set({ accounts: st.accounts.filter((a) => a.id !== existing.id) });
    onClose();
  }

  return (
    <div className="modalBg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <button className="closeX" onClick={onClose}>✕</button>
        <h3 className="disp">{isEdit ? 'Edit account' : 'New account'}</h3>
        <form onSubmit={submit}>
          <label>OCM license number {!isEdit && <span className="muted">(the unique ID for this client — required)</span>}</label>
          <input
            name="licenseNumber"
            value={form.licenseNumber}
            disabled={isEdit && existing.source === 'ocm'}
            style={isEdit && existing.source === 'ocm' ? { opacity: 0.7 } : {}}
            placeholder="e.g. OCM-RD-0001"
            required
            onChange={(e) => set({ licenseNumber: e.target.value })}
          />
          {dupWarning && <div className="muted" style={{ color: 'var(--red)', marginTop: 4 }}>{dupWarning}</div>}
          <div className="grid2" style={{ marginTop: 10 }}>
            <div><label>Store / business name</label><input value={form.name} required onChange={(e) => set({ name: e.target.value })} /></div>
            <div><label>DBA (if different)</label><input value={form.dba} onChange={(e) => set({ dba: e.target.value })} /></div>
          </div>
          <label>Street address</label><input value={form.address} placeholder="123 Main St" required onChange={(e) => set({ address: e.target.value })} />
          <div className="grid2">
            <div><label>City</label><input value={form.city} onChange={(e) => set({ city: e.target.value })} /></div>
            <div>
              <label>County</label>
              <input value={form.county} list="countyList" onChange={(e) => set({ county: e.target.value })} />
              <datalist id="countyList">{COUNTIES.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
          </div>
          <div className="grid2">
            <div><label>Contact name</label><input value={form.contactName} onChange={(e) => set({ contactName: e.target.value })} /></div>
            <div>
              <label>Status</label>
              <select value={form.status} onChange={(e) => set({ status: e.target.value })}>
                {['Prospect', 'Active', 'Tracking', 'Inactive'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="grid2">
            <div><label>Phone</label><input value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></div>
            <div><label>Email</label><input value={form.email} onChange={(e) => set({ email: e.target.value })} /></div>
          </div>
          <div className="grid2">
            <div>
              <label>Priority override</label>
              <label className="checkline" style={{ marginTop: 0 }}>
                <input type="checkbox" checked={form.priority} onChange={(e) => set({ priority: e.target.checked })} />
                Force early in route
                <input type="number" min="1" max="9" value={form.priorityRank} style={{ width: 55, marginLeft: 6 }} title="1 = visit first" onChange={(e) => set({ priorityRank: e.target.value })} />
              </label>
            </div>
          </div>
          <label>Notes</label><textarea rows="3" value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
          {isEdit && (
            <div className="card" style={{ marginTop: 12, background: 'var(--panel2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div><b>Credit balance</b><div className="muted">{creditBalance({ credits: st.credits }, existing.id)} credits on this client's account</div></div>
                <button type="button" className="primary small" onClick={() => { onClose(); st.set({ tab: 'marketing' }); }}>💳 Add credits</button>
              </div>
            </div>
          )}
          <div className="flexEnd">
            {isEdit && <button type="button" className="ghost" style={{ color: 'var(--red)', borderColor: '#4a2222' }} onClick={deleteAccount}>Delete</button>}
            <button type="button" className="ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save & locate on map'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}