import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import Modal from '../components/Modal.tsx';

export default function People() {
  const [rows, setRows] = useState<any[]>([]);
  const [depts, setDepts] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const load = () => api.get('/resources?all=1').then(setRows);
  useEffect(() => { load(); api.get('/departments').then(setDepts); }, []);
  async function save() {
    const body = { ...edit, department_id: edit.department_id ? Number(edit.department_id) : null, is_freelancer: edit.is_freelancer ? 1 : 0, cost_day_rate: edit.cost_day_rate ? Number(edit.cost_day_rate) : null, charge_day_rate: edit.charge_day_rate ? Number(edit.charge_day_rate) : null, active: edit.active === 0 ? 0 : 1 };
    if (edit.id) await api.patch(`/resources/${edit.id}`, body); else await api.post('/resources', body);
    setEdit(null); load();
  }
  const groups = [['room', 'Rooms & suites'], ['kit', 'Kit'], ['person', 'People']] as const;
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}><h1 style={{ margin: 0 }}>People & rooms</h1><button className="primary right" onClick={() => setEdit({ type: 'person', active: 1 })}>+ Add</button></div>
      <p className="muted small">People with a Workspace email get their bookings on their Google Calendar and hours nudges on Chat. Rooms and kit can have a Google resource calendar.</p>
      {groups.map(([t, label]) => (
        <div key={t} className="card" style={{ padding: 0, marginBottom: 14 }}>
          <div style={{ padding: '8px 10px', fontWeight: 600 }}>{label}</div>
          <table><thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Email / calendar</th><th className="num">Cost/day</th><th className="num">Charge/day</th><th /></tr></thead><tbody>
            {rows.filter(r => r.type === t).map(r => <tr key={r.id} className="click" onClick={() => setEdit({ ...r })} style={r.active ? {} : { opacity: .5 }}>
              <td><b>{r.name}</b> {r.is_freelancer ? <span className="pill">freelance</span> : null}</td><td>{r.role ?? ''}</td><td>{r.department_name ?? ''}</td><td className="small">{r.google_calendar_id ?? r.email ?? ''}</td>
              <td className="num">{r.cost_day_rate ?? '–'}</td><td className="num">{r.charge_day_rate ?? '–'}</td><td className="small muted">{r.active ? '' : 'inactive'}</td></tr>)}
          </tbody></table>
        </div>
      ))}
      {edit && <Modal title={edit.id ? edit.name : 'New'} onClose={() => setEdit(null)}>
        <div className="form">
          <div className="full"><label>Name</label><input value={edit.name ?? ''} onChange={e => setEdit({ ...edit, name: e.target.value })} autoFocus /></div>
          <div><label>Type</label><select value={edit.type} onChange={e => setEdit({ ...edit, type: e.target.value })}><option value="person">Person</option><option value="room">Room / suite</option><option value="kit">Kit</option></select></div>
          <div><label>Role</label><input value={edit.role ?? ''} onChange={e => setEdit({ ...edit, role: e.target.value })} placeholder="Colourist / Avid suite / LTO deck" /></div>
          <div><label>Department</label><select value={edit.department_id ?? ''} onChange={e => setEdit({ ...edit, department_id: e.target.value })}><option value="">—</option>{depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
          <div><label>Email (Workspace)</label><input value={edit.email ?? ''} onChange={e => setEdit({ ...edit, email: e.target.value })} /></div>
          <div><label>Google calendar id (rooms/kit)</label><input value={edit.google_calendar_id ?? ''} onChange={e => setEdit({ ...edit, google_calendar_id: e.target.value })} placeholder="…@resource.calendar.google.com" /></div>
          <div><label>Freelancer?</label><select value={edit.is_freelancer ? 1 : 0} onChange={e => setEdit({ ...edit, is_freelancer: Number(e.target.value) })}><option value={0}>Staff</option><option value={1}>Freelancer</option></select></div>
          <div><label>Cost per day</label><input type="number" value={edit.cost_day_rate ?? ''} onChange={e => setEdit({ ...edit, cost_day_rate: e.target.value })} /></div>
          <div><label>Charge per day</label><input type="number" value={edit.charge_day_rate ?? ''} onChange={e => setEdit({ ...edit, charge_day_rate: e.target.value })} /></div>
          <div><label>Active</label><select value={edit.active ?? 1} onChange={e => setEdit({ ...edit, active: Number(e.target.value) })}><option value={1}>Yes</option><option value={0}>No</option></select></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}><span className="right" /><button onClick={() => setEdit(null)}>Cancel</button><button className="primary" disabled={!edit.name} onClick={save}>Save</button></div>
      </Modal>}
    </div>
  );
}
