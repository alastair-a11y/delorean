/**
 * Hours-tracking bot. At the end of each working day it asks everyone who was
 * booked how many hours they did. Replies come back through Chat, email or the
 * magic link, get parsed by Claude, and land as timesheet entries.
 */
import { randomBytes } from 'node:crypto';
import { all, get, run, setting, logActivity } from '../db.ts';
import { internal } from '../app.ts';
import { parseHoursReply } from '../ai/parsers.ts';
import { sendToPerson } from './channels.ts';
import { publicUrl } from '../google/auth.ts';

export function localToday(): string {
  const tz = setting('timezone') ?? 'Africa/Johannesburg';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function localTimeHHMM(): string {
  const tz = setting('timezone') ?? 'Africa/Johannesburg';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

function nudgeText(name: string, date: string, jobs: string, link: string) {
  const first = name.split(' ')[0];
  return `Hi ${first}, quick one from DeLorean. How many hours did you do today (${date}) on ${jobs}? Just reply with the number (e.g. "8", or "6 on 1600 and 2 on 1603"). Or tap: ${link}`;
}

/** Send nudges for everyone booked on `date` who hasn't logged hours. Idempotent per person per day. */
export async function runDailyNudges(date = localToday()) {
  const missing = await internal<{ resource_id: number; name: string; email: string | null; jobs: string }[]>('GET', `/api/timesheets/missing?date=${date}`);
  const results: { resource_id: number; status: string; via?: string }[] = [];
  for (const m of missing) {
    if (get('SELECT 1 FROM nudges WHERE resource_id = ? AND work_date = ?', m.resource_id, date)) { results.push({ resource_id: m.resource_id, status: 'already_sent' }); continue; }
    const token = randomBytes(12).toString('base64url');
    const link = `${publicUrl()}/t/${token}`;
    const text = nudgeText(m.name, date, m.jobs ?? 'your bookings', link);
    const channel = (setting('nudge_channel') ?? 'chat') === 'inapp' ? 'inapp' : 'email';
    const id = Number(run('INSERT INTO nudges(resource_id, work_date, channel, token, message, status) VALUES (?, ?, ?, ?, ?, ?)', m.resource_id, date, channel, token, text, 'queued').lastInsertRowid);
    try {
      const r = await sendToPerson(m.resource_id, text, { subject: `Hours for ${date}`, nudgeId: id });
      run("UPDATE nudges SET status = 'sent', sent_at = datetime('now'), channel = ? WHERE id = ?", r.sent === 'chat' ? 'inapp' : r.sent === 'email' ? 'email' : 'inapp', id);
      results.push({ resource_id: m.resource_id, status: 'sent', via: r.sent });
    } catch (e) {
      run("UPDATE nudges SET status = 'failed', error = ? WHERE id = ?", (e as Error).message, id);
      results.push({ resource_id: m.resource_id, status: 'failed' });
    }
  }
  return { date, results };
}

/** Free-text hours reply from a person (Chat message, email, or the link form). */
export async function handleHoursReply(resourceId: number, text: string, opts: { date?: string; token?: string; source?: 'reply' | 'link' } = {}) {
  const nudge = opts.token
    ? get<{ id: number; work_date: string }>('SELECT id, work_date FROM nudges WHERE token = ?', opts.token)
    : get<{ id: number; work_date: string }>("SELECT id, work_date FROM nudges WHERE resource_id = ? AND status = 'sent' ORDER BY work_date DESC LIMIT 1", resourceId);
  const date = opts.date ?? nudge?.work_date ?? localToday();
  const parsed = await parseHoursReply(resourceId, date, text);
  if (!parsed) return { ok: false, reply: 'Sorry, I could not read that. How many hours, and on which job?' };
  if (parsed.needs_clarification) return { ok: false, reply: parsed.needs_clarification };
  if (parsed.off_today) {
    if (nudge) run("UPDATE nudges SET status = 'answered', reply_text = ?, replied_at = datetime('now') WHERE id = ?", text, nudge.id);
    return { ok: true, reply: 'No worries, marked as no hours today.' };
  }
  const entries = parsed.entries.map(e => ({ resource_id: resourceId, work_date: date, hours: e.hours, job_id: e.job_id ?? undefined, notes: e.notes ?? undefined, source: opts.source ?? 'reply' }));
  if (!entries.length) return { ok: false, reply: 'How many hours did you do, and on which job?' };
  const created = await internal<any[]>('POST', '/api/timesheets', { entries });
  if (nudge) run("UPDATE nudges SET status = 'answered', reply_text = ?, replied_at = datetime('now') WHERE id = ?", text, nudge.id);
  const total = entries.reduce((s, e) => s + e.hours, 0);
  const jobs = created.map(c => c.job_number ? `JN ${c.job_number}` : 'unassigned').join(', ');
  return { ok: true, reply: `Logged ${total}h for ${date} (${jobs}). Thanks.`, entries: created };
}

export function nudgeByToken(token: string) {
  return get<{ id: number; resource_id: number; work_date: string; status: string; name: string }>(
    'SELECT n.*, r.name FROM nudges n JOIN resources r ON r.id = n.resource_id WHERE n.token = ?', token);
}

export function listNudges(limit = 100) {
  return all('SELECT n.*, r.name AS resource_name FROM nudges n JOIN resources r ON r.id = n.resource_id ORDER BY n.id DESC LIMIT ?', limit);
}
