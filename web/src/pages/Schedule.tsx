import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, addDays, today, ApiError } from '../api.ts';
import Modal from '../components/Modal.tsx';

interface Resource { id: number; name: string; type: string; department_name: string | null; role: string | null }
interface Booking { id: number; resource_id: number; job_id: number | null; job_number: number | null; job_title: string | null; starts_at: string; ends_at: string; status: string; title: string | null; colour: string | null; client_name: string | null }

const DAYS = 14;

export default function Schedule() {
  const [start, setStart] = useState(() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); });
  const [resources, setResources] = useState<Resource[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [filter, setFilter] = useState<'all' | 'person' | 'room' | 'kit'>('all');
  const [edit, setEdit] = useState<Partial<Booking> & { date?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(start, i)), [start]);

  const load = () => Promise.all([
    api.get('/resources'), api.get(`/bookings?from=${start}&to=${addDays(start, DAYS)}`), api.get('/jobs'),
  ]).then(([r, b, j]) => { setResources(r); setBookings(b); setJobs(j.filter((x: any) => !['closed', 'cancelled'].includes(x.status))); });
  useEffect(() => { load(); }, [start]);

  const byCell = useMemo(() => {
    const m = new Map<string, Booking[]>();
    for (const b of bookings) {
      for (const d of days) if (b.starts_at.slice(0, 10) <= d && b.ends_at.slice(0, 10) >= d) {
        const k = `${b.resource_id}|${d}`; m.set(k, [...(m.get(k) ?? []), b]);
      }
    }
    return m;
  }, [bookings, days]);

  const groups = useMemo(() => {
    const vis = resources.filter(r => filter === 'all' || r.type === filter);
    const order = ['room', 'kit', 'person'];
    return order.map(t => ({ type: t, label: t === 'room' ? 'Rooms & suites' : t === 'kit' ? 'Kit' : 'People', rows: vis.filter(r => r.type === t) })).filter(g => g.rows.length);
  }, [resources, filter]);

  async function save() {
    if (!edit) return;
    setErr(null);
    const body: any = { job_id: edit.job_id ?? null, resource_id: edit.resource_id, starts_at: edit.starts_at, ends_at: edit.ends_at, status: edit.status ?? 'pencil', title: edit.title ?? null };
    try {
      if (edit.id) await api.patch(`/bookings/${edit.id}`, body); else await api.post('/bookings', body);
      setEdit(null); load();
    } catch (e) {
      const ae = e as ApiError;
      const clashes = (ae.detail as any)?.conflicts?.map((c: any) => `JN ${c.job_number} ${c.starts_at.slice(11)}–${c.ends_at.slice(11)}`).join(', ');
      setErr(clashes ? `${ae.message}: ${clashes}` : ae.message);
    }
  }
  async function remove() { if (edit?.id && confirm('Cancel this booking?')) { await api.patch(`/bookings/${edit.id}`, { status: 'cancelled' }); setEdit(null); load(); } }

  const cols = `180px repeat(${DAYS}, minmax(78px, 1fr))`;
  const t = today();
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Schedule</h1>
        <button onClick={() => setStart(addDays(start, -7))}>‹</button>
        <button onClick={() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); setStart(d.toISOString().slice(0, 10)); }}>This week</button>
        <button onClick={() => setStart(addDays(start, 7))}>›</button>
        <span className="muted">{new Date(start + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – {new Date(addDays(start, DAYS - 1) + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        <select className="right" value={filter} onChange={e => setFilter(e.target.value as any)}>
          <option value="all">Everything</option><option value="room">Rooms & suites</option><option value="kit">Kit</option><option value="person">People</option>
        </select>
        <button className="primary" onClick={() => setEdit({ date: t, starts_at: `${t}T09:00`, ends_at: `${t}T18:00`, status: 'pencil', resource_id: resources[0]?.id })}>+ Booking</button>
      </div>
      <div className="grid" style={{ gridTemplateColumns: cols }}>
        <div className="hd" style={{ borderLeft: 0 }} />
        {days.map(d => { const dt = new Date(d + 'T00:00'); const we = dt.getDay() === 0 || dt.getDay() === 6; return <div key={d} className={`hd ${d === t ? 'today' : ''} ${we ? 'we' : ''}`}>{dt.toLocaleDateString('en-GB', { weekday: 'short' })}<br /><b>{dt.getDate()}</b></div>; })}
        {groups.map(g => (
          <>
            <div key={g.type} className="rh group">{g.label}</div>
            {days.map(d => <div key={g.type + d} className="cell" style={{ background: '#f0f0ec', cursor: 'default', minHeight: 20 }} />)}
            {g.rows.map(r => (
              <>
                <div key={'r' + r.id} className="rh" title={r.role ?? ''}>{r.name}<div className="muted" style={{ fontSize: 10 }}>{r.role ?? r.department_name ?? ''}</div></div>
                {days.map(d => {
                  const dt = new Date(d + 'T00:00'); const we = dt.getDay() === 0 || dt.getDay() === 6;
                  const list = byCell.get(`${r.id}|${d}`) ?? [];
                  return (
                    <div key={r.id + d} className={`cell ${we ? 'we' : ''}`} onClick={() => setEdit({ date: d, resource_id: r.id, starts_at: `${d}T09:00`, ends_at: `${d}T18:00`, status: 'pencil' })}>
                      {list.map(b => (
                        <div key={b.id} className={`bk ${b.status}`} style={b.status === 'pencil' ? {} : { background: b.colour ?? '#555' }}
                          title={`JN ${b.job_number ?? '–'} ${b.job_title ?? ''}\n${b.starts_at.slice(11)}–${b.ends_at.slice(11)} · ${b.status}`}
                          onClick={e => { e.stopPropagation(); setEdit({ ...b }); }}>
                          {b.job_number ? `${b.job_number} ` : ''}{b.title ?? b.job_title ?? 'Booking'}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </>
            ))}
          </>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>Click a cell to pencil something in. Hatched = pencil, solid = confirmed. Confirmed bookings can’t double-book; pencils can.</p>

      {edit && (
        <Modal title={edit.id ? `Booking ${edit.job_number ? `· JN ${edit.job_number}` : ''}` : 'New booking'} onClose={() => { setEdit(null); setErr(null); }}>
          <div className="form">
            <div className="full"><label>Job</label>
              <select value={edit.job_id ?? ''} onChange={e => setEdit({ ...edit, job_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— no job (hold / maintenance) —</option>
                {jobs.map(j => <option key={j.id} value={j.id}>{j.job_number} · {j.title} ({j.client_name ?? 'no client'})</option>)}
              </select></div>
            <div className="full"><label>Resource</label>
              <select value={edit.resource_id ?? ''} onChange={e => setEdit({ ...edit, resource_id: Number(e.target.value) })}>
                {resources.map(r => <option key={r.id} value={r.id}>{r.name} · {r.type}</option>)}
              </select></div>
            <div><label>Start</label><input type="datetime-local" value={edit.starts_at ?? ''} onChange={e => setEdit({ ...edit, starts_at: e.target.value.slice(0, 16) })} /></div>
            <div><label>End</label><input type="datetime-local" value={edit.ends_at ?? ''} onChange={e => setEdit({ ...edit, ends_at: e.target.value.slice(0, 16) })} /></div>
            <div><label>Status</label><select value={edit.status ?? 'pencil'} onChange={e => setEdit({ ...edit, status: e.target.value })}><option value="pencil">Pencil</option><option value="confirmed">Confirmed</option></select></div>
            <div><label>Label</label><input value={edit.title ?? ''} onChange={e => setEdit({ ...edit, title: e.target.value })} placeholder="Grade day 2" /></div>
          </div>
          {err && <p className="err">{err}</p>}
          <div className="row" style={{ marginTop: 12 }}>
            {edit.id && <button className="danger" onClick={remove}>Cancel booking</button>}
            {edit.job_id && <Link to={`/jobs/${edit.job_id}`} className="small">Open job →</Link>}
            <span className="right" />
            <button onClick={() => setEdit(null)}>Close</button>
            <button className="primary" onClick={save}>{edit.id ? 'Save' : 'Add'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
