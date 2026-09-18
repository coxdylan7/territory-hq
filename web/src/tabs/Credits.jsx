import { useState } from 'react';
import { useStore } from '../store';
import { addCredits, creditBalance } from '../actions';
import { Stat, Section, Empty } from '../components';

export default function Credits() {
  const st = useStore();
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const ledger = [...st.credits].sort((a, b) => b.date.localeCompare(a.date));
  const total = ledger.reduce((s, c) => s + Number(c.amount || 0), 0);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthTotal = ledger.filter((c) => c.date.startsWith(thisMonth)).reduce((s, c) => s + Number(c.amount || 0), 0);
  const balances = st.accounts.map((a) => ({ acc: a, bal: creditBalance({ credits: st.credits }, a.id) })).filter((x) => x.bal !== 0).sort((a, b) => b.bal - a.bal);
  const draft = st.lastCreditDraft;
  const apiBase = (typeof location !== 'undefined' && location.origin && !location.origin.startsWith('file')) ? location.origin : 'https://your-site.pages.dev';

  async function onAdd() {
    if (!accountId) { st.showToast('Pick a client first.'); return; }
    await addCredits(accountId, amount, note);
    setAmount('');
    setNote('');
  }

  return (
    <>
      <h2 className="disp" style={{ fontSize: 20 }}>Client credits</h2>
      <div className="muted" style={{ margin: '6px 0 14px' }}>Add credits to a client's account. Balances accrue per client and are exposed via an API your other apps can read.</div>
      <div className="cards4">
        <Stat num={total} lbl="Total credits issued" />
        <Stat num={monthTotal} lbl="This month" />
        <Stat num={balances.length} lbl="Clients with balance" />
        <Stat num={ledger.length} lbl="Ledger entries" />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Add credits to a client</div>
        <div className="grid2">
          <div>
            <label>Client account</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">— select —</option>
              {st.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.city ? ` (${a.city})` : ''}</option>)}
            </select>
          </div>
          <div>
            <label>Credit amount</label>
            <input type="number" step="1" value={amount} placeholder="e.g. 250" onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <label>Reason / note (optional)</label>
        <input value={note} placeholder="e.g. brand activation, promo display, volume bonus" onChange={(e) => setNote(e.target.value)} />
        <div className="flexEnd"><button className="primary" onClick={onAdd}>Add credits</button></div>
      </div>

      {draft ? (
        <div className="card" style={{ borderColor: 'var(--amber)', marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Alert email — ready to send</div>
          <textarea rows="8" readOnly value={draft} />
          <div className="flexEnd"><button className="ghost" onClick={() => { navigator.clipboard.writeText(draft); st.showToast('Alert email copied.'); }}>Copy</button></div>
        </div>
      ) : null}

      <Section>Current balances</Section>
      {balances.length === 0 ? (
        <Empty>No credits issued yet.</Empty>
      ) : (
        <table>
          <thead><tr><th>Client</th><th>City</th><th>License</th><th>Balance</th></tr></thead>
          <tbody>
            {balances.map((b) => (
              <tr key={b.acc.id}>
                <td data-label="Client"><b>{b.acc.name}</b></td>
                <td data-label="City">{b.acc.city || ''}</td>
                <td data-label="License">{b.acc.licenseNumber || '—'}</td>
                <td data-label="Balance"><b style={{ color: 'var(--amber)' }}>{b.bal}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {ledger.length > 0 && (
        <>
          <Section>Credit ledger</Section>
          <table>
            <thead><tr><th>Date</th><th>Client</th><th>Amount</th><th>Reason</th></tr></thead>
            <tbody>
              {ledger.map((c) => (
                <tr key={c.id}>
                  <td data-label="Date"><b>{c.date}</b></td>
                  <td data-label="Client">{c.accountName}</td>
                  <td data-label="Amount">{Number(c.amount) > 0 ? '+' : ''}{c.amount}</td>
                  <td data-label="Reason" className="muted">{c.note || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <Section>API for other apps</Section>
      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>Your other web apps can pull live credit balances from these read-only endpoints (CORS-enabled, JSON):</div>
        <div className="mono" style={{ fontSize: 12, background: 'var(--panel2)', padding: 10, borderRadius: 8, wordBreak: 'break-all' }}>
          GET {apiBase}/api/credits/balances<br />
          <span className="muted">→ [{'{'} accountName, licenseNumber, city, balance {'}'}]</span><br /><br />
          GET {apiBase}/api/credits/balances?license=OCM-XXXX<br />
          <span className="muted">→ balance for a single client by OCM license number</span><br /><br />
          <span className="muted">Header required: Authorization: Bearer &lt;READ_TOKEN&gt;</span>
        </div>
        <div className="muted" style={{ marginTop: 8 }}>License number is the shared key to match a client across your apps.</div>
      </div>
    </>
  );
}