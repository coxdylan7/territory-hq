import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { expenseValue } from '../utils';
import { Stat, Section } from '../components';

const CATEGORIES = ['Mileage', 'Promo', 'Travel', 'Food', 'Supplies', 'Other'];

export default function Expenses() {
  const st = useStore();
  const { set } = st;
  const [modal, setModal] = useState(null); // { date, category, desc, amount, miles } or null
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
  const entries = [...st.expenses].sort((a, b) => b.date.localeCompare(a.date));

  const rate = st.settings.mileageRate;
  const monthTotals = st.expenses.filter((e) => e.date >= firstOfMonth);
  const monthSpend = monthTotals.reduce((s, e) => s + expenseValue(e, rate), 0);
  const monthMiles = monthTotals.reduce((s, e) => s + Number(e.miles || 0), 0);
  const lastWeekDate = (() => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })();
  const weekSpend = st.expenses.filter((e) => e.date >= lastWeekDate).reduce((s, e) => s + expenseValue(e, rate), 0);
  const totalSpend = st.expenses.reduce((s, e) => s + expenseValue(e, rate), 0);

  const loggedDays = new Set(st.routeLog.map((l) => l.date));
  let streak = 0;
  let d = new Date();
  while (true) {
    const key = d.toISOString().slice(0, 10);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) { d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1); continue; }
    if (loggedDays.has(key)) { streak++; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1); }
    else break;
  }

  async function saveExpense() {
    if (!modal) return;
    const miles = Math.round((Number(modal.miles) || 0) * 10) / 10;
    let amount = Number(modal.amount) || 0;
    if (modal.category === 'Mileage' && amount <= 0 && miles > 0) amount = Math.round(miles * rate * 100) / 100;
    const rec = {
      id: 'e' + Date.now(),
      date: modal.date || today,
      category: modal.category || 'Mileage',
      amount,
      miles,
      notes: (modal.desc || '').trim(),
    };
    try {
      await api.post('/api/expenses', rec);
      set({ expenses: [...st.expenses, rec] });
      st.showToast('Expense logged.');
      setModal(null);
    } catch (err) { st.showToast('Save failed: ' + err.message); }
  }

  async function deleteExpense(id) {
    try {
      await api.del('/api/expenses/' + id);
      set({ expenses: st.expenses.filter((e) => e.id !== id) });
      st.showToast('Expense deleted.');
    } catch (err) { st.showToast('Delete failed: ' + err.message); }
  }

  return (
    <>
      <h2 className="disp" style={{ fontSize: 20 }}>Expenses</h2>
      <div className="muted" style={{ margin: '6px 0 14px' }}>Log your field expenses so the reports stay honest. Mileage entries with a miles value are tracked against your IRS mileage rate for reimbursement estimates.</div>
      <div className="cards4">
        <Stat num={'$' + monthSpend.toFixed(0)} lbl="Spent this month" />
        <Stat num={'$' + weekSpend.toFixed(0) + '/wk'} lbl="Est. weekly cost" />
        <Stat num={monthMiles.toFixed(0) + ' mi'} lbl="Driven this month" />
        <Stat num={'$' + totalSpend.toFixed(0)} lbl="All time" />
      </div>
      <div className="muted" style={{ margin: '4px 0 14px' }}>
        Mileage rate: ${rate.toFixed(2)}/mi — mileage rows are valued at this rate and are included in the totals. · Work-day route streak: <b>{streak} day(s)</b>
      </div>

      <div className="flexEnd" style={{ justifyContent: 'flex-start', marginBottom: 14 }}>
        <button className="primary" onClick={() => setModal({ date: today, category: 'Mileage', desc: '', amount: '', miles: '' })}>+ Log expense</button>
      </div>

      <Section>All expenses</Section>
      {entries.length === 0 ? (
        <div className="muted">Nothing logged yet.</div>
      ) : (
        <table>
          <thead><tr><th>Date</th><th>Category</th><th>Amount</th><th>Miles</th><th>Details</th><th></th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td data-label="Date"><b>{e.date}</b></td>
                <td data-label="Category"><span className="pill">{e.category}</span></td>
                <td data-label="Amount">${expenseValue(e, rate).toFixed(2)}</td>
                <td data-label="Miles">{e.miles ? e.miles + ' mi' : ''}</td>
                <td data-label="Details" className="muted">{(e.notes || '').slice(0, 60)}</td>
                <td data-label="">
                  <button className="ghost small" style={{ color: 'var(--red)' }} onClick={() => deleteExpense(e.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modal && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="modal card">
            <h3>Log an expense</h3>
            <label>Date</label>
            <input type="date" value={modal.date} onChange={(e) => setModal({ ...modal, date: e.target.value })} />
            <label>Category</label>
            <select value={modal.category} onChange={(e) => setModal({ ...modal, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            {modal.category === 'Mileage' ? (
              <div className="grid2">
                <div><label>Miles driven</label><input type="number" step="0.1" value={modal.miles} placeholder="e.g. 42" onChange={(e) => setModal({ ...modal, miles: e.target.value })} /></div>
                <div><label>Amount (optional)</label><input type="number" step="0.01" value={modal.amount} placeholder="0.00" onChange={(e) => setModal({ ...modal, amount: e.target.value })} />
                  {Number(modal.amount) <= 0 && Number(modal.miles) > 0 && <div className="muted" style={{ fontSize: 12 }}>= ${((Number(modal.miles) || 0) * rate).toFixed(2)} at ${rate.toFixed(2)}/mi (auto-filled)</div>}
                </div>
              </div>
            ) : (
              <div><label>Amount ($)</label><input type="number" step="0.01" value={modal.amount} placeholder="0.00" onChange={(e) => setModal({ ...modal, amount: e.target.value })} /></div>
            )}
            <label>Details</label>
            <textarea rows="2" value={modal.desc || ''} placeholder="e.g. lunch with buyer at Hudson Hemp" onChange={(e) => setModal({ ...modal, desc: e.target.value })} />
            <div className="flexEnd">
              <button className="ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="primary" onClick={saveExpense}>Log expense</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}