import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';

export default function Admin() {
  const st = useStore();
  const [users, setUsers] = useState(null);
  const [msg, setMsg] = useState('');
  const [fetching, setFetching] = useState(false);

  async function load() {
    if (!st.user || st.user.role !== 'admin') return;
    setFetching(true);
    try {
      const list = await api.get('/api/admin/users');
      setUsers(list);
    } catch (err) { setMsg('Could not load users: ' + err.message); }
    setFetching(false);
  }

  useEffect(() => { load(); }, []);

  const meId = st.user ? st.user.id : null;

  async function updateUser(id, patch) {
    setMsg('');
    try {
      await api.put('/api/admin/users/' + id, patch);
      await load();
    } catch (err) { setMsg('Update failed: ' + err.message); }
  }

  if (!users || users.length === 0) {
    return (
      <>
        <h2 className="disp" style={{ fontSize: 20 }}>Admin</h2>
        <div className="muted" style={{ margin: '6px 0 14px' }}>
          {st.user && st.user.role === 'admin' ? 'Manage members on your Territory HQ site.' : 'Only admins can see this tab.'}
        </div>
        {fetching ? <div className="muted">Loading users…</div> : <div className="muted">{msg || 'No users found.'}</div>}
      </>
    );
  }

  return (
    <>
      <h2 className="disp" style={{ fontSize: 20 }}>Admin <span className="muted" style={{ fontSize: 13 }}>site members</span></h2>
      <div className="muted" style={{ margin: '6px 0 14px' }}>
        Members sign up and stay pending until you approve them. Suspending a member logs them out everywhere and blocks logins. Their subscription is controlled by a date — set it to the future to keep their access, or to the past to cut them off.
      </div>
      {msg && <div className="muted" style={{ color: 'var(--amber)', marginBottom: 10 }}>{msg}</div>}
      <table>
        <thead><tr><th>Email</th><th>Status</th><th>Role</th><th>Sub. expires</th><th>Actions</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td data-label="Email">
                <b>{u.email}</b>
                {u.id === meId ? <span className="muted"> (you)</span> : null}
              </td>
              <td data-label="Status">
                <span className={`pill ${u.status === 'active' ? 'active' : u.status === 'pending' ? 'prospect' : 'tracking'}`}>{u.status}</span>
              </td>
              <td data-label="Role">
                <select value={u.role} disabled={u.id === meId} onChange={(e) => updateUser(u.id, { role: e.target.value })}>
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td data-label="Sub. expires">
                <DateEdit id={u.id} date={u.subExpires} onSave={updateUser} disabled={u.id === meId} />
              </td>
              <td data-label="Actions">
                {u.id === meId ? (
                  <span className="muted">(that's you)</span>
                ) : (
                  <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {u.status === 'pending' && <button className="ghost small primary" style={{ color: 'var(--green)' }} onClick={() => updateUser(u.id, { status: 'active' })}>Approve</button>}
                    {u.status === 'active' && <button className="ghost small" onClick={() => updateUser(u.id, { status: 'suspended' })}>Suspend</button>}
                    {u.status === 'suspended' && <button className="ghost small" style={{ color: 'var(--green)' }} onClick={() => updateUser(u.id, { status: 'active' })}>Reactivate</button>}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function DateEdit({ id, date, onSave, disabled }) {
  const [val, setVal] = useState(date ? date.slice(0, 10) : '');
  return (
    <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <input type="date" style={{ width: 130 }} value={val} disabled={disabled} onChange={(e) => setVal(e.target.value)} />
      <button className="ghost small" disabled={disabled || (val || '') === (date ? date.slice(0, 10) : '')}
        onClick={() => onSave(id, { subExpires: val || null })}>Save</button>
    </span>
  );
}