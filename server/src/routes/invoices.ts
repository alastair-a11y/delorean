import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, run, transaction, updateRow, logActivity, setting } from '../db.ts';
import { body, idParam, HttpError, isoDate, nullableStr } from '../http.ts';
import { lineSchema, type LineInput } from './quotes.ts';
import { buildXeroInvoicePayload, pushInvoice, refreshInvoiceStatus } from '../xero.ts';

export const invoices = new Hono();

export function loadInvoice(id: number) {
  const inv = get(
    `SELECT i.*, j.job_number, j.title AS job_title, j.client_id, c.name AS client_name, c.xero_contact_id, c.email AS client_email
       FROM invoices i JOIN jobs j ON j.id = i.job_id LEFT JOIN clients c ON c.id = j.client_id WHERE i.id = ?`, id);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const lines = all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order, id', id);
  const net = lines.filter(l => l.kind === 'line').reduce((s, l) => s + Number(l.quantity ?? 0) * Number(l.unit_price ?? 0), 0);
  const tax = Math.round(net * Number((inv as any).tax_rate)) / 100;
  return { ...inv, lines, net, tax, total: net + tax };
}

/** "Title | Service | JN: 1400 | 1st 50% | PO# x" — the reference format already used on Refinery invoices. */
export function buildReference(parts: { title: string; service?: string | null; job_number: number; milestone?: string | null; po?: string | null }) {
  return [parts.title, parts.service, `JN: ${parts.job_number}`, parts.milestone, parts.po ? `PO# ${parts.po.replace(/^PO#?\s*/i, '')}` : null]
    .filter(Boolean).join(' | ');
}

function nextInvoiceNumber(jobNumber: number) {
  const n = get<{ n: number }>('SELECT COUNT(*) + 1 AS n FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE j.job_number = ?', jobNumber)!.n;
  return `DL-${jobNumber}-${String(n).padStart(2, '0')}`;
}

function addDays(iso: string, days: number) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function insertInvoiceLines(invoiceId: number, lines: LineInput[], fraction = 1) {
  run('DELETE FROM invoice_lines WHERE invoice_id = ?', invoiceId);
  lines.forEach((l, i) => {
    const kind = l.kind ?? 'line';
    const qty = kind === 'line' ? Math.round((l.quantity ?? 1) * fraction * 1000) / 1000 : null;
    run('INSERT INTO invoice_lines(invoice_id, sort_order, kind, description, quantity, unit_price, xero_account_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
      invoiceId, i, kind, l.description ?? '', qty, kind === 'line' ? (l.unit_price ?? 0) : null, l.xero_account_code ?? null);
  });
}

const createSchema = z.object({
  job_id: z.number().int(),
  quote_id: z.number().int().nullable().optional(),
  milestone_label: nullableStr,          // "1st 50%"
  milestone_fraction: z.number().min(0).max(1).nullable().optional(),
  issue_date: isoDate.optional(),
  due_date: isoDate.optional(),
  po_number: nullableStr,
  service: nullableStr,                  // middle part of the reference, defaults to the quote title
  notes: nullableStr,
  lines: z.array(lineSchema).optional(), // if omitted and quote_id given, lines come from the quote × fraction
});

invoices.get('/', c => {
  const status = c.req.query('status');
  return c.json(all(
    `SELECT i.*, j.job_number, j.title AS job_title, c.name AS client_name,
            (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM invoice_lines WHERE invoice_id = i.id AND kind = 'line') AS net
       FROM invoices i JOIN jobs j ON j.id = i.job_id LEFT JOIN clients c ON c.id = j.client_id
      WHERE (? IS NULL OR i.status = ?) ORDER BY i.issue_date DESC, i.id DESC`, status ?? null, status ?? null));
});
invoices.get('/:id', c => c.json(loadInvoice(idParam(c))));

invoices.post('/', async c => {
  const d = await body(c, createSchema);
  const id = transaction(() => {
    const job = get<{ job_number: number; title: string; currency: string; po_number: string | null; client_id: number | null }>('SELECT * FROM jobs WHERE id = ?', d.job_id);
    if (!job) throw new HttpError(404, 'Job not found');
    let lines = d.lines;
    let service = d.service ?? null;
    let taxRate = Number(setting('tax_rate') ?? 15);
    let currency = job.currency;
    if (d.quote_id) {
      const q = get<{ title: string | null; tax_rate: number; currency: string; job_id: number }>('SELECT * FROM quotes WHERE id = ?', d.quote_id);
      if (!q || q.job_id !== d.job_id) throw new HttpError(400, 'Quote does not belong to this job');
      service ??= q.title;
      taxRate = q.tax_rate;
      currency = q.currency;
      lines ??= all<LineInput>('SELECT kind, description, quantity, unit, unit_price, xero_account_code FROM quote_lines WHERE quote_id = ? ORDER BY sort_order, id', d.quote_id);
    }
    if (!lines || lines.length === 0) throw new HttpError(400, 'Invoice needs lines or a quote_id');
    const fraction = d.milestone_fraction ?? 1;
    const issue = d.issue_date ?? new Date().toISOString().slice(0, 10);
    const terms = job.client_id ? get<{ payment_terms: number }>('SELECT payment_terms FROM clients WHERE id = ?', job.client_id)?.payment_terms ?? 30 : 30;
    const po = d.po_number ?? job.po_number;
    const reference = buildReference({ title: job.title, service, job_number: job.job_number, milestone: d.milestone_label, po });
    const r = run(
      `INSERT INTO invoices(job_id, quote_id, number, milestone_label, milestone_fraction, status, currency, tax_rate, issue_date, due_date, reference, po_number, notes)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      d.job_id, d.quote_id ?? null, nextInvoiceNumber(job.job_number), d.milestone_label ?? null, fraction, currency, taxRate,
      issue, d.due_date ?? addDays(issue, terms), reference, po ?? null, d.notes ?? null);
    const invId = Number(r.lastInsertRowid);
    // Quote lines are scaled by the milestone fraction; explicit lines are taken as-is.
    insertInvoiceLines(invId, lines, d.lines ? 1 : fraction);
    logActivity('job', d.job_id, 'invoice.create', { invoice_id: invId, milestone: d.milestone_label });
    return invId;
  });
  return c.json(loadInvoice(id), 201);
});

const patchSchema = z.object({
  milestone_label: nullableStr,
  issue_date: isoDate.optional(),
  due_date: isoDate.optional(),
  reference: nullableStr,
  po_number: nullableStr,
  notes: nullableStr,
  status: z.enum(['draft', 'approved', 'void']).optional(),
  lines: z.array(lineSchema).optional(),
});
invoices.patch('/:id', async c => {
  const id = idParam(c);
  const d = await body(c, patchSchema);
  const inv = get<{ status: string }>('SELECT status FROM invoices WHERE id = ?', id);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if ((inv.status === 'pushed' || inv.status === 'paid') && (d.lines || d.status === 'draft')) {
    throw new HttpError(409, 'Invoice is already in Xero; change it there or void it');
  }
  transaction(() => {
    updateRow('invoices', id, d, ['milestone_label', 'issue_date', 'due_date', 'reference', 'po_number', 'notes', 'status']);
    if (d.lines) insertInvoiceLines(id, d.lines);
  });
  return c.json(loadInvoice(id));
});

/** Show exactly what would be sent to Xero without sending it. */
invoices.get('/:id/xero-preview', c => c.json(buildXeroInvoicePayload(loadInvoice(idParam(c)) as any)));

invoices.post('/:id/push', async c => {
  const id = idParam(c);
  const inv = loadInvoice(id) as any;
  if (inv.status === 'pushed' || inv.status === 'paid') throw new HttpError(409, 'Already pushed');
  if (inv.status === 'void') throw new HttpError(409, 'Invoice is void');
  const result = await pushInvoice(inv);
  return c.json(loadInvoice(id));
});

invoices.post('/:id/refresh', async c => {
  const id = idParam(c);
  await refreshInvoiceStatus(loadInvoice(id) as any);
  return c.json(loadInvoice(id));
});

invoices.delete('/:id', c => {
  const id = idParam(c);
  const inv = get<{ status: string }>('SELECT status FROM invoices WHERE id = ?', id);
  if (inv && inv.status !== 'draft') throw new HttpError(409, 'Only draft invoices can be deleted');
  run('DELETE FROM invoices WHERE id = ?', id);
  return c.body(null, 204);
});
