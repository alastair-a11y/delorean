/**
 * Mail bot: every new email in a watched Refinery mailbox is triaged by Claude.
 *  - job/quote requests → an intake (proposal) the producer confirms with one click
 *  - schedule changes   → the assistant applies them (if mail_autopilot=1) or drafts them
 *  - hours reports      → logged against the booking
 *  - everything else    → ignored or flagged
 */
import { get, run, setting } from '../db.ts';
import { triageEmail } from '../ai/parsers.ts';
import { createIntake, processIntake } from '../ai/intake.ts';
import { ensureConversation, askAssistant } from '../ai/assistant.ts';
import { handleHoursReply } from './nudges.ts';
import { postToOpsSpace } from '../google/chat.ts';
import { fetchAttachment, type InboundEmail } from '../google/gmail.ts';
import { attachmentBlocks, textFromFile } from '../intake/files.ts';
import { publicUrl } from '../google/auth.ts';

function addr(s: string) { return (s.match(/<([^>]+)>/)?.[1] ?? s).trim().toLowerCase(); }

export async function processInboundEmail(email: InboundEmail) {
  const domain = (process.env.GOOGLE_WORKSPACE_DOMAIN ?? setting('google_domain') ?? '').toLowerCase();
  const fromAddr = addr(email.from);
  const id = Number(run('INSERT OR IGNORE INTO mail_events(gmail_user, message_id, thread_id, from_addr, to_addr, subject, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    email.user, email.messageId, email.threadId, fromAddr, email.to, email.subject, email.date).lastInsertRowid);
  if (!id) return { skipped: 'duplicate' };

  // Internal mail (from our own domain) is only interesting if it is an hours reply or an explicit DeLorean request.
  const internalSender = domain && fromAddr.endsWith(`@${domain}`);
  try {
    const triage = await triageEmail({ from: email.from, to: email.to, subject: email.subject, text: email.text, date: email.date });
    run('UPDATE mail_events SET triage = ? WHERE id = ?', JSON.stringify(triage), id);
    const sender = get<{ id: number; name: string }>('SELECT id, name FROM resources WHERE lower(email) = ? AND type = \'person\'', fromAddr);

    if (triage.category === 'hours_report' && sender) {
      const r = await handleHoursReply(sender.id, email.text, { source: 'reply' });
      run("UPDATE mail_events SET action = ?, status = 'handled' WHERE id = ?", `hours:${r.ok}`, id);
      return { action: 'hours', result: r };
    }

    if (['new_job_request', 'quote_request'].includes(triage.category) && !internalSender) {
      let text = `Email from ${email.from}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.text}`;
      const blocks: any[] = [];
      for (const a of email.attachments.slice(0, 5)) {
        try {
          const buf = await fetchAttachment(email.user, email.messageId, a.attachmentId);
          const extracted = textFromFile(a.filename, a.mimeType, buf);
          if (extracted) text += `\n\n--- Attachment: ${a.filename} ---\n${extracted}`;
          else blocks.push(...attachmentBlocks(a.filename, a.mimeType, buf));
        } catch (e) { text += `\n\n(Could not read attachment ${a.filename}: ${(e as Error).message})`; }
      }
      const intakeId = createIntake('email', text, email.subject);
      run("UPDATE mail_events SET intake_id = ?, action = ?, status = 'handled' WHERE id = ?", intakeId, `intake:${intakeId}`, id);
      try {
        const proposal = await processIntake(intakeId, blocks);
        await postToOpsSpace(`📥 New ${triage.category === 'quote_request' ? 'quote request' : 'job request'} from ${triage.client_name ?? email.from}: ${proposal.summary}\nReview: ${publicUrl()}/inbox/${intakeId}`);
      } catch (e) { console.error('intake from mail', (e as Error).message); }
      return { action: 'intake', intake_id: intakeId };
    }

    if (['schedule_change', 'po_or_approval', 'crew_availability'].includes(triage.category) && triage.proposed_action !== 'ignore') {
      const autopilot = (setting('mail_autopilot') ?? '0') === '1';
      const conv = ensureConversation(null, `Mail: ${email.subject}`.slice(0, 80));
      const instruction = autopilot
        ? 'Apply the change described in this email to the schedule/job. If anything is ambiguous, do not guess: say what you need.'
        : 'Do NOT change anything yet. Say exactly what you would change (bookings, dates, PO, status) so a producer can approve it.';
      const reply = await askAssistant(conv, `${instruction}\n\nFrom: ${email.from}\nSubject: ${email.subject}\nJN mentioned: ${triage.job_number ?? 'none'}\n\n${email.text}`);
      run("UPDATE mail_events SET action = ?, status = ? WHERE id = ?", `assistant:${conv}`, autopilot ? 'handled' : 'flagged', id);
      await postToOpsSpace(`${autopilot ? '✅' : '✋'} ${triage.summary} (JN ${triage.job_number ?? '?'})\n${reply.slice(0, 600)}\n${publicUrl()}/chat/${conv}`);
      return { action: autopilot ? 'applied' : 'proposed', conversation_id: conv };
    }

    if (triage.proposed_action === 'flag_for_human') {
      run("UPDATE mail_events SET action = 'flagged', status = 'flagged' WHERE id = ?", id);
      await postToOpsSpace(`✋ ${triage.summary} — from ${email.from} (${email.subject})`);
      return { action: 'flagged' };
    }
    run("UPDATE mail_events SET action = 'ignored', status = 'ignored' WHERE id = ?", id);
    return { action: 'ignored', category: triage.category };
  } catch (e) {
    run("UPDATE mail_events SET status = 'failed', action = ? WHERE id = ?", (e as Error).message.slice(0, 300), id);
    throw e;
  }
}
