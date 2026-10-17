import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, run, logActivity } from '../db.ts';
import { body, idParam, HttpError, isoDate, nullableStr } from '../http.ts';

export const timesheets = new Hono();

const select = `
  SELECT t.*, r.name AS resource_name, j.job_number, j.title AS job_title
    FROM timesheets t JOIN resources r ON r.id = t.resource_id LEFT JOIN jobs j ON j.id = t.job_id`;

timesheets.get('/', c => {
  const from = c.req.query('from'); const to = c.req.query('to');
  const jobId = c.req.query('job_id'); const resourceId = c.req.query('resource_id');
  return c.json(all(`${select}
     WHERE (? IS NULL OR t.work_date >= ?) AND (? IS NULL OR t.work_date <= ?)
       AND (? IS NULL OR t.job_id = ?) AND (? IS NULL OR t.resource_id = ?)
     ORDER BY t.work_date DESC, r.name`,
    from ?? null, from ?? null, to ?? null, to ?? null, jobId ?? null, jobId ?? null, resourceId ?? null, resourceId ?? null));
});

const entrySchema = z.object({
  resource_id: z.number().int(),
  job_id: z.number().int().nullable().optional(),
  booking_id: z.number().int().nullable().optional(),
  work_date: isoDate,
  hours: z.number().min(0).max(24),
  notes: nullableStr,
  source: z.enum(['app', 'reply', 'link', 'assistant', 'import']).optional(),
});

/** One entry, or {entries:[...]} for several. If job_id is omitted we attach to the booking on that day when there is exactly one. */
timesheets.post('/', async c => {
  const raw = await c.req.json().catch(() => { throw new HttpError(400, 'Request body must be JSON'); });
  const list = Array.isArray(raw?.entries) ? raw.entries : [raw];
  const parsed = z.array(entrySchema).min(1).safeParse(list);
  if (!parsed.success) throw new HttpError(400, 'Validation failed', parsed.error.flatten());
  const created = parsed.data.map(e => {
    let jobId = e.job_id ?? null;
    let bookingId = e.booking_id ?? null;
    if (!jobId) {
      const candidates = all<{ id: number; job_id: number; status: string }>(
        "SELECT id, job_id, status FROM bookings WHERE resource_id = ? AND status <> 'cancelled' AND job_id IS NOT NULL AND substr(starts_at,1,10) <= ? AND substr(ends_at,1,10) >= ?",
        e.resource_id, e.work_date, e.work_date);
      // Prefer the confirmed booking; a pencil overlapping it is not what they worked on.
      const confirmed = candidates.filter(b => b.status === 'confirmed');
      const pick = confirmed.length === 1 ? confirmed[0] : candidates.length === 1 ? candidates[0] : null;
      if (pick) { jobId = pick.job_id; bookingId ??= pick.id; }
    }
    const r = run('INSERT INTO timesheets(resource_id, job_id, booking_id, work_date, hours, notes, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      e.resource_id, jobId, bookingId, e.work_date, e.hours, e.notes ?? null, e.source ?? 'app');
    if (jobId) logActivity('job', jobId, 'hours.logged', { resource_id: e.resource_id, date: e.work_date, hours: e.hours });
    return get(`${select} WHERE t.id = ?`, r.lastInsertRowid);
  });
  return c.json(Array.isArray(raw?.entries) ? created : created[0], 201);
});

timesheets.delete('/:id', c => { run('DELETE FROM timesheets WHERE id = ?', idParam(c)); return c.body(null, 204); });

/** Who was booked on a day but has not logged hours yet — the bot's to-do list. */
timesheets.get('/missing', c => {
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10);
  return c.json(all(
    `SELECT r.id AS resource_id, r.name, r.email, r.is_freelancer,
            GROUP_CONCAT(DISTINCT j.job_number || ' ' || j.title) AS jobs,
            COALESCE((SELECT SUM(hours) FROM timesheets t WHERE t.resource_id = r.id AND t.work_date = ?), 0) AS logged_hours
       FROM bookings b JOIN resources r ON r.id = b.resource_id LEFT JOIN jobs j ON j.id = b.job_id
      WHERE r.type = 'person' AND r.active = 1 AND b.status = 'confirmed'
        AND substr(b.starts_at,1,10) <= ? AND substr(b.ends_at,1,10) >= ?
      GROUP BY r.id HAVING logged_hours = 0 ORDER BY r.name`, date, date, date));
});
