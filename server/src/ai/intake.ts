/**
 * Intake: a producer's spreadsheet, email, PDF or pasted text goes in; a
 * proposal (job + bookings + quote) comes out. Nothing is written until the
 * proposal is committed, which happens through the same API the UI uses.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { anthropic, MODEL, FALLBACK } from './client.ts';
import { businessContext } from './context.ts';
import { internal } from '../app.ts';
import { all, get, run, transaction, logActivity } from '../db.ts';
import { HttpError } from '../http.ts';

export const ProposalSchema = z.object({
  summary: z.string().describe('Two or three sentences a producer would recognise: what the job is, when, and what we are quoting'),
  confidence: z.enum(['high', 'medium', 'low']),
  questions: z.array(z.string()).describe('Things that are unclear and must be checked with the client or producer before confirming'),
  job: z.object({
    title: z.string(),
    client_name: z.string().nullable(),
    existing_client_id: z.number().int().nullable().describe('If the client already exists in the context list'),
    existing_job_id: z.number().int().nullable().describe('If this clearly refers to an existing job (e.g. a change to a JN), otherwise null'),
    department: z.string().nullable().describe('One of the department names'),
    kind: z.string().nullable().describe('Feature, Series, TVC, Music Video, Dailies, Dry Hire, ...'),
    currency: z.string().nullable(),
    po_number: z.string().nullable(),
    producer: z.string().nullable(),
    start_date: z.string().nullable().describe('YYYY-MM-DD'),
    end_date: z.string().nullable().describe('YYYY-MM-DD'),
    notes: z.string().nullable(),
  }),
  bookings: z.array(z.object({
    resource_id: z.number().int().nullable().describe('An existing resource id from context, or null with a requirement if none fits'),
    requirement: z.string().nullable().describe('What is needed if no resource id, e.g. "Senior colourist" or "Edit suite with Avid"'),
    date: z.string().describe('YYYY-MM-DD, one entry per day'),
    start_time: z.string().nullable().describe('HH:MM, null for a standard day'),
    end_time: z.string().nullable(),
    title: z.string().nullable(),
  })),
  quote: z.object({
    title: z.string().nullable().describe('Service description, e.g. "Picture & Sound Post"'),
    lines: z.array(z.object({
      kind: z.enum(['heading', 'line', 'separator']),
      description: z.string(),
      quantity: z.number().nullable(),
      unit: z.string().nullable(),
      unit_price: z.number().nullable().describe('From the rate card unless the source states a price'),
      rate_card_item_id: z.number().int().nullable(),
      xero_account_code: z.string().nullable(),
    })),
    milestones: z.array(z.object({ label: z.string(), fraction: z.number() })).describe('Billing plan, e.g. 1st 50% / Final 50%. Default to 50/50 for jobs over a week, 100% on completion otherwise'),
  }).nullable(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

const INTAKE_RULES = `
You turn a producer's schedule, brief, email or spreadsheet into a DeLorean proposal.
- Only use resource ids, rate card ids and client ids that appear in the context. If nothing fits, leave the id null and describe the requirement.
- One booking entry per resource per day. Weekends only if the source says so.
- Build the quote from the rate card: a heading per department/section, then lines. Quantities come from the schedule (days, weeks, units).
- If the source is a change to an existing job (mentions a JN or an existing title), set existing_job_id and only propose the changes.
- Put anything you had to guess into questions. Do not invent prices, dates or people.
`;

export async function extractProposal(sourceText: string, attachments: Anthropic.Beta.BetaContentBlockParam[] = []): Promise<Proposal> {
  const today = new Date().toISOString().slice(0, 10);
  const response = await anthropic.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { format: betaZodOutputFormat(ProposalSchema), effort: 'high' },
    system: [{ type: 'text', text: businessContext() + INTAKE_RULES, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [...attachments, { type: 'text', text: `Today is ${today}.\n\nSource material:\n\n${sourceText}` }] }],
  });
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined to process this document');
  if (!response.parsed_output) throw new HttpError(502, 'Could not extract a proposal from the document');
  return response.parsed_output;
}

export function createIntake(sourceType: string, rawText: string, filename?: string) {
  return Number(run('INSERT INTO intakes(source_type, raw_text, filename) VALUES (?, ?, ?)', sourceType, rawText, filename ?? null).lastInsertRowid);
}

export async function processIntake(id: number, attachments: Anthropic.Beta.BetaContentBlockParam[] = []) {
  const row = get<{ raw_text: string }>('SELECT raw_text FROM intakes WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Intake not found');
  try {
    const proposal = await extractProposal(row.raw_text, attachments);
    run("UPDATE intakes SET proposal = ?, status = 'proposed', error = NULL WHERE id = ?", JSON.stringify(proposal), id);
    return proposal;
  } catch (e) {
    run("UPDATE intakes SET status = 'failed', error = ? WHERE id = ?", (e as Error).message, id);
    throw e;
  }
}

/** Turn a proposal into real records: client → job → bookings (pencil) → quote (draft). One transaction. */
export async function commitIntake(id: number, overrides: Partial<Proposal> = {}, options: { confirm?: boolean } = {}) {
  const row = get<{ proposal: string | null; status: string }>('SELECT proposal, status FROM intakes WHERE id = ?', id);
  if (!row?.proposal) throw new HttpError(409, 'Nothing to commit');
  if (row.status === 'committed') throw new HttpError(409, 'Already committed');
  const p: Proposal = { ...JSON.parse(row.proposal), ...overrides };

  // Hono's app.request is async, so we cannot wrap in a sync SQLite transaction; do the steps and roll back by hand on failure.
  let jobId: number | undefined;
  const createdBookings: number[] = [];
  try {
    let clientId = p.job.existing_client_id ?? null;
    if (!clientId && p.job.client_name) {
      const found = get<{ id: number }>('SELECT id FROM clients WHERE name = ? COLLATE NOCASE', p.job.client_name);
      clientId = found?.id ?? (await internal('POST', '/api/clients', { name: p.job.client_name, currency: p.job.currency ?? 'ZAR' })).id;
    }
    if (p.job.existing_job_id) {
      jobId = p.job.existing_job_id;
      await internal('PATCH', `/api/jobs/${jobId}`, { po_number: p.job.po_number ?? undefined, notes: p.job.notes ?? undefined, end_date: p.job.end_date ?? undefined });
    } else {
      const dept = p.job.department ? get<{ id: number }>('SELECT id FROM departments WHERE name LIKE ?', `%${p.job.department.split('/')[0].trim()}%`) : undefined;
      const job = await internal('POST', '/api/jobs', {
        title: p.job.title, client_id: clientId, department_id: dept?.id, kind: p.job.kind, currency: p.job.currency ?? undefined, po_number: p.job.po_number,
        producer: p.job.producer, start_date: p.job.start_date, end_date: p.job.end_date, notes: p.job.notes, status: options.confirm ? 'confirmed' : 'enquiry',
      });
      jobId = job.id;
    }
    const bookable = p.bookings.filter(b => b.resource_id);
    if (bookable.length) {
      const rows = await internal('POST', '/api/bookings', {
        bookings: bookable.map(b => ({
          job_id: jobId, resource_id: b.resource_id, status: options.confirm ? 'confirmed' : 'pencil', title: b.title ?? undefined,
          starts_at: `${b.date}T${b.start_time ?? '09:00'}`, ends_at: `${b.date}T${b.end_time ?? '18:00'}`,
        })),
      });
      createdBookings.push(...rows.map((r: any) => r.id));
    }
    let quoteId: number | undefined;
    if (p.quote && p.quote.lines.length) {
      const q = await internal('POST', '/api/quotes', { job_id: jobId, title: p.quote.title, lines: p.quote.lines.map(l => ({ ...l, rate_card_item_id: l.rate_card_item_id ?? undefined, unit_price: l.unit_price ?? undefined, quantity: l.quantity ?? undefined, unit: l.unit ?? undefined, xero_account_code: l.xero_account_code ?? undefined })) });
      quoteId = q.id;
    }
    run("UPDATE intakes SET status = 'committed', committed_job_id = ?, proposal = ? WHERE id = ?", jobId, JSON.stringify(p), id);
    logActivity('job', jobId!, 'intake.commit', { intake_id: id, bookings: createdBookings.length, quote_id: quoteId });
    const unresolved = p.bookings.filter(b => !b.resource_id);
    return { job_id: jobId, bookings: createdBookings.length, quote_id: quoteId, unresolved_requirements: unresolved.map(u => `${u.date}: ${u.requirement}`), questions: p.questions };
  } catch (e) {
    if (jobId && !p.job.existing_job_id) run('DELETE FROM jobs WHERE id = ?', jobId); // cascades bookings/quotes
    throw e;
  }
}

export function listIntakes() {
  return all('SELECT id, source_type, filename, status, error, committed_job_id, created_at, substr(raw_text, 1, 200) AS preview, proposal FROM intakes ORDER BY id DESC LIMIT 100')
    .map(r => ({ ...r, proposal: r.proposal ? JSON.parse(r.proposal as string) : null }));
}
