export class ApiError extends Error {
  status: number; detail: unknown;
  constructor(status: number, message: string, detail?: unknown) { super(message); this.status = status; this.detail = detail; }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error ?? res.statusText, json?.detail);
  return json as T;
}

export const api = {
  get: <T = any>(path: string) => fetch(`/api${path}`).then(r => handle<T>(r)),
  post: <T = any>(path: string, body?: unknown) => fetch(`/api${path}`, { method: 'POST', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }).then(r => handle<T>(r)),
  patch: <T = any>(path: string, body: unknown) => fetch(`/api${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => handle<T>(r)),
  del: <T = any>(path: string) => fetch(`/api${path}`, { method: 'DELETE' }).then(r => handle<T>(r)),
  form: <T = any>(path: string, form: FormData) => fetch(`/api${path}`, { method: 'POST', body: form }).then(r => handle<T>(r)),
};

export interface ChatEvent { type: 'meta' | 'text' | 'tool_start' | 'tool_result' | 'done' | 'error'; text?: string; name?: string; input?: unknown; result?: string; conversation_id?: number }

/** Stream the assistant's reply as SSE events. */
export async function* chatStream(form: FormData, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const res = await fetch('/api/assistant/chat', { method: 'POST', body: form, signal });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => null);
    yield { type: 'error', text: j?.error ?? res.statusText };
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let event = 'message'; let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { const parsed = JSON.parse(data); yield { ...parsed, type: event as ChatEvent['type'] }; } catch { /* ignore */ }
    }
  }
}

export const fmtMoney = (n: number | null | undefined, ccy = 'ZAR') =>
  n == null ? '–' : new Intl.NumberFormat('en-ZA', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(n);
export const fmtDate = (s: string | null | undefined) => s ? new Date(s.length === 10 ? s + 'T00:00' : s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '–';
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
