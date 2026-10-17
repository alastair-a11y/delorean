import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtMoney } from '../api.ts';

export default function Money() {
  const [tab, setTab] = useState<'invoices' | 'quotes' | 'wip' | 'rates'>('invoices');
  const [invoices, setInvoices] = useState<any[]>([]);
  const [quotes, setQuotes] = useState<any[]>([]);
  const [wip, setWip] = useState<any[]>([]);
  const [rates, setRates] = useState<any[]>([]);
  useEffect(() => { api.get('/invoices').then(setInvoices); api.get('/quotes').then(setQuotes); api.get('/reports/wip').then(setWip); api.get('/rate-card').then(setRates); }, []);
  const saveRate = (r: any, patch: any) => api.patch(`/rate-card/${r.id}`, patch).then(() => api.get('/rate-card').then(setRates));
  return (
    <div>
      <h1>Money</h1>
      <div className="tabs">
        <button className={tab === 'invoices' ? 'on' : ''} onClick={() => setTab('invoices')}>Invoices</button>
        <button className={tab === 'quotes' ? 'on' : ''} onClick={() => setTab('quotes')}>Quotes</button>
        <button className={tab === 'wip' ? 'on' : ''} onClick={() => setTab('wip')}>Work in progress</button>
        <button className={tab === 'rates' ? 'on' : ''} onClick={() => setTab('rates')}>Rate card</button>
      </div>
      {tab === 'invoices' && <div className="card" style={{ padding: 0 }}><table><thead><tr><th>JN</th><th>Client</th><th>Reference</th><th>Issued / due</th><th className="num">Net</th><th>Status</th><th>Xero</th></tr></thead><tbody>
        {invoices.map(i => <tr key={i.id}><td><Link to={`/jobs/${i.job_id}`}>{i.job_number}</Link></td><td>{i.client_name}</td><td className="small">{i.reference}</td><td className="small">{fmtDate(i.issue_date)} / {fmtDate(i.due_date)}</td><td className="num">{fmtMoney(i.net, i.currency)}</td><td><span className={`pill ${i.status === 'paid' ? 'ok' : i.status === 'pushed' ? 'warn' : ''}`}>{i.status}</span></td><td className="mono small">{i.xero_invoice_number ?? ''}</td></tr>)}
        {invoices.length === 0 && <tr><td colSpan={7} className="muted">No invoices yet.</td></tr>}</tbody></table></div>}
      {tab === 'quotes' && <div className="card" style={{ padding: 0 }}><table><thead><tr><th>Quote</th><th>JN</th><th>Job</th><th>Client</th><th className="num">Net</th><th>Status</th></tr></thead><tbody>
        {quotes.map(q => <tr key={q.id}><td className="mono">{q.number}</td><td><Link to={`/jobs/${q.job_id}`}>{q.job_number}</Link></td><td>{q.job_title}</td><td>{q.client_name}</td><td className="num">{fmtMoney(q.net, q.currency)}</td><td><span className={`pill ${q.status === 'approved' ? 'ok' : q.status === 'draft' || q.status === 'sent' ? 'warn' : 'bad'}`}>{q.status}</span></td></tr>)}
        {quotes.length === 0 && <tr><td colSpan={6} className="muted">No quotes yet.</td></tr>}</tbody></table></div>}
      {tab === 'wip' && <div className="card" style={{ padding: 0 }}><table><thead><tr><th>JN</th><th>Job</th><th>Status</th><th className="num">Approved</th><th className="num">Invoiced</th><th className="num">Still to bill</th><th className="num">Hours</th><th className="num">Freelancer cost</th></tr></thead><tbody>
        {wip.map(w => <tr key={w.id}><td><Link to={`/jobs/${w.id}`}>{w.job_number}</Link></td><td>{w.title}<div className="muted small">{w.client_name}</div></td><td><span className="pill">{w.status.replace('_', ' ')}</span></td><td className="num">{fmtMoney(w.approved_net, w.currency)}</td><td className="num">{fmtMoney(w.invoiced_net, w.currency)}</td><td className="num"><b>{fmtMoney(w.approved_net - w.invoiced_net, w.currency)}</b></td><td className="num">{w.hours_logged}</td><td className="num">{fmtMoney(w.freelancer_cost, w.currency)}</td></tr>)}
      </tbody></table></div>}
      {tab === 'rates' && <div className="card" style={{ padding: 0 }}><p className="small muted" style={{ padding: '8px 10px', margin: 0 }}>What DeLorean quotes from. Click a price to change it.</p><table><thead><tr><th>Code</th><th>Description</th><th>Dept</th><th>Unit</th><th className="num">Price</th><th>Xero acct</th></tr></thead><tbody>
        {rates.map(r => <tr key={r.id}><td className="mono small">{r.code}</td><td>{r.description}</td><td className="small">{r.department_name}</td><td className="small">{r.unit}</td>
          <td className="num"><input type="number" defaultValue={r.unit_price} style={{ width: 100, textAlign: 'right' }} onBlur={e => Number(e.target.value) !== r.unit_price && saveRate(r, { unit_price: Number(e.target.value) })} /></td><td className="mono small">{r.xero_account_code}</td></tr>)}
      </tbody></table></div>}
    </div>
  );
}
