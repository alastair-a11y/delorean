import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, run, updateRow, logActivity } from '../db.ts';
import { body, idParam, HttpError, nullableStr } from '../http.ts';

export const reference = new Hono();

// ---- Departments -----------------------------------------------------------
reference.get('/departments', c => c.json(all('SELECT * FROM departments ORDER BY sort_order, name')));

const deptSchema = z.object({
  name: z.string().min(1),
  colour: z.string().optional(),
  xero_revenue_account: nullableStr,
  xero_tracking_option: nullableStr,
  sort_order: z.number().int().optional(),
  active: z.number().int().min(0).max(1).optional(),
});
reference.post('/departments', async c => {
  const d = await body(c, deptSchema);
  const r = run('INSERT INTO departments(name, colour, xero_revenue_account, xero_tracking_option, sort_order) VALUES (?, ?, ?, ?, ?)',
    d.name, d.colour ?? '#6b7280', d.xero_revenue_account ?? null, d.xero_tracking_option ?? d.name, d.sort_order ?? 99);
  return c.json(get('SELECT * FROM departments WHERE id = ?', r.lastInsertRowid), 201);
});
reference.patch('/departments/:id', async c => {
  const id = idParam(c);
  const d = await body(c, deptSchema.partial());
  updateRow('departments', id, d, ['name', 'colour', 'xero_revenue_account', 'xero_tracking_option', 'sort_order', 'active']);
  return c.json(get('SELECT * FROM departments WHERE id = ?', id));
});

// ---- Clients ---------------------------------------------------------------
reference.get('/clients', c => {
  const q = c.req.query('q');
  const includeInactive = c.req.query('all') === '1';
  const rows = all(
    `SELECT cl.*, (SELECT COUNT(*) FROM jobs j WHERE j.client_id = cl.id) AS job_count
       FROM clients cl
      WHERE (? = 1 OR cl.active = 1) AND (? IS NULL OR cl.name LIKE '%' || ? || '%')
      ORDER BY cl.name COLLATE NOCASE`,
    includeInactive ? 1 : 0, q ?? null, q ?? null);
  return c.json(rows);
});
reference.get('/clients/:id', c => {
  const id = idParam(c);
  const client = get('SELECT * FROM clients WHERE id = ?', id);
  if (!client) throw new HttpError(404, 'Client not found');
  const jobs = all('SELECT * FROM jobs WHERE client_id = ? ORDER BY job_number DESC', id);
  return c.json({ ...client, jobs });
});

const clientSchema = z.object({
  name: z.string().min(1),
  contact_name: nullableStr,
  email: nullableStr,
  phone: nullableStr,
  vat_number: nullableStr,
  currency: z.string().length(3).optional(),
  payment_terms: z.number().int().min(0).optional(),
  xero_contact_id: nullableStr,
  notes: nullableStr,
  active: z.number().int().min(0).max(1).optional(),
});
reference.post('/clients', async c => {
  const d = await body(c, clientSchema);
  const existing = get('SELECT id FROM clients WHERE name = ? COLLATE NOCASE', d.name);
  if (existing) throw new HttpError(409, `Client "${d.name}" already exists`);
  const r = run(
    'INSERT INTO clients(name, contact_name, email, phone, vat_number, currency, payment_terms, xero_contact_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    d.name, d.contact_name ?? null, d.email ?? null, d.phone ?? null, d.vat_number ?? null,
    d.currency ?? 'ZAR', d.payment_terms ?? 30, d.xero_contact_id ?? null, d.notes ?? null);
  logActivity('client', Number(r.lastInsertRowid), 'create', { name: d.name });
  return c.json(get('SELECT * FROM clients WHERE id = ?', r.lastInsertRowid), 201);
});
reference.patch('/clients/:id', async c => {
  const id = idParam(c);
  const d = await body(c, clientSchema.partial());
  updateRow('clients', id, d, ['name', 'contact_name', 'email', 'phone', 'vat_number', 'currency', 'payment_terms', 'xero_contact_id', 'notes', 'active']);
  return c.json(get('SELECT * FROM clients WHERE id = ?', id));
});

// ---- Resources (people, rooms, kit) ---------------------------------------
reference.get('/resources', c => {
  const type = c.req.query('type');
  const includeInactive = c.req.query('all') === '1';
  return c.json(all(
    `SELECT r.*, d.name AS department_name, d.colour AS department_colour
       FROM resources r LEFT JOIN departments d ON d.id = r.department_id
      WHERE (? = 1 OR r.active = 1) AND (? IS NULL OR r.type = ?)
      ORDER BY CASE r.type WHEN 'room' THEN 0 WHEN 'kit' THEN 1 ELSE 2 END, d.sort_order, r.sort_order, r.name`,
    includeInactive ? 1 : 0, type ?? null, type ?? null));
});
const resourceSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['person', 'room', 'kit']),
  department_id: z.number().int().nullable().optional(),
  role: nullableStr,
  is_freelancer: z.number().int().min(0).max(1).optional(),
  cost_day_rate: z.number().nullable().optional(),
  charge_day_rate: z.number().nullable().optional(),
  email: nullableStr,
  phone: nullableStr,
  notes: nullableStr,
  sort_order: z.number().int().optional(),
  active: z.number().int().min(0).max(1).optional(),
});
reference.post('/resources', async c => {
  const d = await body(c, resourceSchema);
  const r = run(
    'INSERT INTO resources(name, type, department_id, role, is_freelancer, cost_day_rate, charge_day_rate, email, phone, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    d.name, d.type, d.department_id ?? null, d.role ?? null, d.is_freelancer ?? 0, d.cost_day_rate ?? null,
    d.charge_day_rate ?? null, d.email ?? null, d.phone ?? null, d.notes ?? null, d.sort_order ?? 0);
  return c.json(get('SELECT * FROM resources WHERE id = ?', r.lastInsertRowid), 201);
});
reference.patch('/resources/:id', async c => {
  const id = idParam(c);
  const d = await body(c, resourceSchema.partial());
  updateRow('resources', id, d, ['name', 'type', 'department_id', 'role', 'is_freelancer', 'cost_day_rate', 'charge_day_rate', 'email', 'phone', 'notes', 'sort_order', 'active']);
  return c.json(get('SELECT * FROM resources WHERE id = ?', id));
});

// ---- Rate card -------------------------------------------------------------
reference.get('/rate-card', c => c.json(all(
  `SELECT r.*, d.name AS department_name FROM rate_card_items r LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.active = 1 ORDER BY d.sort_order, r.sort_order, r.description`)));
const rateSchema = z.object({
  code: nullableStr,
  description: z.string().min(1),
  unit: z.enum(['day', 'half_day', 'week', 'hour', 'gb', 'unit', 'flat']).optional(),
  unit_price: z.number().optional(),
  currency: z.string().length(3).optional(),
  department_id: z.number().int().nullable().optional(),
  xero_account_code: nullableStr,
  active: z.number().int().min(0).max(1).optional(),
  sort_order: z.number().int().optional(),
});
reference.post('/rate-card', async c => {
  const d = await body(c, rateSchema);
  const r = run(
    'INSERT INTO rate_card_items(code, description, unit, unit_price, currency, department_id, xero_account_code, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    d.code ?? null, d.description, d.unit ?? 'day', d.unit_price ?? 0, d.currency ?? 'ZAR', d.department_id ?? null, d.xero_account_code ?? null, d.sort_order ?? 0);
  return c.json(get('SELECT * FROM rate_card_items WHERE id = ?', r.lastInsertRowid), 201);
});
reference.patch('/rate-card/:id', async c => {
  const id = idParam(c);
  const d = await body(c, rateSchema.partial());
  updateRow('rate_card_items', id, d, ['code', 'description', 'unit', 'unit_price', 'currency', 'department_id', 'xero_account_code', 'active', 'sort_order']);
  return c.json(get('SELECT * FROM rate_card_items WHERE id = ?', id));
});
