import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { logMessage } from '../actions';
import { Section, Empty } from '../components';

const PURPOSES = [
  'First outreach / introduction',
  'Follow-up after a visit',
  'Propose a brand activation',
  'Check-in / relationship maintenance',
  'New product / promo announcement',
  'Reorder reminder',
  'Apology / service recovery',
];
const TONES = ['Warm & friendly', 'Professional', 'Direct & brief', 'Casual'];

export default function Messages() {
  const st = useStore();
  const { set } = st;
  const smsOn = st.user && st.user.smsEnabled;

  // generator form
  const [accountId, setAccountId] = useState('');
  const [channel, setChannel] = useState('Text (SMS)');
  const [purpose, setPurpose] = useState(PURPOSES[0]);
  const [tone, setTone] = useState(TONES[0]);
  const [length, setLength] = useState('medium');
  const [context, setContext] = useState('');
  // draft output
  const [draft, setDraft] = useState(null); // { text, isText, account }
  const [generating, setGenerating] = useState(false);
  const [sendResult, setSendResult] = useState('');
  const [draftText, setDraftText] = useState('');
  // blast
  const [selected, setSelected] = useState({});
  const [blastText, setBlastText] = useState('');
  const [blastOut, setBlastOut] = useState('');
  const [blastLoading, setBlastLoading] = useState(false);

  const acc = st.accounts.find((a) => a.id === accountId);
  const isText = channel !== 'Email';

  async function generate() {
    if (!acc) { st.showToast('Pick an account first.'); return; }
    setGenerating(true);
    setSendResult('');
    const lengthNote = length === 'short' ? 'Keep it to 1-2 short sentences.' : 'Keep it to 3-4 sentences, still tight.';
    const prompt = `Write a ${tone.toLowerCase()} ${channel} to a cannabis retail store contact for a field sales rep.
Store: ${acc.name} (${acc.city || ''}). Contact: ${acc.contactName || 'unknown, keep it general'}.
Purpose: ${purpose}.
Notes on the account: ${acc.notes || 'none'}.
Extra context: ${context || 'none'}.
${lengthNote} No corporate jargon. ${isText ? 'No subject line.' : 'Include a short subject line on the first line prefixed with "Subject:".'} Output only the message, nothing else.`;
    try {
      const res = await api.post('/api/generate-message', { prompt });
      const block = (res.content || []).find((c) => c.type === 'text');
      const text = block ? block.text : '(No response — please try again.)';
      setDraft({ isText });
      setDraftText(text);
    } catch (e) {
      setDraft(null);
      setSendResult("Couldn't generate a draft right now.");
    } finally {
      setGenerating(false);
    }
  }

  async function saveDraft() {
    if (!draft || !acc) return;
    await logMessage(acc, draft.isText ? 'text' : 'email', purpose, draftText, draft.isText ? acc.phone : acc.email);
    st.showToast('Saved to message history.');
  }

  async function sendNow() {
    if (!acc) return;
    setSendResult('');
    try {
      const r = await api.post('/api/messages/send', {
        accountId: acc.id, accountName: acc.name, licenseNumber: acc.licenseNumber || '', city: acc.city || '',
        channel: 'text', purpose, to: acc.phone, text: draftText,
      });
      const entry = { id: r.id, accountId: acc.id, accountName: acc.name, channel: 'text', purpose, body: draftText, to: acc.phone, direction: 'outbound', date: new Date().toISOString(), status: r.sent ? 'sent' : 'queued' };
      set({ messages: [...st.messages, entry] });
      setSendResult(r.sent ? 'Sent via SMS.' : `Logged, but not actually sent (${r.reason || 'no provider'}).`);
    } catch (err) {
      setSendResult('Send failed: ' + err.message);
    }
  }

  async function openInMessages() {
    if (!acc) return;
    const val = draftText;
    await logMessage(acc, 'text', purpose, val, acc.phone);
    const phone = (acc.phone || '').replace(/[^0-9+]/g, '');
    window.location.href = `sms:${phone}?&body=${encodeURIComponent(val)}`;
  }

  async function openInEmail() {
    if (!acc) return;
    const val = draftText;
    let subject = 'Following up', bodyText = val;
    const m = val.match(/^Subject:\s*(.+)\n?/i);
    if (m) { subject = m[1].trim(); bodyText = val.slice(m[0].length).trim(); }
    await logMessage(acc, 'email', purpose, val, acc.email);
    window.location.href = `mailto:${encodeURIComponent(acc.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
  }

  async function sendBlast() {
    const ids = Object.keys(selected).filter((k) => selected[k]);
    if (!ids.length) { st.showToast('Select at least one recipient.'); return; }
    if (!blastText.trim()) { st.showToast('Write a message first.'); return; }
    setBlastLoading(true);
    setBlastOut('Sending…');
    try {
      const r = await api.post('/api/messages/blast', { accountIds: ids, template: blastText });
      set({ messages: await api.get('/api/messages') });
      setBlastOut(`${r.sent} sent live, ${r.queued} logged as queued${r.skipped ? ', ' + r.skipped + ' skipped (no phone)' : ''}.${r.smsEnabled ? '' : ' Connect an SMS provider to make queued messages send for real.'}`);
      st.showToast('Blast complete.');
    } catch (err) {
      setBlastOut('Blast failed: ' + err.message);
    } finally {
      setBlastLoading(false);
    }
  }

  async function deleteMsg(id) {
    try {
      await api.del('/api/messages/' + id);
      set({ messages: st.messages.filter((m) => m.id !== id) });
      st.showToast('Message deleted.');
    } catch (err) { st.showToast('Delete failed: ' + err.message); }
  }

  async function resend(m) {
    try {
      const r = await api.post('/api/messages/send', { accountId: m.accountId, accountName: m.accountName, licenseNumber: m.licenseNumber || '', city: m.city || '', channel: 'text', purpose: m.purpose || 'Resend', to: m.to, text: m.body });
      const entry = { id: r.id, accountId: m.accountId, accountName: m.accountName, channel: 'text', purpose: m.purpose, body: m.body, to: m.to, direction: 'outbound', date: new Date().toISOString(), status: r.sent ? 'sent' : 'queued' };
      set({ messages: [...st.messages, entry] });
      st.showToast(r.sent ? 'Resent via SMS.' : 'Logged again (no SMS provider connected).');
    } catch (err) { st.showToast('Resend failed: ' + err.message); }
  }

  const msgs = [...st.messages].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
  const apiBase = (typeof location !== 'undefined' && location.origin && !location.origin.startsWith('file')) ? location.origin : 'https://your-site.netlify.app';
  const phone = (acc && acc.phone || '').replace(/[^0-9+]/g, '');

  return (
    <>
      <h2 className="disp" style={{ fontSize: 20 }}>Messages</h2>
      <div className="muted" style={{ margin: '4px 0 14px' }}>
        {smsOn
          ? 'Direct SMS sending is connected — messages send immediately from here.'
          : 'Direct SMS sending isn\u2019t connected yet — drafts open your phone\u2019s Messages app instead. Add Twilio keys in Settings/environment to enable one-click sending.'}
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <label>Account</label>
        <select value={accountId} onChange={(e) => { setAccountId(e.target.value); setDraft(null); setSendResult(''); }}>
          <option value="">— select —</option>
          {st.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.phone ? '' : ' (no phone)'}</option>)}
        </select>
        <div className="grid2">
          <div><label>Channel</label>
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option>Text (SMS)</option><option>Email</option>
            </select>
          </div>
          <div><label>Purpose</label>
            <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {PURPOSES.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <div className="grid2">
          <div><label>Tone</label>
            <select value={tone} onChange={(e) => setTone(e.target.value)}>
              {TONES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div><label>Length</label>
            <select value={length} onChange={(e) => setLength(e.target.value)}>
              <option value="short">Short (1-2 sentences)</option>
              <option value="medium">Medium (3-4 sentences)</option>
            </select>
          </div>
        </div>
        <label>Extra context (optional)</label>
        <textarea rows="2" placeholder="e.g. mention the new vape line..." value={context} onChange={(e) => setContext(e.target.value)} />
        <div className="flexEnd"><button className="primary" onClick={generate} disabled={generating}>{generating ? 'Generating…' : 'Generate draft'}</button></div>

        {sendResult && !draft ? <div className="muted" style={{ color: 'var(--red)', marginTop: 10 }}>{sendResult}</div> : null}

        {draft && (
          <>
            <label style={{ marginTop: 14 }}>Draft (edit freely)</label>
            <textarea rows="6" value={draftText} onChange={(e) => setDraftText(e.target.value)} />
            {isText && phone && <div className="muted" style={{ marginTop: 6 }}>Will text {acc.phone}.</div>}
            <div className="flexEnd" style={{ gap: 8, flexWrap: 'wrap' }}>
              {isText && phone && <button className="primary" onClick={sendNow}>Send SMS now</button>}
              {isText && phone && <button className={smsOn ? 'ghost' : 'primary'} onClick={openInMessages}>Open in Messages</button>}
              {!isText && <button className="primary" onClick={openInEmail}>Open in email</button>}
              <button className="ghost" onClick={saveDraft}>Save to history</button>
              <button className="ghost" onClick={() => { navigator.clipboard.writeText(draftText); st.showToast('Copied.'); }}>Copy</button>
            </div>
            {sendResult && <div className="muted" style={{ marginTop: 6, color: sendResult.startsWith('Sent') ? 'var(--green)' : 'var(--amber)' }}>{sendResult}</div>}
          </>
        )}
      </div>

      <Section>SMS blast <span className="muted" style={{ fontSize: 12, textTransform: 'none' }}>(future integration ready)</span></Section>
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="muted" style={{ marginBottom: 8 }}>
          Send the same message to multiple accounts at once. Use <span className="mono">{'{name}'}</span> to personalize. {smsOn ? 'Sends live now.' : 'Not connected to an SMS provider yet — messages will be logged as queued, ready for when you add one.'}
        </div>
        <label>Recipients</label>
        <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 8 }}>
          {st.accounts.length === 0 ? <div className="muted">No accounts yet.</div> : st.accounts.map((a) => (
            <label key={a.id} className="checkline" style={{ marginTop: 0 }}>
              <input type="checkbox" disabled={!a.phone} checked={!!selected[a.id]} onChange={(e) => set({ ...selected, [a.id]: e.target.checked })} />
              {a.name} {a.phone ? <span className="muted">{a.phone}</span> : <span className="muted">(no phone)</span>}
            </label>
          ))}
        </div>
        <div className="flexEnd" style={{ marginTop: 6 }}><button className="ghost small" onClick={() => { const s = {}; st.accounts.forEach((a) => { if (a.phone) s[a.id] = true; }); setSelected(s); }}>Select all with phone</button></div>
        <label>Message</label>
        <textarea rows="3" placeholder="Hi {name}, ..." value={blastText} onChange={(e) => setBlastText(e.target.value)} />
        <div className="flexEnd"><button className="primary" onClick={sendBlast} disabled={blastLoading}>{blastLoading ? 'Sending…' : 'Send blast'}</button></div>
        {blastOut && <div className="muted" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{blastOut}</div>}
      </div>

      <Section>Message history</Section>
      {msgs.length === 0 ? (
        <Empty>No messages logged yet. Generate one above and open, save, or send it — it'll be recorded here and shared via the API.</Empty>
      ) : (
        <table>
          <thead><tr><th>When</th><th>Client</th><th>Channel</th><th>Status</th><th>Message</th><th></th></tr></thead>
          <tbody>
            {msgs.map((m) => (
              <tr key={m.id}>
                <td data-label="When"><b>{m.date.slice(0, 10)}</b></td>
                <td data-label="Client">{m.accountName}{m.blastId ? <span className="muted"> (blast)</span> : ''}</td>
                <td data-label="Channel">{m.channel}</td>
                <td data-label="Status">
                  {m.status === 'sent' ? <span className="pill active">sent</span> : m.status === 'queued' ? <span className="pill tracking">queued</span> : <span className="pill prospect">logged</span>}
                </td>
                <td data-label="Message" className="muted">{(m.body || '').slice(0, 70)}{(m.body || '').length > 70 ? '…' : ''}</td>
                <td data-label="">
                  {m.channel === 'text' && m.to ? <button className="ghost small" onClick={() => resend(m)}>Resend</button> : null}
                  <button className="ghost small" style={{ color: 'var(--red)' }} onClick={() => deleteMsg(m.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Section>API for other apps</Section>
      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>Other apps can read the shared message log (CORS-enabled, JSON):</div>
        <div className="mono" style={{ fontSize: 12, background: 'var(--panel2)', padding: 10, borderRadius: 8, wordBreak: 'break-all' }}>
          GET {apiBase}/api/messages/shared<br />
          <span className="muted">→ [{'{'} accountName, licenseNumber, channel, body, to, date, direction, status {'}'}]</span><br /><br />
          GET {apiBase}/api/messages/shared?license=OCM-XXXX<br />
          <span className="muted">→ all messages for one client by OCM license number</span><br /><br />
          <span className="muted">Header required: Authorization: Bearer &lt;READ_TOKEN&gt;</span>
        </div>
      </div>
    </>
  );
}