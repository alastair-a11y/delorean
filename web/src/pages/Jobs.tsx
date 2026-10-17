import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate, fmtMoney } from '../api.ts';
import Modal from '../components/Modal.tsx';

const STATUSES = ['enquiry', 'quoted', 'confirmed', 'in_progress', 'delivered', 'invoiced', 'closed', 'cancelled'];
export const statusPill = (s: string) => <span className={`pill ${['confirmed', 'in_progress'].includes(s) ? 'ok' : ['enquiry', 'quoted'].includes(s) ? 'warn' : s === 'cancelled' ? 'bad' : ''}`}>{s.replace('_', ' ')}</span>;

export default function Jobs() {
  const nav = useNavigate();
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [clients, setClients] = useState<any[]>([]);
  const [depts, setDepts] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ title: '', status: 'enquiry' });
  const load = () => api.get(`/jobs?q=${encodeURIComponent(q)}&status=${status}`).then(setRows);
  useEffect(() => { load(); }, [q, status]);
  useEffect(() => { api.get('/clients').then(setClients); api.get('/departments').then(setDepts); }, []);

  async function create() {
    const j = await api.post('/jobs', { ...form, client_id: form.client_id ? Number(form.client_id) : null, department_id: form.department_id ? Number(form.department_id) : null });
    setCreating(false); nav(`/jobs/${j.id}`);
  }
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Jobs</h1>
        <input placeholder="Search title, client, JN" value={q} onChange={e => setQ(e.target.value)} style={{ width: 260 }} />
        <select value={status} onChange={e => setStatus(e.target.value)}><option value="">Any status</option>{STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>
        <button className="primary right" onClick={() => setCreating(true)}>+ Job</button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>JN</th><th>Title</th><th>Client</th><th>Dept</th><th>Status</th><th>Dates</th><th className="num">Bookings</th><th className="num">Quoted</th><th className="num">Invoiced</th></tr></thead>
          <tbody>
            {rows.map(j => (
              <tr key={j.id} className="click" onClick={() => nav(`/jobs/${j.id}`)}>
                <td className="mono"><b>{j.job_number}</b></td><td>{j.title}</td><td>{j.client_name ?? <span className="muted">–</span>}</td>
                <td><span className="pill" style={{ background: (j.department_colour ?? '#ccc') + '22', color: j.department_colour ?? '#333' }}>{j.department_name ?? '–'}</span></td>
                <td>{statusPill(j.status)}</td><td className="small">{fmtDate(j.start_date)} – {fmtDate(j.end_date)}</td>
                <td className="num">{j.booking_count}</td><td className="num">{fmtMoney(j.approved_quote_net, j.currency)}</td><td className="num">{fmtMoney(j.invoiced_net, j.currency)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted">No jobs match.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && (
        <Modal title="New job" onClose={() => setCreating(false)}>
          <div className="form">
            <div className="full"><label>Title</label><input autoFocus value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Angel in the Rubble" /></div>
            <div><label>Client</label><select value={form.client_id ?? ''} onChange={e => setForm({ ...form, client_id: e.target.value })}><option value="">—</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label>Department</label><select value={form.department_id ?? ''} onChange={e => setForm({ ...form, department_id: e.target.value })}><option value="">—</option>{depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
            <div><label>Kind</label><input value={form.kind ?? ''} onChange={e => setForm({ ...form, kind: e.target.value })} placeholder="Feature / TVC / Dailies" /></div>
            <div><label>Status</label><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>{STATUSES.slice(0, 4).map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></div>
            <div><label>Start</label><input type="date" value={form.start_date ?? ''} onChange={e => setForm({ ...form, start_date: e.target.value || null })} /></div>
            <div><label>End</label><input type="date" value={form.end_date ?? ''} onChange={e => setForm({ ...form, end_date: e.target.value || null })} /></div>
            <div><label>PO number</label><input value={form.po_number ?? ''} onChange={e => setForm({ ...form, po_number: e.target.value })} /></div>
            <div><label>Producer</label><input value={form.producer ?? ''} onChange={e => setForm({ ...form, producer: e.target.value })} /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><span className="right" /><button onClick={() => setCreating(false)}>Cancel</button><button className="primary" disabled={!form.title} onClick={create}>Create</button></div>
        </Modal>
      )}
    </div>
  );
}
