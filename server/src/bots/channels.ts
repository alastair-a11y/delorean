/**
 * One place that decides how to reach a person: Google Chat DM first, then
 * email from the ops mailbox, then the in-app outbox (always written, so
 * nothing is lost when Google isn't configured yet).
 */
import { get, run, setting } from '../db.ts';
import { googleConfigured } from '../google/auth.ts';
import { sendChatDM } from '../google/chat.ts';
import { sendMail } from '../google/gmail.ts';

export type Channel = 'inapp' | 'email' | 'slack' | 'whatsapp' | 'chat';

export function opsMailbox() {
  return process.env.DELOREAN_MAILBOX ?? setting('ops_mailbox') ?? process.env.GOOGLE_DELEGATED_ADMIN ?? null;
}

export async function sendToPerson(resourceId: number, text: string, opts: { subject?: string; nudgeId?: number } = {}) {
  const r = get<{ id: number; name: string; email: string | null }>('SELECT id, name, email FROM resources WHERE id = ?', resourceId);
  if (!r) throw new Error('Resource not found');
  const preferred = (setting('nudge_channel') ?? 'chat') as 'chat' | 'email' | 'inapp';
  const tried: string[] = [];

  if (googleConfigured() && r.email && preferred !== 'inapp') {
    if (preferred === 'chat') {
      try { await sendChatDM(r.email, text, r.id); record('chat', r.email, text, opts); return { sent: 'chat', to: r.email }; }
      catch (e) { tried.push(`chat: ${(e as Error).message}`); }
    }
    const from = opsMailbox();
    if (from) {
      try { await sendMail(from, r.email, opts.subject ?? 'DeLorean', text); record('email', r.email, text, opts); return { sent: 'email', to: r.email }; }
      catch (e) { tried.push(`email: ${(e as Error).message}`); }
    }
  }
  record('inapp', r.email ?? r.name, text, opts);
  return { sent: 'inapp', to: r.name, note: tried.length ? `Fell back to in-app: ${tried.join('; ')}` : 'Google not configured; message is in the DeLorean outbox' };
}

function record(channel: string, recipient: string, body: string, opts: { subject?: string; nudgeId?: number }) {
  run('INSERT INTO outbox(channel, recipient, subject, body, nudge_id) VALUES (?, ?, ?, ?, ?)', channel, recipient, opts.subject ?? null, body, opts.nudgeId ?? null);
}
