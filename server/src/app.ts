/**
 * Core HTTP app: every business operation is a route here, and the Claude
 * tools call these same routes in-process (app.request), so the assistant,
 * the bots and the UI all go through one validated code path.
 */
import { Hono } from 'hono';
import { HttpError } from './http.ts';
import { reference } from './routes/reference.ts';
import { jobs } from './routes/jobs.ts';
import { bookings } from './routes/bookings.ts';
import { quotes } from './routes/quotes.ts';
import { invoices } from './routes/invoices.ts';
import { timesheets } from './routes/timesheets.ts';
import { reports } from './routes/reports.ts';
import { settingsRoutes } from './routes/settings.ts';

export const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, detail: err.detail ?? null }, err.status as any);
  console.error(err);
  return c.json({ error: (err as Error).message ?? 'Internal error' }, 500);
});

app.get('/api/health', c => c.json({ ok: true, name: 'DeLorean', time: new Date().toISOString() }));
app.route('/api', reference);
app.route('/api/jobs', jobs);
app.route('/api/bookings', bookings);
app.route('/api/quotes', quotes);
app.route('/api/invoices', invoices);
app.route('/api/timesheets', timesheets);
app.route('/api/reports', reports);
app.route('/api/settings', settingsRoutes);

/** In-process call used by Claude tools and bots. Throws HttpError on non-2xx. */
export async function internal<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status, json?.error ?? `${method} ${path} failed`, json?.detail);
  return json as T;
}
