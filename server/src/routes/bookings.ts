import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, run, transaction, updateRow, logActivity } from '../db.ts';
import { body, idParam, HttpError, isoDateTime, nullableStr } from '../http.ts';
import { syncBookingToCalendar, deleteBookingEvent } from '../google/calendar.ts';

/** Fire-and-forget calendar sync; the scheduler reconciles anything that fails. */
const calendarSync = (id: number) => { void syncBookingToCalendar(id).catch(e => console.error('calendar sync', id, (e as Error).message)); };

export const bookings = new Hono();

const bookingSelect = `
  SELECT b.*, r.name AS resource_name, r.type AS resource_type, r.department_id AS resource_department_id,
         j.job_number, j.title AS job_title, j.status AS job_status, j.currency AS job_currency,
         c.name AS client_name, d.colour AS colour
    FROM bookings b
    JOIN resources r ON r.id = b.resource_id
    LEFT JOIN jobs j ON j.id = b.job_id
    LEFT JOIN clients c ON c.id = j.client_id
    LEFT JOIN departments d ON d.id = j.department_id`;

export interface Conflict {
  booking_id: number;
  job_number: number | null;
  job_title: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
}

/** Overlapping, non-cancelled bookings on the same resource. */
export function findConflicts(resourceId: number, startsAt: string, endsAt: string, excludeId?: number): Conflict[] {
  return all<Conflict>(
    `SELECT b.id AS booking_id, j.job_number, j.title AS job_title, b.starts_at, b.ends_at, b.status
       FROM bookings b LEFT JOIN jobs j ON j.id = b.job_id
      WHERE b.resource_id = ? AND b.status <> 'cancelled'
        AND b.starts_at < ? AND b.ends_at > ?
        AND (? IS NULL OR b.id <> ?)
      ORDER BY b.starts_at`,
    resourceId, endsAt, startsAt, excludeId ?? null, excludeId ?? null);
}

/** Range query for the schedule grid: ?from=YYYY-MM-DD&to=YYYY-MM-DD (to is exclusive). */
bookings.get('/', c => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  const jobId = c.req.query('job_id');
  const resourceId = c.req.query('resource_id');
  const rows = all(
    `${bookingSelect}
      WHERE b.status <> 'cancelled'
        AND (? IS NULL OR b.ends_at > ?) AND (? IS NULL OR b.starts_at < ?)
        AND (? IS NULL OR b.job_id = ?) AND (? IS NULL OR b.resource_id = ?)
      ORDER BY b.starts_at`,
    from ?? null, from ? `${from}T00:00` : null, to ?? null, to ? `${to}T00:00` : null,
    jobId ?? null, jobId ?? null, resourceId ?? null, resourceId ?? null);
  return c.json(rows);
});

bookings.get('/conflicts', c => {
  const resourceId = Number(c.req.query('resource_id'));
  const startsAt = c.req.query('starts_at');
  const endsAt = c.req.query('ends_at');
  if (!resourceId || !startsAt || !endsAt) throw new HttpError(400, 'resource_id, starts_at and ends_at are required');
  const exclude = c.req.query('exclude_id');
  return c.json(findConflicts(resourceId, startsAt, endsAt, exclude ? Number(exclude) : undefined));
});

const bookingSchema = z.object({
  job_id: z.number().int().nullable().optional(),
  resource_id: z.number().int(),
  starts_at: isoDateTime,
  ends_at: isoDateTime,
  status: z.enum(['pencil', 'confirmed', 'cancelled']).optional(),
  title: nullableStr,
  notes: nullableStr,
  /** Confirmed bookings refuse to double-book unless force=true (pencils always overlap freely). */
  force: z.boolean().optional(),
});

function guardConflicts(d: { resource_id: number; starts_at: string; ends_at: string; status?: string; force?: boolean }, excludeId?: number) {
  if (d.ends_at <= d.starts_at) throw new HttpError(400, 'ends_at must be after starts_at');
  const conflicts = findConflicts(d.resource_id, d.starts_at, d.ends_at, excludeId);
  const hard = conflicts.filter(x => x.status === 'confirmed');
  if ((d.status ?? 'pencil') === 'confirmed' && hard.length > 0 && !d.force) {
    throw new HttpError(409, 'Resource is already confirmed on another booking in this window', { conflicts: hard });
  }
  return conflicts;
}

/** Create one booking. Body may instead be {bookings: [...]} for a batch (one transaction). */
bookings.post('/', async c => {
  const raw = await c.req.json().catch(() => { throw new HttpError(400, 'Request body must be JSON'); });
  const batch = Array.isArray(raw?.bookings) ? raw.bookings : [raw];
  const parsed = z.array(bookingSchema).min(1).safeParse(batch);
  if (!parsed.success) throw new HttpError(400, 'Validation failed', parsed.error.flatten());
  const created = transaction(() => parsed.data.map(d => {
    const conflicts = guardConflicts(d);
    const r = run(
      'INSERT INTO bookings(job_id, resource_id, starts_at, ends_at, status, title, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      d.job_id ?? null, d.resource_id, d.starts_at, d.ends_at, d.status ?? 'pencil', d.title ?? null, d.notes ?? null);
    if (d.job_id) logActivity('job', d.job_id, 'booking.create', { resource_id: d.resource_id, starts_at: d.starts_at, ends_at: d.ends_at });
    const row = get(`${bookingSelect} WHERE b.id = ?`, r.lastInsertRowid)!;
    return { ...row, conflicts };
  }));
  created.forEach(b => calendarSync(Number((b as any).id)));
  return c.json(Array.isArray(raw?.bookings) ? created : created[0], 201);
});

bookings.patch('/:id', async c => {
  const id = idParam(c);
  const existing = get<{ resource_id: number; starts_at: string; ends_at: string; status: string; job_id: number | null }>('SELECT * FROM bookings WHERE id = ?', id);
  if (!existing) throw new HttpError(404, 'Booking not found');
  const d = await body(c, bookingSchema.partial());
  const merged = { ...existing, ...d };
  const conflicts = merged.status === 'cancelled' ? [] : guardConflicts(merged, id);
  updateRow('bookings', id, d, ['job_id', 'resource_id', 'starts_at', 'ends_at', 'status', 'title', 'notes']);
  if (d.status && d.status !== existing.status && existing.job_id) logActivity('job', existing.job_id, `booking.${d.status}`, { booking_id: id });
  calendarSync(id);
  return c.json({ ...get(`${bookingSelect} WHERE b.id = ?`, id), conflicts });
});

bookings.delete('/:id', async c => {
  const id = idParam(c);
  await deleteBookingEvent(id).catch(() => undefined);
  run('DELETE FROM bookings WHERE id = ?', id);
  return c.body(null, 204);
});

/** Confirm every pencil on a job in one go (the "job is now confirmed" moment). */
bookings.post('/confirm-job/:jobId', c => {
  const jobId = idParam(c, 'jobId');
  const pencils = all<{ id: number; resource_id: number; starts_at: string; ends_at: string }>(
    "SELECT id, resource_id, starts_at, ends_at FROM bookings WHERE job_id = ? AND status = 'pencil'", jobId);
  const blocked: { booking_id: number; conflicts: Conflict[] }[] = [];
  const confirmed: number[] = [];
  transaction(() => {
    for (const p of pencils) {
      const hard = findConflicts(p.resource_id, p.starts_at, p.ends_at, p.id).filter(x => x.status === 'confirmed');
      if (hard.length) { blocked.push({ booking_id: p.id, conflicts: hard }); continue; }
      run("UPDATE bookings SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?", p.id);
      confirmed.push(p.id);
    }
    if (confirmed.length) logActivity('job', jobId, 'bookings.confirm', { confirmed, blocked: blocked.length });
  });
  confirmed.forEach(calendarSync);
  return c.json({ confirmed, blocked });
});
