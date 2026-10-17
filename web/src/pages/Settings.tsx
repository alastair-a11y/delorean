import { useEffect, useState } from 'react';
import { api } from '../api.ts';

const LABELS: Record<string, string> = {
  company_name: 'Company name', legal_name: 'Legal name', base_currency: 'Base currency', tax_rate: 'VAT %', next_job_number: 'Next job number',
  default_payment_terms: 'Payment terms (days)', timezone: 'Timezone', working_day_start: 'Working day starts', working_day_end: 'Working day ends',
  nudge_time: 'Hours nudge time (HH:MM)', nudge_channel: 'Nudge channel (chat / email / inapp)', google_domain: 'Google Workspace domain', google_chat_space: 'Ops Chat space (spaces/…)',
  auto_calendar_sync: 'Sync bookings to Google Calendar (1/0)', mail_autopilot: 'Mail bot may change the schedule itself (1/0)',
  xero_default_revenue_account: 'Xero default revenue account', xero_stock_account: 'Xero stock/drives account',
};

export default function Settings() {
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [sched, setSched] = useState<any>(null);
  const load = () => api.get('/settings').then(d => { setData(d); setForm(d.settings); });
  useEffect(() => { load(); api.get('/assistant/scheduler').then(setSched); }, []);
  if (!data) return null;
  const save = () => api.patch('/settings', form).then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500); load(); });
  const Status = ({ ok, text }: { ok: boolean; text: string }) => <span className={`pill ${ok ? 'ok' : 'warn'}`}>{text}</span>;
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h1>Settings</h1>

      <div className="card">
        <div className="row"><h2 style={{ margin: 0 }}>Claude</h2><Status ok={data.claude.configured} text={data.claude.configured ? `ready · ${data.claude.model}` : 'not configured'} /></div>
        <p className="small muted">Set <code>ANTHROPIC_API_KEY</code> in the server environment. Optional: <code>DELOREAN_MODEL</code> (default claude-opus-5-5) and <code>DELOREAN_TRIAGE_MODEL</code> for mail triage (default claude-haiku-5-5).</p>
      </div>

      <div className="card">
        <div className="row"><h2 style={{ margin: 0 }}>Xero</h2><Status ok={data.xero.connected} text={data.xero.connected ? `connected · ${data.xero.tenant_name}` : data.xero.configured ? 'not connected' : 'no app credentials'} /></div>
        <p className="small muted">Invoices go in as DRAFT sales invoices with the Department and Job Number tracking categories, coded to the department revenue accounts. Needs a Xero app: set <code>XERO_CLIENT_ID</code>, <code>XERO_CLIENT_SECRET</code> and <code>XERO_REDIRECT_URI</code> = <code>{data.google.public_url}/api/settings/xero/callback</code>.</p>
        <div className="row">
          {data.xero.configured && !data.xero.connected && <a href="/api/settings/xero/connect"><button className="primary">Connect to Xero</button></a>}
          {data.xero.connected && <>
            <button onClick={() => api.post('/settings/xero/sync-tracking').then(load)}>Re-read tracking categories</button>
            <button onClick={() => api.post('/settings/xero/refresh-invoices').then(r => alert(`${r.updated} invoices refreshed`))}>Refresh invoice statuses</button>
            <button className="ghost danger" onClick={() => api.post('/settings/xero/disconnect').then(load)}>Disconnect</button>
          </>}
        </div>
      </div>

      <div className="card">
        <div className="row"><h2 style={{ margin: 0 }}>Google Workspace</h2><Status ok={data.google.configured} text={data.google.configured ? `service account · ${data.google.service_account}` : 'not configured'} /></div>
        <p className="small muted">One service account with domain-wide delegation runs the bots: bookings on everyone’s Calendar, Gmail watched for job requests and hours, Chat for nudges and questions.</p>
        <ol className="small muted" style={{ paddingLeft: 18, margin: '6px 0' }}>
          <li>Create a service account in Google Cloud, enable Calendar, Gmail, Chat and Pub/Sub APIs, download the key, set <code>GOOGLE_SERVICE_ACCOUNT_JSON</code>.</li>
          <li>Admin console → Security → API controls → Domain-wide delegation: add the client id with scopes calendar, gmail.readonly, gmail.send, chat.bot.</li>
          <li>Pub/Sub: topic <code>delorean-gmail</code> with a push subscription to <code>{data.google.gmail_push_endpoint}</code>; grant <code>gmail-api-push@system.gserviceaccount.com</code> publish rights. Set <code>GOOGLE_PUBSUB_TOPIC</code>.</li>
          <li>Google Chat API → configure the app: HTTP endpoint <code>{data.google.chat_webhook}</code>, enable 1:1 messages.</li>
          <li>Set <code>PUBLIC_URL</code> and <code>GOOGLE_DELEGATED_ADMIN</code> (a Workspace admin who owns the room calendars). Calendar push goes to <code>{data.google.calendar_push_endpoint}</code>.</li>
        </ol>
        {data.google.configured && <div className="row"><button onClick={() => api.post('/assistant/scheduler/tick?force=watches,calendar').then(r => alert(r.ran.join('\n') || 'Nothing to do'))}>Renew watches & sync calendars now</button></div>}
      </div>

      <div className="card">
        <div className="row"><h2 style={{ margin: 0 }}>Bots</h2><Status ok={!!sched?.running} text={sched?.running ? 'scheduler running' : 'scheduler off'} /></div>
        <p className="small muted">Every minute the scheduler checks what’s due: hours nudges at {form.nudge_time ?? '17:30'}, calendar reconcile every 5 min, Google watch renewals every 6 h, Xero status refresh hourly.</p>
        <div className="row"><button onClick={() => api.post('/assistant/nudges/run').then(r => alert(`${r.results.filter((x: any) => x.status === 'sent').length} nudges sent`))}>Send hours nudges now</button><button onClick={() => api.post('/assistant/scheduler/tick').then(r => alert(r.ran.join('\n') || 'Nothing was due'))}>Run a tick</button></div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Company & defaults</h2>
        <div className="form">
          {data.editable.map((k: string) => <div key={k}><label>{LABELS[k] ?? k}</label><input value={form[k] ?? ''} onChange={e => setForm({ ...form, [k]: e.target.value })} /></div>)}
        </div>
        <div className="row" style={{ marginTop: 12 }}><span className="right" />{saved && <span className="pill ok">Saved</span>}<button className="primary" onClick={save}>Save</button></div>
      </div>
    </div>
  );
}
