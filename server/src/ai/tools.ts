/**
 * Claude tools for the DeLorean assistant. Each one is a thin wrapper over the
 * HTTP API (called in-process), so validation, conflict checks and activity
 * logging are identical whether a human or the model does it.
 */
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { internal } from '../app.ts';
import { all, get } from '../db.ts';
import { HttpError } from '../http.ts';
import { sendToPerson } from '../bots/channels.ts';

const ok = (v: unknown) => JSON.stringify(v ?? { ok: true });
const safe = <T extends unknown[]>(fn: (...a: T) => Promise<unknown> | unknown) => async (...a: T) => {
  try { return ok(await fn(...a)); }
  catch (e) { return JSON.stringify({ error: (e as Error).message, detail: (e as HttpError).detail ?? null }); }
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD');
const dateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe('YYYY-MM-DDTHH:MM local time');

export const lookupTools = [
  betaZodTool({
    name: 'search_jobs',
    description: 'Find jobs by free text (title, client, job number) and/or status. Returns id, job_number, title, client, status, dates.',
    inputSchema: z.object({ q: z.string().optional(), status: z.enum(['enquiry', 'quoted', 'confirmed', 'in_progress', 'delivered', 'invoiced', 'closed', 'cancelled']).optional() }),
    run: safe(async ({ q, status }) => {
      const p = new URLSearchParams(); if (q) p.set('q', q); if (status) p.set('status', status);
      const rows = await internal('GET', `/api/jobs?${p}`);
      return rows.slice(0, 40).map((j: any) => ({ id: j.id, job_number: j.job_number, title: j.title, client: j.client_name, status: j.status, department: j.department_name, start: j.start_date, end: j.end_date, currency: j.currency, po: j.po_number }));
    }),
  }),
  betaZodTool({
    name: 'get_job',
    description: 'Full detail of one job: bookings, quotes (with totals), invoices, estimated freelancer cost. Accepts a job id or a job number.',
    inputSchema: z.object({ job_id: z.number().int().optional(), job_number: z.number().int().optional() }),
    run: safe(async ({ job_id, job_number }) => {
      const id = job_id ?? get<{ id: number }>('SELECT id FROM jobs WHERE job_number = ?', job_number)?.id;
      if (!id) throw new HttpError(404, 'Job not found');
      const j = await internal('GET', `/api/jobs/${id}`);
      return { ...j, activity: undefined, bookings: j.bookings.map((b: any) => ({ id: b.id, resource: b.resource_name, resource_id: b.resource_id, starts_at: b.starts_at, ends_at: b.ends_at, status: b.status, title: b.title })) };
    }),
  }),
  betaZodTool({
    name: 'list_bookings',
    description: 'Bookings in a date window (to is exclusive), optionally for one job or resource. Use this to see what is on the schedule.',
    inputSchema: z.object({ from: date, to: date, job_id: z.number().int().optional(), resource_id: z.number().int().optional() }),
    run: safe(async (i) => {
      const p = new URLSearchParams({ from: i.from, to: i.to }); if (i.job_id) p.set('job_id', String(i.job_id)); if (i.resource_id) p.set('resource_id', String(i.resource_id));
      const rows = await internal('GET', `/api/bookings?${p}`);
      return rows.map((b: any) => ({ id: b.id, resource: b.resource_name, resource_id: b.resource_id, job_number: b.job_number, job: b.job_title, starts_at: b.starts_at, ends_at: b.ends_at, status: b.status, title: b.title }));
    }),
  }),
  betaZodTool({
    name: 'check_availability',
    description: 'For each resource, list the days in the window that already have a confirmed or pencil booking. Resources not listed are free. Pass resource_ids, or a type/role to check a whole pool (e.g. all edit suites).',
    inputSchema: z.object({ from: date, to: date, resource_ids: z.array(z.number().int()).optional(), type: z.enum(['person', 'room', 'kit']).optional(), role_contains: z.string().optional() }),
    run: safe(async (i) => {
      let ids = i.resource_ids;
      if (!ids) {
        ids = all<{ id: number }>('SELECT id FROM resources WHERE active = 1 AND (? IS NULL OR type = ?) AND (? IS NULL OR role LIKE \'%\' || ? || \'%\' OR name LIKE \'%\' || ? || \'%\')',
          i.type ?? null, i.type ?? null, i.role_contains ?? null, i.role_contains ?? null, i.role_contains ?? null).map(r => r.id);
      }
      return ids.map(id => {
        const r = get<{ name: string }>('SELECT name FROM resources WHERE id = ?', id);
        const busy = all<{ day: string; status: string; job_number: number | null }>(
          `SELECT DISTINCT substr(b.starts_at,1,10) AS day, b.status, j.job_number FROM bookings b LEFT JOIN jobs j ON j.id = b.job_id
            WHERE b.resource_id = ? AND b.status <> 'cancelled' AND b.starts_at < ? AND b.ends_at > ? ORDER BY day`, id, `${i.to}T00:00`, `${i.from}T00:00`);
        return { resource_id: id, name: r?.name, busy };
      });
    }),
  }),
  betaZodTool({
    name: 'search_clients',
    description: 'Find clients by name.',
    inputSchema: z.object({ q: z.string() }),
    run: safe(async ({ q }) => (await internal('GET', `/api/clients?q=${encodeURIComponent(q)}`)).map((c: any) => ({ id: c.id, name: c.name, currency: c.currency, email: c.email }))),
  }),
  betaZodTool({
    name: 'get_quote',
    description: 'A quote with its lines and totals.',
    inputSchema: z.object({ quote_id: z.number().int() }),
    run: safe(async ({ quote_id }) => internal('GET', `/api/quotes/${quote_id}`)),
  }),
  betaZodTool({
    name: 'get_invoice',
    description: 'An invoice with its lines, totals and Xero status.',
    inputSchema: z.object({ invoice_id: z.number().int() }),
    run: safe(async ({ invoice_id }) => internal('GET', `/api/invoices/${invoice_id}`)),
  }),
  betaZodTool({
    name: 'missing_hours',
    description: 'People who were booked on a day but have not logged hours.',
    inputSchema: z.object({ date }),
    run: safe(async ({ date }) => internal('GET', `/api/timesheets/missing?date=${date}`)),
  }),
];

const lineInput = z.object({
  kind: z.enum(['heading', 'line', 'separator']).default('line'),
  description: z.string().optional().describe('Required for headings and lines unless rate_card_item_id is given'),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  unit_price: z.number().optional().describe('Omit to use the rate card price'),
  xero_account_code: z.string().optional(),
  rate_card_item_id: z.number().int().optional(),
});

export const writeTools = [
  betaZodTool({
    name: 'create_client',
    description: 'Create a client (production company, agency). Check search_clients first.',
    inputSchema: z.object({ name: z.string(), contact_name: z.string().optional(), email: z.string().optional(), currency: z.string().length(3).optional(), vat_number: z.string().optional() }),
    run: safe(async (i) => internal('POST', '/api/clients', i)),
  }),
  betaZodTool({
    name: 'create_job',
    description: 'Create a job. Job number is assigned automatically unless given. Returns the job with its JN.',
    inputSchema: z.object({
      title: z.string(), client_id: z.number().int().optional(), department: z.string().optional().describe('Department name, e.g. "Colour / Online"'),
      kind: z.string().optional().describe('Feature, Series, TVC, Music Video, Dailies, Dry Hire...'), currency: z.string().length(3).optional(),
      po_number: z.string().optional(), producer: z.string().optional(), start_date: date.optional(), end_date: date.optional(), notes: z.string().optional(),
      status: z.enum(['enquiry', 'quoted', 'confirmed', 'in_progress']).optional(), job_number: z.number().int().optional(),
    }),
    run: safe(async ({ department, ...i }) => {
      const dept = department ? get<{ id: number }>('SELECT id FROM departments WHERE name LIKE ?', `%${department.split('/')[0].trim()}%`) : undefined;
      return internal('POST', '/api/jobs', { ...i, department_id: dept?.id });
    }),
  }),
  betaZodTool({
    name: 'update_job',
    description: 'Change job fields or status.',
    inputSchema: z.object({
      job_id: z.number().int(), title: z.string().optional(), client_id: z.number().int().optional(), status: z.enum(['enquiry', 'quoted', 'confirmed', 'in_progress', 'delivered', 'invoiced', 'closed', 'cancelled']).optional(),
      po_number: z.string().optional(), producer: z.string().optional(), start_date: date.optional(), end_date: date.optional(), notes: z.string().optional(), currency: z.string().length(3).optional(),
    }),
    run: safe(async ({ job_id, ...patch }) => internal('PATCH', `/api/jobs/${job_id}`, patch)),
  }),
  betaZodTool({
    name: 'create_bookings',
    description: 'Create one or more bookings in a single transaction. Each booking is one resource for one time window (use one per day for multi-day work so hours tracking works). Confirmed bookings fail on a clash unless force=true; the error lists the clashes.',
    inputSchema: z.object({
      bookings: z.array(z.object({
        job_id: z.number().int(), resource_id: z.number().int(), starts_at: dateTime, ends_at: dateTime,
        status: z.enum(['pencil', 'confirmed']).default('pencil'), title: z.string().optional(), notes: z.string().optional(), force: z.boolean().optional(),
      })).min(1),
    }),
    run: safe(async ({ bookings }) => {
      const rows = await internal('POST', '/api/bookings', { bookings });
      return rows.map((b: any) => ({ id: b.id, resource: b.resource_name, starts_at: b.starts_at, ends_at: b.ends_at, status: b.status, soft_clashes: b.conflicts?.length ?? 0 }));
    }),
  }),
  betaZodTool({
    name: 'update_booking',
    description: 'Move, resize, retitle, confirm or cancel a booking.',
    inputSchema: z.object({ booking_id: z.number().int(), starts_at: dateTime.optional(), ends_at: dateTime.optional(), resource_id: z.number().int().optional(), status: z.enum(['pencil', 'confirmed', 'cancelled']).optional(), title: z.string().optional(), notes: z.string().optional(), force: z.boolean().optional() }),
    run: safe(async ({ booking_id, ...patch }) => internal('PATCH', `/api/bookings/${booking_id}`, patch)),
  }),
  betaZodTool({
    name: 'confirm_job_bookings',
    description: "Confirm every pencil booking on a job. Returns which were confirmed and which were blocked by clashes.",
    inputSchema: z.object({ job_id: z.number().int() }),
    run: safe(async ({ job_id }) => internal('POST', `/api/bookings/confirm-job/${job_id}`)),
  }),
  betaZodTool({
    name: 'create_quote',
    description: 'Create a quote on a job from lines. Use rate_card_item_id where possible; headings group sections. Returns the quote with totals.',
    inputSchema: z.object({ job_id: z.number().int(), title: z.string().optional().describe('Service description used on invoices, e.g. "Picture & Sound Post"'), lines: z.array(lineInput).min(1), valid_until: date.optional(), notes: z.string().optional() }),
    run: safe(async (i) => internal('POST', '/api/quotes', i)),
  }),
  betaZodTool({
    name: 'update_quote',
    description: 'Replace a quote\'s lines or change its status (sent/approved/declined). Approving confirms the job.',
    inputSchema: z.object({ quote_id: z.number().int(), title: z.string().optional(), lines: z.array(lineInput).optional(), status: z.enum(['draft', 'sent', 'approved', 'declined']).optional() }),
    run: safe(async ({ quote_id, ...patch }) => internal('PATCH', `/api/quotes/${quote_id}`, patch)),
  }),
  betaZodTool({
    name: 'create_invoice',
    description: 'Create a draft invoice. With quote_id + milestone_fraction the quote lines are scaled (0.5 = "1st 50%"). Or pass explicit lines. Not sent to Xero until push_invoice_to_xero.',
    inputSchema: z.object({ job_id: z.number().int(), quote_id: z.number().int().optional(), milestone_label: z.string().optional(), milestone_fraction: z.number().min(0).max(1).optional(), po_number: z.string().optional(), service: z.string().optional(), issue_date: date.optional(), due_date: date.optional(), lines: z.array(lineInput).optional() }),
    run: safe(async (i) => internal('POST', '/api/invoices', i)),
  }),
  betaZodTool({
    name: 'push_invoice_to_xero',
    description: 'Send a draft invoice to Xero as a DRAFT sales invoice with department and job-number tracking. Only after the user has said yes.',
    inputSchema: z.object({ invoice_id: z.number().int() }),
    run: safe(async ({ invoice_id }) => internal('POST', `/api/invoices/${invoice_id}/push`)),
  }),
  betaZodTool({
    name: 'log_hours',
    description: 'Record hours worked. job_id optional: if the person had exactly one booking that day it is attached automatically.',
    inputSchema: z.object({ entries: z.array(z.object({ resource_id: z.number().int(), work_date: date, hours: z.number().min(0).max(24), job_id: z.number().int().optional(), notes: z.string().optional() })).min(1) }),
    run: safe(async ({ entries }) => internal('POST', '/api/timesheets', { entries: entries.map(e => ({ ...e, source: 'assistant' })) })),
  }),
  betaZodTool({
    name: 'message_person',
    description: 'Send a short message to a person (crew, freelancer) via their preferred channel (Google Chat, email). Use for call times, schedule changes, hours reminders.',
    inputSchema: z.object({ resource_id: z.number().int(), text: z.string().max(2000) }),
    run: safe(async ({ resource_id, text }) => sendToPerson(resource_id, text)),
  }),
  betaZodTool({
    name: 'create_resource',
    description: 'Add a person, room or kit item. Freelancers should have cost_day_rate.',
    inputSchema: z.object({ name: z.string(), type: z.enum(['person', 'room', 'kit']), role: z.string().optional(), department: z.string().optional(), is_freelancer: z.boolean().optional(), cost_day_rate: z.number().optional(), charge_day_rate: z.number().optional(), email: z.string().optional() }),
    run: safe(async ({ department, is_freelancer, ...i }) => {
      const dept = department ? get<{ id: number }>('SELECT id FROM departments WHERE name LIKE ?', `%${department.split('/')[0].trim()}%`) : undefined;
      return internal('POST', '/api/resources', { ...i, department_id: dept?.id, is_freelancer: is_freelancer ? 1 : 0 });
    }),
  }),
];

export const allTools = [...lookupTools, ...writeTools];
