import { Hono } from 'hono';
import { z } from 'zod';
import { all, get, run, transaction, updateRow, logActivity, setting } from '../db.ts';
import { body, idParam, HttpError, isoDate, nullableStr } from '../http.ts';

export const quotes = new Hono();

export const lineSchema = z.object({
  kind: z.enum(['heading', 'line', 'separator']).optional(),
  description: z.string().optional(),
  quantity: z.number().nullable().optional(),
  unit: nullableStr,
  unit_price: z.number().nullable().optional(),
  xero_account_code: nullableStr,
  rate_card_item_id: z.number().int().nullable().optional(),
});
export type LineInput = z.infer<typeof lineSchema>;

const quoteSchema = z.object({
  job_id: z.number().int(),
  title: nullableStr,
  currency: z.string().length(3).optional(),
  tax_rate: z.number().optional(),
  valid_until: isoDate.nullable().optional(),
  notes: nullableStr,
  status: z.enum(['draft', 'sent', 'approved', 'declined', 'superseded']).optional(),
  lines: z.array(lineSchema).optional(),
});

export function quoteTotals(quoteId: number) {
  const net = get<{ net: number }>(
    "SELECT COALESCE(SUM(quantity * unit_price), 0) AS net FROM quote_lines WHERE quote_id = ? AND kind = 'line'", quoteId)!.net;
  const q = get<{ tax_rate: number }>('SELECT tax_rate FROM quotes WHERE id = ?', quoteId)!;
  const tax = Math.round(net * q.tax_rate) / 100;
  return { net, tax, total: net + tax };
}

export function loadQuote(id: number) {
  const q = get('SELECT q.*, j.job_number, j.title AS job_title, j.client_id, c.name AS client_name FROM quotes q JOIN jobs j ON j.id = q.job_id LEFT JOIN clients c ON c.id = j.client_id WHERE q.id = ?', id);
  if (!q) throw new HttpError(404, 'Quote not found');
  const lines = all('SELECT * FROM quote_lines WHERE quote_id = ? ORDER BY sort_order, id', id);
  return { ...q, lines, ...quoteTotals(id) };
}

/** Insert lines, filling price/account/unit from the rate card when a rate_card_item_id is given. */
export function insertQuoteLines(quoteId: number, lines: LineInput[]) {
  run('DELETE FROM quote_lines WHERE quote_id = ?', quoteId);
  const ins = (i: number, l: LineInput) => {
    let { description, unit, unit_price, xero_account_code } = l;
    if (l.rate_card_item_id) {
      const rc = get<{ description: string; unit: string; unit_price: number; xero_account_code: string | null }>(
        'SELECT description, unit, unit_price, xero_account_code FROM rate_card_items WHERE id = ?', l.rate_card_item_id);
      if (!rc) throw new HttpError(400, `Rate card item ${l.rate_card_item_id} not found`);
      description ??= rc.description;
      unit ??= rc.unit;
      unit_price ??= rc.unit_price;
      xero_account_code ??= rc.xero_account_code;
    }
    const kind = l.kind ?? 'line';
    run('INSERT INTO quote_lines(quote_id, sort_order, kind, description, quantity, unit, unit_price, xero_account_code, rate_card_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      quoteId, i, kind, description ?? '', kind === 'line' ? (l.quantity ?? 1) : null, unit ?? null,
      kind === 'line' ? (unit_price ?? 0) : null, xero_account_code ?? null, l.rate_card_item_id ?? null);
  };
  lines.forEach((l, i) => ins(i, l));
}

function nextQuoteNumber(jobId: number) {
  const job = get<{ job_number: number }>('SELECT job_number FROM jobs WHERE id = ?', jobId);
  if (!job) throw new HttpError(404, 'Job not found');
  const n = get<{ n: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM quotes WHERE job_id = ?', jobId)!.n;
  return { number: `Q-${job.job_number}-${n}`, version: n };
}

quotes.get('/', c => {
  const status = c.req.query('status');
  return c.json(all(
    `SELECT q.*, j.job_number, j.title AS job_title, c.name AS client_name,
            (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM quote_lines WHERE quote_id = q.id AND kind = 'line') AS net
       FROM quotes q JOIN jobs j ON j.id = q.job_id LEFT JOIN clients c ON c.id = j.client_id
      WHERE (? IS NULL OR q.status = ?) ORDER BY q.id DESC`, status ?? null, status ?? null));
});
quotes.get('/:id', c => c.json(loadQuote(idParam(c))));

quotes.post('/', async c => {
  const d = await body(c, quoteSchema);
  const id = transaction(() => {
    const { number, version } = nextQuoteNumber(d.job_id);
    const job = get<{ currency: string }>('SELECT currency FROM jobs WHERE id = ?', d.job_id)!;
    const r = run('INSERT INTO quotes(job_id, number, version, status, title, currency, tax_rate, valid_until, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      d.job_id, number, version, d.status ?? 'draft', d.title ?? null, d.currency ?? job.currency, d.tax_rate ?? Number(setting('tax_rate') ?? 15), d.valid_until ?? null, d.notes ?? null);
    const qid = Number(r.lastInsertRowid);
    insertQuoteLines(qid, d.lines ?? []);
    run("UPDATE jobs SET status = 'quoted', updated_at = datetime('now') WHERE id = ? AND status = 'enquiry'", d.job_id);
    logActivity('job', d.job_id, 'quote.create', { number });
    return qid;
  });
  return c.json(loadQuote(id), 201);
});

quotes.patch('/:id', async c => {
  const id = idParam(c);
  const d = await body(c, quoteSchema.partial().omit({ job_id: true }));
  const existing = get<{ status: string; job_id: number }>('SELECT status, job_id FROM quotes WHERE id = ?', id);
  if (!existing) throw new HttpError(404, 'Quote not found');
  transaction(() => {
    updateRow('quotes', id, d, ['title', 'currency', 'tax_rate', 'valid_until', 'notes', 'status']);
    if (d.lines) insertQuoteLines(id, d.lines);
    if (d.status === 'approved' && existing.status !== 'approved') {
      run("UPDATE quotes SET status = 'superseded' WHERE job_id = ? AND id <> ? AND status = 'approved'", existing.job_id, id);
      run("UPDATE jobs SET status = 'confirmed', updated_at = datetime('now') WHERE id = ? AND status IN ('enquiry','quoted')", existing.job_id);
      logActivity('job', existing.job_id, 'quote.approved', { quote_id: id });
    }
  });
  return c.json(loadQuote(id));
});

/** Duplicate a quote as a new version (for revisions, e.g. R2). */
quotes.post('/:id/revise', c => {
  const id = idParam(c);
  const src = loadQuote(id) as any;
  const newId = transaction(() => {
    const { number, version } = nextQuoteNumber(src.job_id);
    const r = run('INSERT INTO quotes(job_id, number, version, status, title, currency, tax_rate, valid_until, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      src.job_id, number, version, 'draft', src.title, src.currency, src.tax_rate, src.valid_until, src.notes);
    const qid = Number(r.lastInsertRowid);
    insertQuoteLines(qid, src.lines);
    if (src.status === 'sent' || src.status === 'draft') run("UPDATE quotes SET status = 'superseded' WHERE id = ?", id);
    return qid;
  });
  return c.json(loadQuote(newId), 201);
});

quotes.delete('/:id', c => {
  const id = idParam(c);
  if (get('SELECT 1 FROM invoices WHERE quote_id = ?', id)) throw new HttpError(409, 'Quote has invoices; mark it superseded instead');
  run('DELETE FROM quotes WHERE id = ?', id);
  return c.body(null, 204);
});
