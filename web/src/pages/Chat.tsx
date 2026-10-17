import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, chatStream } from '../api.ts';

interface Msg { role: 'user' | 'assistant'; text: string; tools?: { name: string }[]; files?: string[]; streaming?: boolean }

const CHIPS = [
  "What's on today?",
  'Who is free next week?',
  'Pencil Thandi and Grade Suite 1 for a 3-day grade on 1600 from Monday',
  'Quote 2 weeks of edit suite dry hire for Ogilvy',
  'Raise the 1st 50% invoice on 1600',
  'Who hasn’t logged hours today?',
];

export default function Chat() {
  const { id } = useParams();
  const nav = useNavigate();
  const [convId, setConvId] = useState<number | null>(id ? Number(id) : null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [convs, setConvs] = useState<any[]>([]);
  const [ready, setReady] = useState<boolean | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { api.get('/settings').then(s => setReady(s.claude.configured)).catch(() => setReady(false)); }, []);
  useEffect(() => { api.get('/assistant/conversations').then(setConvs).catch(() => undefined); }, [convId, busy]);
  useEffect(() => {
    if (!id) { setConvId(null); setMsgs([]); return; }
    api.get(`/assistant/conversations/${id}`).then(c => { setConvId(c.id); setMsgs(c.messages.map((m: any) => ({ role: m.role, text: m.text, tools: m.tools }))); }).catch(() => nav('/'));
  }, [id]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  async function send(text = input) {
    if ((!text.trim() && !files.length) || busy) return;
    const form = new FormData();
    form.set('message', text);
    if (convId) form.set('conversation_id', String(convId));
    files.forEach(f => form.append('files', f));
    setMsgs(m => [...m, { role: 'user', text, files: files.map(f => f.name) }, { role: 'assistant', text: '', tools: [], streaming: true }]);
    setInput(''); setFiles([]); setBusy(true);
    abort.current = new AbortController();
    try {
      for await (const ev of chatStream(form, abort.current.signal)) {
        if (ev.type === 'meta' && ev.conversation_id) { setConvId(ev.conversation_id); if (!convId) window.history.replaceState(null, '', `/chat/${ev.conversation_id}`); }
        setMsgs(m => {
          const last = { ...m[m.length - 1] };
          if (ev.type === 'text') last.text += ev.text ?? '';
          else if (ev.type === 'tool_start' && ev.name && !ev.input) last.tools = [...(last.tools ?? []), { name: ev.name }];
          else if (ev.type === 'error') last.text += `\n⚠️ ${ev.text}`;
          else if (ev.type === 'done') last.streaming = false;
          return [...m.slice(0, -1), last];
        });
      }
    } finally { setBusy(false); setMsgs(m => m.map(x => ({ ...x, streaming: false }))); }
  }

  function onDrop(e: React.DragEvent) { e.preventDefault(); setDrag(false); setFiles(f => [...f, ...Array.from(e.dataTransfer.files)]); }

  return (
    <div className="chat" onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <div className="thread">
        {ready === false && <div className="warnbox">Claude isn’t connected yet. Set <code>ANTHROPIC_API_KEY</code> on the server and restart. Everything else still works from the other tabs.</div>}
        {msgs.length === 0 && (
          <div className="empty">
            <h1>What do you need?</h1>
            <p>Tell me what to book, drop a producer’s schedule or email on this page, or ask what’s on. I’ll set up the job, the schedule and the quote, and chase the hours.</p>
            {convs.length > 0 && <div className="stack" style={{ textAlign: 'left', marginTop: 20 }}>
              <div className="small muted">Recent</div>
              {convs.slice(0, 6).map(c => <a key={c.id} href={`/chat/${c.id}`} onClick={e => { e.preventDefault(); nav(`/chat/${c.id}`); }} className="card small" style={{ padding: '8px 12px' }}>{c.title ?? 'Conversation'}<div className="muted">{(c.last_reply ?? '').slice(0, 100)}</div></a>)}
            </div>}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.files?.length ? <div className="row" style={{ marginBottom: 6 }}>{m.files.map(f => <span key={f} className="attach">📎 {f}</span>)}</div> : null}
            {m.text || (m.streaming ? <span className="muted">thinking…</span> : '')}
            {m.tools?.length ? <div className="tools">{m.tools.map((t, j) => <span key={j} className="tool">⚙ {t.name.replace(/_/g, ' ')}</span>)}</div> : null}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div>
        {msgs.length === 0 && <div className="chips">{CHIPS.map(c => <button key={c} className="chip" onClick={() => send(c)}>{c}</button>)}</div>}
        <div className={`composer ${drag ? 'drag' : ''}`}>
          {files.length > 0 && <div className="row" style={{ marginBottom: 6 }}>{files.map((f, i) => <span key={i} className="attach">📎 {f.name} <button className="ghost small" onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))}>×</button></span>)}</div>}
          <textarea value={input} onChange={e => setInput(e.target.value)} placeholder={drag ? 'Drop it here' : 'Book, quote, ask… or drop a spreadsheet, PDF or email here'}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} disabled={busy} autoFocus />
          <div className="row">
            <label className="chip" style={{ margin: 0 }}>📎 Attach<input type="file" multiple hidden onChange={e => setFiles(f => [...f, ...Array.from(e.target.files ?? [])])} /></label>
            {convId && <button className="ghost small" onClick={() => nav('/')}>New conversation</button>}
            <span className="right" />
            {busy ? <button onClick={() => abort.current?.abort()}>Stop</button> : <button className="primary" onClick={() => send()} disabled={!input.trim() && !files.length}>Send</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
