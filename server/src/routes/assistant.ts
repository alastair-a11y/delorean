import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { all, get, run } from '../db.ts';
import { body, idParam, HttpError } from '../http.ts';
import { runAssistant, ensureConversation, listConversations, conversationMessages } from '../ai/assistant.ts';
import { createIntake, processIntake, commitIntake, listIntakes, ProposalSchema } from '../ai/intake.ts';
import { textFromFile, attachmentBlocks, sourceTypeFor } from '../intake/files.ts';
import { aiConfigured } from '../ai/client.ts';
import { listNudges, runDailyNudges, handleHoursReply } from '../bots/nudges.ts';
import { tick, schedulerStatus } from '../bots/scheduler.ts';

export const assistant = new Hono();

assistant.get('/conversations', c => c.json(listConversations()));
assistant.get('/conversations/:id', c => {
  const id = idParam(c);
  const conv = get('SELECT * FROM conversations WHERE id = ?', id);
  if (!conv) throw new HttpError(404, 'Conversation not found');
  return c.json({ ...conv, messages: conversationMessages(id) });
});
assistant.delete('/conversations/:id', c => { run('DELETE FROM conversations WHERE id = ?', idParam(c)); return c.body(null, 204); });

/**
 * POST /api/assistant/chat  (multipart or JSON)
 *   message: text; conversation_id?: number; files[]: attachments
 * Streams SSE events: text, tool_start, tool_result, done, error.
 */
assistant.post('/chat', async c => {
  if (!aiConfigured()) throw new HttpError(503, 'Claude API key not configured (ANTHROPIC_API_KEY)');
  const ct = c.req.header('content-type') ?? '';
  let message = ''; let conversationId: number | null = null;
  const blocks: any[] = [];
  if (ct.includes('multipart/form-data')) {
    const form = await c.req.parseBody({ all: true });
    message = String(form.message ?? '');
    conversationId = form.conversation_id ? Number(form.conversation_id) : null;
    const files = ([] as any[]).concat(form.files ?? form['files[]'] ?? []).filter(f => f instanceof File) as File[];
    for (const f of files) {
      const buf = Buffer.from(await f.arrayBuffer());
      const text = textFromFile(f.name, f.type, buf);
      if (text) message += `\n\n--- ${f.name} ---\n${text}`;
      else {
        const b = attachmentBlocks(f.name, f.type, buf);
        if (!b.length) throw new HttpError(415, `Can't read ${f.name}. Send a spreadsheet, PDF, image, .eml, .docx or text.`);
        blocks.push(...b);
      }
    }
  } else {
    const d = await body(c, z.object({ message: z.string().min(1), conversation_id: z.number().int().nullable().optional() }));
    message = d.message; conversationId = d.conversation_id ?? null;
  }
  if (!message.trim() && !blocks.length) throw new HttpError(400, 'Say something or attach a file');
  const convId = ensureConversation(conversationId);
  const content = blocks.length ? [...blocks, { type: 'text', text: message || 'See attached.' }] : message;
  return streamSSE(c, async stream => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    await stream.writeSSE({ event: 'meta', data: JSON.stringify({ conversation_id: convId }) });
    for await (const ev of runAssistant(convId, content, { signal: abort.signal })) {
      await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
    }
  });
});

// ---- Intake: drop a spreadsheet/email/PDF, get a proposal, commit with one click ----
assistant.get('/intakes', c => c.json(listIntakes()));
assistant.get('/intakes/:id', c => {
  const row = get('SELECT * FROM intakes WHERE id = ?', idParam(c));
  if (!row) throw new HttpError(404, 'Intake not found');
  return c.json({ ...row, proposal: row.proposal ? JSON.parse(row.proposal as string) : null });
});

assistant.post('/intakes', async c => {
  if (!aiConfigured()) throw new HttpError(503, 'Claude API key not configured (ANTHROPIC_API_KEY)');
  const ct = c.req.header('content-type') ?? '';
  let text = ''; let filename: string | undefined; let sourceType: string = 'text';
  const blocks: any[] = [];
  if (ct.includes('multipart/form-data')) {
    const form = await c.req.parseBody({ all: true });
    text = String(form.text ?? '');
    const files = ([] as any[]).concat(form.files ?? form['files[]'] ?? form.file ?? []).filter(f => f instanceof File) as File[];
    for (const f of files) {
      filename ??= f.name; sourceType = sourceTypeFor(f.name, f.type);
      const buf = Buffer.from(await f.arrayBuffer());
      const t = textFromFile(f.name, f.type, buf);
      if (t) text += `\n\n--- ${f.name} ---\n${t}`;
      else {
        const b = attachmentBlocks(f.name, f.type, buf);
        if (!b.length) throw new HttpError(415, `Can't read ${f.name}`);
        blocks.push(...b); text += `\n\n(Attached: ${f.name})`;
      }
    }
  } else {
    const d = await body(c, z.object({ text: z.string().min(1), source_type: z.enum(['text', 'email']).optional() }));
    text = d.text; sourceType = d.source_type ?? 'text';
  }
  if (!text.trim()) throw new HttpError(400, 'Nothing to read');
  const id = createIntake(sourceType, text.trim(), filename);
  const proposal = await processIntake(id, blocks);
  return c.json({ id, proposal }, 201);
});

assistant.post('/intakes/:id/commit', async c => {
  const id = idParam(c);
  const d = await body(c, z.object({ proposal: ProposalSchema.partial().optional(), confirm: z.boolean().optional() }).optional().default({}));
  return c.json(await commitIntake(id, d.proposal ?? {}, { confirm: d.confirm }));
});
assistant.post('/intakes/:id/discard', c => { run("UPDATE intakes SET status = 'discarded' WHERE id = ?", idParam(c)); return c.json({ ok: true }); });
assistant.post('/intakes/:id/reprocess', async c => c.json({ proposal: await processIntake(idParam(c)) }));

// ---- Bots: nudges, outbox, mail events, scheduler ---------------------------
assistant.get('/nudges', c => c.json(listNudges()));
assistant.post('/nudges/run', async c => c.json(await runDailyNudges(c.req.query('date') ?? undefined)));
assistant.post('/nudges/reply', async c => {
  const d = await body(c, z.object({ resource_id: z.number().int(), text: z.string().min(1), date: z.string().optional() }));
  return c.json(await handleHoursReply(d.resource_id, d.text, { date: d.date, source: 'reply' }));
});
assistant.get('/outbox', c => c.json(all('SELECT * FROM outbox ORDER BY id DESC LIMIT 100')));
assistant.get('/mail', c => c.json(all('SELECT * FROM mail_events ORDER BY id DESC LIMIT 100').map(m => ({ ...m, triage: m.triage ? JSON.parse(m.triage as string) : null }))));
assistant.get('/scheduler', c => c.json(schedulerStatus()));
assistant.post('/scheduler/tick', async c => c.json({ ran: await tick((c.req.query('force') ?? '').split(',').filter(Boolean)) }));
