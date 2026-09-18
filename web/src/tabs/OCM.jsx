import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { fetchOCM, searchOCM } from '../ocm';
import { addAccountFromOCM } from '../actions';
import { Empty } from '../components';

export default function OCM() {
  const st = useStore();
  const { set } = st;
  const [searchMode, setSearchMode] = useState('license');
  const [query, setQuery] = useState('');
  const seen = new Set(st.ocmSeen);
  const addedLicenses = new Set(st.accounts.map((a) => a.licenseNumber).filter(Boolean));
  const results = st.ocmResults.filter((r) => !addedLicenses.has(r.license_number));

  async function markAllSeen() {
    const newOnes = st.ocmResults.map((r) => r.license_number).filter((ln) => !st.ocmSeen.includes(ln));
    if (newOnes.length) await api.post('/api/ocm-seen', { licenseNumbers: newOnes });
    set({ ocmSeen: Array.from(new Set([...st.ocmSeen, ...newOnes])) });
    st.showToast('Marked all as seen.');
  }

  function onSearch() {
    if (!query.trim()) return;
    searchOCM(query.trim(), searchMode);
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="disp" style={{ fontSize: 20 }}>OCM Watch</h2>
        <div>
          <button className="ghost" onClick={markAllSeen}>Mark all seen</button>
          <button className="primary" onClick={() => fetchOCM()}>{st.ocmLoading ? 'Checking…' : 'Check OCM database now'}</button>
        </div>
      </div>
      <div className="muted" style={{ margin: '8px 0 16px', maxWidth: 640 }}>
        Live pull from New York's Open Data <b>Current OCM Licenses</b> dataset, filtered to your counties in Settings.
        Already-added accounts are hidden automatically. This checks the moment you press the button — it can't push
        notifications while the app is closed, since that needs a server running on a schedule.
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Search OCM directly</div>
        <div className="muted" style={{ marginBottom: 8 }}>Looks up any store by license number or name — ignores your county filter.</div>
        <div style={{ marginBottom: 8 }}>
          <span className={`dayChip ${searchMode === 'license' ? 'on' : ''}`} onClick={() => { setSearchMode('license'); setQuery(''); set({ ocmSearchResults: null, ocmSearchError: '' }); }}>License #</span>
          <span className={`dayChip ${searchMode === 'name' ? 'on' : ''}`} onClick={() => { setSearchMode('name'); setQuery(''); set({ ocmSearchResults: null, ocmSearchError: '' }); }}>Name</span>
        </div>
        <div className="row">
          <input
            value={query}
            placeholder={searchMode === 'name' ? 'e.g. Green Leaf' : 'e.g. OCM-RD-0001'}
            style={{ flex: 1, minWidth: 180 }}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSearch(); } }}
          />
          <button className="primary" style={{ width: 'auto' }} onClick={onSearch}>{st.ocmSearchLoading ? 'Searching…' : 'Search'}</button>
        </div>
        {st.ocmSearchError && <div className="muted" style={{ color: 'var(--red)', marginTop: 8 }}>{st.ocmSearchError}</div>}
        {(st.ocmSearchResults || []).map((sr) => {
          const already = st.accounts.find((a) => a.licenseNumber === sr.license_number);
          return (
            <div className="stopRow" key={sr.license_number}>
              <div className="stopNum">{already ? '✓' : '•'}</div>
              <div style={{ flex: 1 }}>
                <b>{sr.dba || sr.entity_name}</b> <span className="muted mono" style={{ fontSize: 11 }}>{sr.license_number}</span>
                <div className="muted">{sr.address_line_1}, {sr.city} — {sr.license_status}</div>
              </div>
              {already
                ? <span className="muted">Already added as {already.name}</span>
                : <button className="ghost small" onClick={() => addAccountFromOCM(sr)}>Add to accounts</button>}
            </div>
          );
        })}
      </div>

      {st.ocmError && <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)', marginBottom: 14 }}>{st.ocmError}</div>}
      {!st.settings.counties.length ? (
        <Empty>Set at least one county to watch in Settings first.</Empty>
      ) : results.length === 0 ? (
        <Empty>Press "Check OCM database now" to pull current retail licenses for your counties.</Empty>
      ) : (
        <table>
          <thead><tr><th></th><th>Name</th><th>Status</th><th>County</th><th>Address</th><th>Opened to public</th><th></th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.license_number}>
                <td data-label="">{!seen.has(r.license_number) ? <span className="newTag">NEW</span> : ''}</td>
                <td data-label="Name"><b>{r.dba || r.entity_name}</b><div className="muted mono" style={{ fontSize: 11 }}>{r.license_number}</div></td>
                <td data-label="Status">{r.license_status}</td>
                <td data-label="County">{r.county}</td>
                <td data-label="Address">{r.address_line_1}, {r.city}</td>
                <td data-label="Opened">{r.retail_date_opened_to_public || '—'}</td>
                <td data-label=""><button className="ghost small" onClick={() => addAccountFromOCM(r)}>Add to accounts</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}