import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, fmtMoney, ApiError } from '../api.ts';
import Modal from '../components/Modal.tsx';
import { statusPill } from './Jobs.tsx';

interface Line { kind: 'heading' | 'line' | 'separator'; description: string; quantity?: number | null; unit?: string | null; unit_price?: number | null; xero_account_code?: string | null; rate_card_item_id?: number | null }

export default function Job() {
  const { id } = useParams();
  const nav = useNavigate();
  const [job, setJob] = useState<any>(null);
  const [tab, setTab] = useState<'schedule' | 'quotes' | 'invoices' | 'hours'>('schedule');
  const [quoteEdit, setQuoteEdit] = useState<{ id?: number; title: string; lines: Line[] } | null>(null);
  const [rateCard, setRateCard] = useState<any[]>([]);
  const [invoiceNew, setInvoiceNew] = useState<{ quote_id: number; milestone_label: string; milestone_fraction: number } | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [hours, setHours] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.get(`/jobs/${id}`).then(setJob).catch(() => nav('/jobs'));
  useEffect(() => { load(); api.get('/rate-card').then(setRateCard); }, [id]);
  useEffect(() => { if (tab === 'hours') api.get(`/timesheets?job_id=${id}`).then(setHours); }, [tab, id]);
  if (!job) return <p className="muted">Loading…</p>;

  const setStatus = (status: string) => api.patch(`/jobs/${id}`, { status }).then(load);
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await load(); } catch (e) { setErr((e as ApiError).message); } };

  const totals = (lines: Line[]) => lines.filter(l => l.kind === 'line').reduce((s, l) => s + (l.quantity ?? 0) * (l.unit_price ?? 0), 0);
  const addRate = (rcId: number) => { const rc = rateCard.find(r => r.id === rcId); if (!rc || !quoteEdit) return; setQuoteEdit({ ...quoteEdit, lines: [...quoteEdit.lines, { kind: 'line', description: rc.description, quantity: 1, unit: rc.unit, unit_price: rc.unit_price, xero_account_code: rc.xero_account_code, rate_card_item_id: rc.id }] }); };
  const saveQuote = () => act(async () => {
    if (!quoteEdit) return;
    const body = { job_id: job.id, title: quoteEdit.title, lines: quoteEdit.lines };
    if (quoteEdit.id) await api.patch(`/quotes/${quoteEdit.id}`, body); else await api.post('/quotes', body);
    setQuoteEdit(null);
  });
  const openQuote = (qid: number) => api.get(`/quotes/${qid}`).then(q => setQuoteEdit({ id: q.id, title: q.title ?? '', lines: q.lines }));

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <Link to="/jobs" className="muted small">← Jobs</Link>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}><span className="muted">JN {job.job_number}</span> {job.title}</h1>
        {statusPill(job.status)}
        <select className="right" value={job.status} onChange={e => setStatus(e.target.value)}>
          {['enquiry', 'quoted', 'confirmed', 'in_progress', 'delivered', 'invoiced', 'closed', 'cancelled'].map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
      </div>
      <div className="card">
        <div className="kv">
          <span className="muted">Client</span><span>{job.client_name ?? '–'}</span>
          <span className="muted">Department</span><span>{job.department_name ?? '–'} · {job.kind ?? ''}</span>
          <span className="muted">Dates</span><span>{fmtDate(job.start_date)} – {fmtDate(job.end_date)}</span>
          <span className="muted">PO / Producer</span><span>{job.po_number ?? '–'} · {job.producer ?? '–'}</span>
          <span className="muted">Money</span><span>Approved {fmtMoney(job.approved_quote_net, job.currency)} · Invoiced {fmtMoney(job.invoiced_net, job.currency)} · Est. freelancer cost {fmtMoney(job.estimated_cost, job.currency)}</span>
        </div>
      </div>
      {err && <p className="err">{err}</p>}
      <div className="tabs" style={{ marginTop: 16 }}>
        {(['schedule', 'quotes', 'invoices', 'hours'] as const).map(t => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)} {t === 'schedule' ? `(${job.bookings.length})` : t === 'quotes' ? `(${job.quotes.length})` : t === 'invoices' ? `(${job.invoices.length})` : ''}</button>)}
      </div>

      {tab === 'schedule' && (
        <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ padding: 10 }}>
            <span className="muted small">{job.bookings.filter((b: any) => b.status === 'pencil').length} pencil · {job.bookings.filter((b: any) => b.status === 'confirmed').length} confirmed</span>
            <span className="right" />
            <Link to="/schedule"><button>Open schedule</button></Link>
            <button className="primary" onClick={() => act(async () => { const r = await api.post(`/bookings/confirm-job/${job.id}`); if (r.blocked.length) setErr(`${r.blocked.length} booking(s) blocked by clashes; fix them on the schedule.`); })}>Confirm all pencils</button>
          </div>
          <table>
            <thead><tr><th>Date</th><th>Resource</th><th>Time</th><th>Label</th><th>Status</th><th /></tr></thead>
            <tbody>{job.bookings.map((b: any) => (
              <tr key={b.id}>
                <td>{fmtDate(b.starts_at)}</td><td>{b.resource_name} <span className="muted small">{b.resource_type}</span></td><td className="mono">{b.starts_at.slice(11)}–{b.ends_at.slice(11)}</td><td>{b.title ?? ''}</td>
                <td><span className={`pill ${b.status === 'confirmed' ? 'ok' : b.status === 'cancelled' ? 'bad' : 'pencil'}`}>{b.status}</span></td>
                <td className="row">{b.status === 'pencil' && <button className="small" onClick={() => act(() => api.patch(`/bookings/${b.id}`, { status: 'confirmed' }))}>Confirm</button>}{b.status !== 'cancelled' && <button className="small ghost" onClick={() => act(() => api.patch(`/bookings/${b.id}`, { status: 'cancelled' }))}>Cancel</button>}</td>
              </tr>))}
              {job.bookings.length === 0 && <tr><td colSpan={6} className="muted">Nothing booked yet. Ask DeLorean, or add bookings on the schedule.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'quotes' && (
        <div className="stack">
          <div className="row"><span className="right" /><button className="primary" onClick={() => setQuoteEdit({ title: '', lines: [] })}>+ Quote</button></div>
          {job.quotes.map((q: any) => (
            <div key={q.id} className="card row">
              <b>{q.number}</b> <span>{q.title}</span> <span className={`pill ${q.status === 'approved' ? 'ok' : q.status === 'declined' || q.status === 'superseded' ? 'bad' : 'warn'}`}>{q.status}</span>
              <span className="right mono">{fmtMoney(q.net, q.currency)} <span className="muted small">ex VAT</span></span>
              <button className="small" onClick={() => openQuote(q.id)}>Open</button>
              {q.status !== 'approved' && q.status !== 'superseded' && <button className="small" onClick={() => act(() => api.patch(`/quotes/${q.id}`, { status: 'approved' }))}>Approve</button>}
              {q.status === 'approved' && <button className="small primary" onClick={() => setInvoiceNew({ quote_id: q.id, milestone_label: job.invoices.length === 0 ? '1st 50%' : 'Final 50%', milestone_fraction: 0.5 })}>Invoice milestone</button>}
              <button className="small ghost" onClick={() => act(() => api.post(`/quotes/${q.id}/revise`))}>Revise</button>
            </div>
          ))}
          {job.quotes.length === 0 && <p className="muted">No quotes yet.</p>}
        </div>
      )}

      {tab === 'invoices' && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Ours</th><th>Xero</th><th>Milestone</th><th>Reference</th><th>Issued / due</th><th className="num">Net</th><th>Status</th><th /></tr></thead>
            <tbody>{job.invoices.map((i: any) => (
              <tr key={i.id}>
                <td className="mono">{i.number}</td><td className="mono">{i.xero_invoice_number ?? '–'}</td><td>{i.milestone_label ?? '–'}</td><td className="small">{i.reference}</td>
                <td className="small">{fmtDate(i.issue_date)} / {fmtDate(i.due_date)}</td><td className="num">{fmtMoney(i.net, i.currency)}</td>
                <td><span className={`pill ${i.status === 'paid' ? 'ok' : i.status === 'pushed' ? 'warn' : i.status === 'void' ? 'bad' : ''}`}>{i.status}{i.xero_status ? ` · ${i.xero_status}` : ''}</span></td>
                <td className="row">
                  <button className="small ghost" onClick={() => api.get(`/invoices/${i.id}/xero-preview`).then(setPreview)}>Preview</button>
                  {i.status === 'draft' && <button className="small primary" onClick={() => act(() => api.post(`/invoices/${i.id}/push`))}>Push to Xero</button>}
                  {i.status === 'pushed' && <button className="small" onClick={() => act(() => api.post(`/invoices/${i.id}/refresh`))}>Refresh</button>}
                  {i.status === 'draft' && <button className="small ghost danger" onClick={() => act(() => api.del(`/invoices/${i.id}`))}>Delete</button>}
                </td>
              </tr>))}
              {job.invoices.length === 0 && <tr><td colSpan={8} className="muted">No invoices. Approve a quote, then “Invoice milestone”.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'hours' && (
        <div className="card" style={{ padding: 0 }}>
          <table><thead><tr><th>Date</th><th>Person</th><th className="num">Hours</th><th>Notes</th><th>Source</th></tr></thead>
            <tbody>{hours.map(h => <tr key={h.id}><td>{fmtDate(h.work_date)}</td><td>{h.resource_name}</td><td className="num">{h.hours}</td><td>{h.notes ?? ''}</td><td className="small muted">{h.source}</td></tr>)}
              {hours.length === 0 && <tr><td colSpan={5} className="muted">No hours logged yet. The bot asks everyone booked at the end of each day.</td></tr>}</tbody></table>
        </div>
      )}

      {quoteEdit && (
        <Modal title={quoteEdit.id ? 'Quote' : 'New quote'} onClose={() => setQuoteEdit(null)}>
          <div className="form">
            <div className="full"><label>Service (goes on the invoice reference)</label><input value={quoteEdit.title} onChange={e => setQuoteEdit({ ...quoteEdit, title: e.target.value })} placeholder="Picture & Sound Post" /></div>
            <div className="full row">
              <select onChange={e => { if (e.target.value) addRate(Number(e.target.value)); e.target.value = ''; }}><option value="">+ Add from rate card…</option>{rateCard.map(r => <option key={r.id} value={r.id}>{r.department_name ? `${r.department_name} · ` : ''}{r.description} ({fmtMoney(r.unit_price)}/{r.unit})</option>)}</select>
              <button className="small" onClick={() => setQuoteEdit({ ...quoteEdit, lines: [...quoteEdit.lines, { kind: 'heading', description: 'SECTION' }] })}>+ Heading</button>
              <button className="small" onClick={() => setQuoteEdit({ ...quoteEdit, lines: [...quoteEdit.lines, { kind: 'line', description: '', quantity: 1, unit: 'day', unit_price: 0 }] })}>+ Line</button>
            </div>
          </div>
          <table className="lines" style={{ marginTop: 10 }}>
            <thead><tr><th style={{ width: '46%' }}>Description</th><th>Qty</th><th>Unit</th><th>Price</th><th>Acct</th><th /></tr></thead>
            <tbody>{quoteEdit.lines.map((l, i) => {
              const set = (patch: Partial<Line>) => setQuoteEdit({ ...quoteEdit, lines: quoteEdit.lines.map((x, j) => j === i ? { ...x, ...patch } : x) });
              return <tr key={i}>
                <td><input value={l.description} onChange={e => set({ description: e.target.value })} style={l.kind === 'heading' ? { fontWeight: 600 } : {}} placeholder={l.kind === 'separator' ? '— separator —' : ''} /></td>
                {l.kind === 'line' ? <>
                  <td><input type="number" step="0.25" value={l.quantity ?? ''} onChange={e => set({ quantity: Number(e.target.value) })} style={{ width: 70 }} /></td>
                  <td><input value={l.unit ?? ''} onChange={e => set({ unit: e.target.value })} style={{ width: 60 }} /></td>
                  <td><input type="number" value={l.unit_price ?? ''} onChange={e => set({ unit_price: Number(e.target.value) })} style={{ width: 90 }} /></td>
                  <td><input value={l.xero_account_code ?? ''} onChange={e => set({ xero_account_code: e.target.value })} style={{ width: 55 }} /></td>
                </> : <td colSpan={4} className="muted small">{l.kind}</td>}
                <td><button className="ghost small" onClick={() => setQuoteEdit({ ...quoteEdit, lines: quoteEdit.lines.filter((_, j) => j !== i) })}>×</button></td>
              </tr>;
            })}</tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}><b>Net {fmtMoney(totals(quoteEdit.lines), job.currency)}</b><span className="muted small">+ VAT</span><span className="right" /><button onClick={() => setQuoteEdit(null)}>Cancel</button><button className="primary" onClick={saveQuote}>Save</button></div>
        </Modal>
      )}

      {invoiceNew && (
        <Modal title="Invoice a milestone" onClose={() => setInvoiceNew(null)}>
          <div className="form">
            <div><label>Milestone label</label><input value={invoiceNew.milestone_label} onChange={e => setInvoiceNew({ ...invoiceNew, milestone_label: e.target.value })} /></div>
            <div><label>Fraction of quote</label><select value={invoiceNew.milestone_fraction} onChange={e => setInvoiceNew({ ...invoiceNew, milestone_fraction: Number(e.target.value) })}>{[1, 0.5, 0.25, 0.1, 0.05].map(f => <option key={f} value={f}>{f * 100}%</option>)}</select></div>
          </div>
          <p className="small muted">Quote quantities are multiplied by the fraction, exactly like the existing Refinery invoices. It stays a draft here until you push it to Xero.</p>
          <div className="row"><span className="right" /><button onClick={() => setInvoiceNew(null)}>Cancel</button><button className="primary" onClick={() => act(async () => { await api.post('/invoices', { job_id: job.id, ...invoiceNew }); setInvoiceNew(null); setTab('invoices'); })}>Create draft</button></div>
        </Modal>
      )}

      {preview && (
        <Modal title="What Xero will receive" onClose={() => setPreview(null)}>
          <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(preview, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}
