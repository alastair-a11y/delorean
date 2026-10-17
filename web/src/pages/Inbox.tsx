import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtMoney, ApiError } from '../api.ts';

export default function Inbox() {
  const { id } = useParams();
  const nav = useNavigate();
  const [tab, setTab] = useState<'proposals' | 'mail' | 'nudges' | 'outbox'>('proposals');
  const [intakes, setIntakes] = useState<any[]>([]);
  const [mail, setMail] = useState<any[]>([]);
  const [nudges, setNudges] = useState<any[]>([]);
  const [outbox, setOutbox] = useState<any[]>([]);
  const [open, setOpen] = useState<any>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => { api.get('/assistant/intakes').then(setIntakes); api.get('/assistant/mail').then(setMail); api.get('/assistant/nudges').then(setNudges); api.get('/assistant/outbox').then(setOutbox); };
  useEffect(load, []);
  useEffect(() => { if (id) api.get(`/assistant/intakes/${id}`).then(setOpen); else setOpen(null); }, [id]);

  async function submit(files?: FileList | null) {
    setBusy(true); setErr(null);
    try {
      const form = new FormData(); form.set('text', text); Array.from(files ?? []).forEach(f => form.append('files', f));
      const r = await api.form('/assistant/intakes', form);
      setText(''); load(); nav(`/inbox/${r.id}`);
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }
  async function commit(confirm: boolean) {
    setBusy(true); setErr(null);
    try { const r = await api.post(`/assistant/intakes/${open.id}/commit`, { confirm }); load(); nav(`/jobs/${r.job_id}`); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }

  const p = open?.proposal;
  return (
    <div>
      <h1>Inbox</h1>
      {!open && (
        <div className="card" style={{ marginBottom: 16 }}>
          <b>Drop a producer’s schedule, brief or email</b>
          <p className="muted small" style={{ margin: '4px 0 8px' }}>Spreadsheet, PDF, .eml, .docx, image or pasted text. DeLorean reads it and proposes the job, the bookings and the quote. Nothing is created until you say so.</p>
          <textarea rows={4} style={{ width: '100%' }} placeholder="Paste an email or a schedule here…" value={text} onChange={e => setText(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <label className="chip">📎 Upload a file<input type="file" hidden multiple onChange={e => submit(e.target.files)} /></label>
            <span className="right" />
            <button className="primary" disabled={!text.trim() || busy} onClick={() => submit()}>{busy ? 'Reading…' : 'Read it'}</button>
          </div>
          {err && <p className="err">{err}</p>}
        </div>
      )}

      {open && p && (
        <div className="card proposal">
          <div className="row"><Link to="/inbox" className="small muted">← Inbox</Link><span className="right" /><span className={`pill ${p.confidence === 'high' ? 'ok' : p.confidence === 'medium' ? 'warn' : 'bad'}`}>{p.confidence} confidence</span><span className="pill">{open.status}</span></div>
          <h2>{p.job.title}</h2>
          <p>{p.summary}</p>
          {p.questions?.length > 0 && <div className="warnbox"><b>Check before confirming</b><ul style={{ margin: '4px 0 0 16px', padding: 0 }}>{p.questions.map((q: string, i: number) => <li key={i}>{q}</li>)}</ul></div>}
          <h3>Job</h3>
          <div className="kv small">
            <span className="muted">Client</span><span>{p.job.client_name ?? '–'}{p.job.existing_client_id ? ' (existing)' : p.job.client_name ? ' (new)' : ''}</span>
            <span className="muted">Department / kind</span><span>{p.job.department ?? '–'} · {p.job.kind ?? '–'}</span>
            <span className="muted">Dates</span><span>{p.job.start_date ?? '?'} → {p.job.end_date ?? '?'}</span>
            <span className="muted">PO / producer</span><span>{p.job.po_number ?? '–'} · {p.job.producer ?? '–'}</span>
            {p.job.existing_job_id && <><span className="muted">Updates</span><span>existing job #{p.job.existing_job_id}</span></>}
          </div>
          <h3>Bookings ({p.bookings.length})</h3>
          <table className="small"><tbody>{p.bookings.map((b: any, i: number) => <tr key={i}><td>{b.date}</td><td>{b.start_time ?? '09:00'}–{b.end_time ?? '18:00'}</td><td>{b.resource_id ? `resource #${b.resource_id}` : <span className="err">needs: {b.requirement}</span>}</td><td>{b.title ?? ''}</td></tr>)}</tbody></table>
          {p.quote && <>
            <h3>Quote {p.quote.title ? `· ${p.quote.title}` : ''}</h3>
            <table className="small"><tbody>{p.quote.lines.map((l: any, i: number) => <tr key={i}>
              <td style={l.kind === 'heading' ? { fontWeight: 600 } : {}}>{l.kind === 'separator' ? '—' : l.description}</td>
              <td className="num">{l.kind === 'line' ? `${l.quantity ?? ''} ${l.unit ?? ''}` : ''}</td><td className="num">{l.kind === 'line' ? fmtMoney(l.unit_price) : ''}</td><td className="num">{l.kind === 'line' ? fmtMoney((l.quantity ?? 0) * (l.unit_price ?? 0)) : ''}</td></tr>)}
              <tr><td colSpan={3} className="num"><b>Net</b></td><td className="num"><b>{fmtMoney(p.quote.lines.filter((l: any) => l.kind === 'line').reduce((s: number, l: any) => s + (l.quantity ?? 0) * (l.unit_price ?? 0), 0))}</b></td></tr>
            </tbody></table>
            <p className="small muted">Billing: {p.quote.milestones.map((m: any) => `${m.label} (${Math.round(m.fraction * 100)}%)`).join(' · ')}</p>
          </>}
          {err && <p className="err">{err}</p>}
          {open.status === 'proposed' && <div className="row" style={{ marginTop: 12 }}>
            <button className="ghost danger" onClick={() => api.post(`/assistant/intakes/${open.id}/discard`).then(() => { load(); nav('/inbox'); })}>Discard</button>
            <button className="ghost" onClick={() => api.post(`/assistant/intakes/${open.id}/reprocess`).then(() => api.get(`/assistant/intakes/${open.id}`).then(setOpen))}>Re-read</button>
            <span className="right" />
            <button disabled={busy} onClick={() => commit(false)}>Create as pencil</button>
            <button className="primary" disabled={busy} onClick={() => commit(true)}>Create & confirm</button>
          </div>}
          {open.status === 'committed' && <p><Link to={`/jobs/${open.committed_job_id}`}>Open the job →</Link></p>}
        </div>
      )}

      {!open && <>
        <div className="tabs">
          <button className={tab === 'proposals' ? 'on' : ''} onClick={() => setTab('proposals')}>Proposals ({intakes.filter(i => i.status === 'proposed').length})</button>
          <button className={tab === 'mail' ? 'on' : ''} onClick={() => setTab('mail')}>Mail bot ({mail.length})</button>
          <button className={tab === 'nudges' ? 'on' : ''} onClick={() => setTab('nudges')}>Hours nudges ({nudges.filter(n => n.status === 'sent').length} open)</button>
          <button className={tab === 'outbox' ? 'on' : ''} onClick={() => setTab('outbox')}>Outbox ({outbox.length})</button>
        </div>
        {tab === 'proposals' && <div className="stack">{intakes.map(i => (
          <div key={i.id} className="card row click" onClick={() => nav(`/inbox/${i.id}`)} style={{ cursor: 'pointer' }}>
            <span className={`pill ${i.status === 'proposed' ? 'warn' : i.status === 'committed' ? 'ok' : i.status === 'failed' ? 'bad' : ''}`}>{i.status}</span>
            <b>{i.proposal?.job?.title ?? i.filename ?? i.source_type}</b><span className="muted small">{i.proposal?.summary?.slice(0, 120) ?? i.error ?? i.preview}</span>
            <span className="right muted small">{i.created_at}</span>
          </div>))}{intakes.length === 0 && <p className="muted">Nothing yet. Drop something above, or wait for the mail bot.</p>}</div>}
        {tab === 'mail' && <div className="card" style={{ padding: 0 }}><table><thead><tr><th>When</th><th>From</th><th>Subject</th><th>Triage</th><th>Action</th></tr></thead><tbody>
          {mail.map(m => <tr key={m.id}><td className="small">{m.created_at}</td><td className="small">{m.from_addr}</td><td>{m.subject}</td><td className="small">{m.triage ? `${m.triage.category} · ${m.triage.summary}` : '–'}</td><td><span className={`pill ${m.status === 'handled' ? 'ok' : m.status === 'flagged' ? 'warn' : m.status === 'failed' ? 'bad' : ''}`}>{m.action ?? m.status}</span></td></tr>)}
          {mail.length === 0 && <tr><td colSpan={5} className="muted">No mail processed yet. Connect Google in Settings so the bot can watch the Refinery mailboxes.</td></tr>}</tbody></table></div>}
        {tab === 'nudges' && <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ padding: 10 }}><span className="muted small">Sent at the end of each working day to everyone booked who hasn’t logged hours.</span><span className="right" /><button onClick={() => api.post('/assistant/nudges/run').then(load)}>Send today’s now</button></div>
          <table><thead><tr><th>Day</th><th>Person</th><th>Via</th><th>Status</th><th>Reply</th></tr></thead><tbody>
          {nudges.map(n => <tr key={n.id}><td>{n.work_date}</td><td>{n.resource_name}</td><td className="small">{n.channel}</td><td><span className={`pill ${n.status === 'answered' ? 'ok' : n.status === 'sent' ? 'warn' : n.status === 'failed' ? 'bad' : ''}`}>{n.status}</span></td><td className="small">{n.reply_text ?? n.error ?? ''}</td></tr>)}
          {nudges.length === 0 && <tr><td colSpan={5} className="muted">No nudges yet.</td></tr>}</tbody></table></div>}
        {tab === 'outbox' && <div className="card" style={{ padding: 0 }}><table><thead><tr><th>When</th><th>Via</th><th>To</th><th>Message</th></tr></thead><tbody>
          {outbox.map(o => <tr key={o.id}><td className="small">{o.created_at}</td><td className="small">{o.channel}</td><td className="small">{o.recipient}</td><td className="small">{o.body}</td></tr>)}
          {outbox.length === 0 && <tr><td colSpan={4} className="muted">Everything DeLorean sends to people is logged here.</td></tr>}</tbody></table></div>}
      </>}
    </div>
  );
}
