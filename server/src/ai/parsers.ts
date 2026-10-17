/**
 * Small structured-output helpers used by the bots:
 *  - parseHoursReply: "6 on the grade, 2 on Lindt" → timesheet entries
 *  - triageEmail: classify an inbound Refinery email and decide what DeLorean should do
 */
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { anthropic, MODEL, TRIAGE_MODEL, FALLBACK } from './client.ts';
import { all } from '../db.ts';

export const HoursReply = z.object({
  entries: z.array(z.object({
    job_id: z.number().int().nullable().describe('From the bookings listed; null if the person did not say and had several bookings'),
    hours: z.number(),
    notes: z.string().nullable(),
  })),
  off_today: z.boolean().describe('True if they say they did not work / were off'),
  needs_clarification: z.string().nullable(),
});

export async function parseHoursReply(resourceId: number, workDate: string, replyText: string) {
  const bookings = all<{ job_id: number; job_number: number; title: string; starts_at: string; ends_at: string }>(
    `SELECT b.job_id, j.job_number, j.title, b.starts_at, b.ends_at FROM bookings b JOIN jobs j ON j.id = b.job_id
      WHERE b.resource_id = ? AND b.status <> 'cancelled' AND substr(b.starts_at,1,10) <= ? AND substr(b.ends_at,1,10) >= ?`, resourceId, workDate, workDate);
  const res = await anthropic.beta.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    ...FALLBACK,
    output_config: { format: betaZodOutputFormat(HoursReply), effort: 'low' },
    messages: [{ role: 'user', content: `A crew member was asked how many hours they worked on ${workDate}. Their bookings that day:\n${bookings.map(b => `job_id ${b.job_id} · JN ${b.job_number} · ${b.title} · ${b.starts_at.slice(11)}–${b.ends_at.slice(11)}`).join('\n') || '(none)'}\n\nTheir reply:\n"""${replyText}"""\n\nIf they give one number and had one booking, attach it to that job. If the reply is not about hours, set needs_clarification.` }],
  });
  return res.parsed_output;
}

export const Triage = z.object({
  category: z.enum(['new_job_request', 'schedule_change', 'quote_request', 'po_or_approval', 'hours_report', 'invoice_query', 'crew_availability', 'internal', 'other']),
  job_number: z.number().int().nullable().describe('A JN mentioned in the subject or body'),
  client_name: z.string().nullable(),
  summary: z.string().describe('One line for the producer'),
  proposed_action: z.enum(['create_intake', 'update_schedule', 'log_hours', 'reply_with_status', 'flag_for_human', 'ignore']),
  urgency: z.enum(['low', 'normal', 'high']),
  key_dates: z.array(z.string()).describe('YYYY-MM-DD dates mentioned'),
});
export type TriageResult = z.infer<typeof Triage>;

export async function triageEmail(email: { from: string; to: string; subject: string; text: string; date: string }): Promise<TriageResult> {
  const jobs = all<{ job_number: number; title: string; client_name: string | null; status: string }>(
    "SELECT j.job_number, j.title, c.name AS client_name, j.status FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.status NOT IN ('closed','cancelled') ORDER BY j.job_number DESC LIMIT 60");
  const res = await anthropic.beta.messages.parse({
    model: TRIAGE_MODEL,
    max_tokens: 1500,
    output_config: { format: betaZodOutputFormat(Triage), effort: 'low' },
    system: [{ type: 'text', text: `You triage email for a post-production facility's scheduling hub. Live jobs (JN · title · client · status):\n${jobs.map(j => `${j.job_number} · ${j.title} · ${j.client_name ?? '-'} · ${j.status}`).join('\n')}\n\nClassify conservatively: newsletters, receipts, and social notifications are "other"/ignore. Only client or producer emails about scheduling, quotes, POs, deliveries or crew are actionable.`, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `From: ${email.from}\nTo: ${email.to}\nDate: ${email.date}\nSubject: ${email.subject}\n\n${email.text.slice(0, 12000)}` }],
  });
  return res.parsed_output ?? { category: 'other', job_number: null, client_name: null, summary: 'Unclassified', proposed_action: 'ignore', urgency: 'low', key_dates: [] };
}
