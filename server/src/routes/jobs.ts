import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, run, transaction, updateRow, setting, setSetting, logActivity } from '../db.ts';
import { body, idParam, HttpError, isoDate, nullableStr } from '../http.ts';

export const jobs = new Hono();

export const JOB_STATUSES = ['enquiry', 'quoted', 'confirmed', 'in_progress', 'delivered', 'invoiced', 'closed', 'cancelled'] as const;

const jobSelect = `
  SELECT j.*, c.name AS client_name, c.currency AS client_currency, d.name AS department_name, d.colour AS department_colour,
         (SELECT COUNT(*) FROM bookings b WHERE b.job_id = j.id AND b.status <> 'cancelled') AS booking_count,
         (SELECT COALESCE(SUM(il.quantity * il.unit_price), 0) FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id
            WHERE i.job_id = j.id AND i.status <> 'void' AND il.kind = 'line') AS invoiced_net,
         (SELECT COALESCE(SUM(ql.quantity * ql.unit_price), 0) FROM quotes q JOIN quote_lines ql ON ql.quote_id = q.id
            WHERE q.job_id = j.id AND q.status = 'approved' AND ql.kind = 'line') AS approved_quote_net
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    LEFT JOIN departments d ON d.id = j.department_id`;

jobs.get('/', c => {
  const status = c.req.query('status');
  const q = c.req.query('q');
  const clientId = c.req.query('client_id');
  const rows = all(
    `${jobSelect}
      WHERE (? IS NULL OR j.status = ?)
        AND (? IS NULL OR j.client_id = ?)
        AND (? IS NULL OR j.title LIKE '%' || ? || '%' OR CAST(j.job_number AS TEXT) LIKE ? || '%' OR c.name LIKE '%' || ? || '%')
      ORDER BY j.job_number DESC`,
    status ?? null, status ?? null, clientId ?? null, clientId ?? null, q ?? null, q ?? null, q ?? null, q ?? null);
  return c.json(rows);
});

jobs.get('/next-number', c => c.json({ next_job_number: Number(setting('next_job_number') ?? 1000) }));

jobs.get('/:id', c => {
  const id = idParam(c);
  const job = get(`${jobSelect} WHERE j.id = ?`, id);
  if (!job) throw new HttpError(404, 'Job not found');
  const bookings = all(
    `SELECT b.*, r.name AS resource_name, r.type AS resource_type, r.is_freelancer, r.cost_day_rate
       FROM bookings b JOIN resources r ON r.id = b.resource_id
      WHERE b.job_id = ? ORDER BY b.starts_at, r.name`, id);
  const quotes = all(
    `SELECT q.*, (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM quote_lines WHERE quote_id = q.id AND kind = 'line') AS net
       FROM quotes q WHERE q.job_id = ? ORDER BY q.version DESC, q.id DESC`, id);
  const invoices = all(
    `SELECT i.*, (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM invoice_lines WHERE invoice_id = i.id AND kind = 'line') AS net
       FROM invoices i WHERE i.job_id = ? ORDER BY i.issue_date, i.id`, id);
  const activity = all('SELECT * FROM activity WHERE entity = ? AND entity_id = ? ORDER BY at DESC LIMIT 50', 'job', id);
  // Estimated freelancer cost from confirmed bookings (day-rate × booked days).
  const cost = get<{ cost: number }>(
    `SELECT COALESCE(SUM(r.cost_day_rate * MAX(1, ROUND((julianday(b.ends_at) - julianday(b.starts_at))))), 0) AS cost
       FROM bookings b JOIN resources r ON r.id = b.resource_id
      WHERE b.job_id = ? AND b.status = 'confirmed' AND r.cost_day_rate IS NOT NULL`, id);
  return c.json({ ...job, bookings, quotes, invoices, activity, estimated_cost: cost?.cost ?? 0 });
});

const jobSchema = z.object({
  job_number: z.number().int().positive().optional(),
  title: z.string().min(1),
  client_id: z.number().int().nullable().optional(),
  department_id: z.number().int().nullable().optional(),
  status: z.enum(JOB_STATUSES).optional(),
  kind: nullableStr,
  currency: z.string().length(3).optional(),
  po_number: nullableStr,
  producer: nullableStr,
  start_date: isoDate.nullable().optional(),
  end_date: isoDate.nullable().optional(),
  notes: nullableStr,
});

jobs.post('/', async c => {
  const d = await body(c, jobSchema);
  const created = transaction(() => {
    let jn = d.job_number;
    const next = Number(setting('next_job_number') ?? 1000);
    if (!jn) jn = next;
    if (get('SELECT 1 FROM jobs WHERE job_number = ?', jn)) throw new HttpError(409, `Job number ${jn} already in use`);
    if (jn >= next) setSetting('next_job_number', String(jn + 1));
    const currency = d.currency ?? (d.client_id ? get<{ currency: string }>('SELECT currency FROM clients WHERE id = ?', d.client_id)?.currency : undefined) ?? 'ZAR';
    const r = run(
      `INSERT INTO jobs(job_number, title, client_id, department_id, status, kind, currency, po_number, producer, start_date, end_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      jn, d.title, d.client_id ?? null, d.department_id ?? null, d.status ?? 'enquiry', d.kind ?? null, currency,
      d.po_number ?? null, d.producer ?? null, d.start_date ?? null, d.end_date ?? null, d.notes ?? null);
    logActivity('job', Number(r.lastInsertRowid), 'create', { job_number: jn, title: d.title });
    return get(`${jobSelect} WHERE j.id = ?`, r.lastInsertRowid);
  });
  return c.json(created, 201);
});

jobs.patch('/:id', async c => {
  const id = idParam(c);
  const d = await body(c, jobSchema.partial());
  const before = get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', id);
  if (!before) throw new HttpError(404, 'Job not found');
  if (d.job_number !== undefined) {
    const clash = get('SELECT 1 FROM jobs WHERE job_number = ? AND id <> ?', d.job_number, id);
    if (clash) throw new HttpError(409, `Job number ${d.job_number} already in use`);
  }
  updateRow('jobs', id, d, ['job_number', 'title', 'client_id', 'department_id', 'status', 'kind', 'currency', 'po_number', 'producer', 'start_date', 'end_date', 'notes']);
  if (d.status && d.status !== before.status) logActivity('job', id, 'status', { from: before.status, to: d.status });
  return c.json(get(`${jobSelect} WHERE j.id = ?`, id));
});

jobs.delete('/:id', c => {
  const id = idParam(c);
  const inv = get('SELECT 1 FROM invoices WHERE job_id = ? AND status IN (\'pushed\', \'paid\')', id);
  if (inv) throw new HttpError(409, 'Job has invoices in Xero; cancel it instead of deleting');
  run('DELETE FROM jobs WHERE id = ?', id);
  return c.body(null, 204);
});
