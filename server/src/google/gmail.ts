/**
 * Gmail: watch every Refinery mailbox via Pub/Sub push, pull new messages
 * through the history API, and hand them to the mail bot. Also sends mail
 * as a user (for nudges and replies).
 */
import { all, get, run } from '../db.ts';
import { gfetch, SCOPES, googleConfigured, workspaceDomain } from './auth.ts';

const GM = 'https://gmail.googleapis.com/gmail/v1/users';

export interface InboundEmail {
  user: string; messageId: string; threadId: string; from: string; to: string; subject: string; date: string; text: string;
  attachments: { filename: string; mimeType: string; attachmentId: string; size: number }[];
}

export async function watchMailbox(email: string, resourceId: number | null) {
  const topic = process.env.GOOGLE_PUBSUB_TOPIC;
  if (!topic) throw new Error('GOOGLE_PUBSUB_TOPIC is not set');
  const res = await gfetch<{ historyId: string; expiration: string }>(`${GM}/me/watch`, SCOPES.gmailRead, email, {
    method: 'POST', body: JSON.stringify({ topicName: topic, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }),
  });
  const existing = get<{ history_id: string | null }>('SELECT history_id FROM gmail_watch WHERE email = ?', email);
  run(`INSERT INTO gmail_watch(email, history_id, expires_at, resource_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET expires_at = excluded.expires_at, resource_id = excluded.resource_id,
       history_id = COALESCE(gmail_watch.history_id, excluded.history_id)`,
    email, existing?.history_id ?? res.historyId, new Date(Number(res.expiration)).toISOString(), resourceId);
  return res;
}

/** Every active person with a Workspace address gets a watch; renewed daily (Gmail watches expire after 7 days). */
export async function ensureMailWatches() {
  if (!googleConfigured() || !process.env.GOOGLE_PUBSUB_TOPIC) return { watched: 0 };
  const domain = workspaceDomain();
  const people = all<{ id: number; email: string }>("SELECT id, email FROM resources WHERE type = 'person' AND active = 1 AND email IS NOT NULL");
  const extra = (process.env.GOOGLE_WATCH_MAILBOXES ?? '').split(',').map(s => s.trim()).filter(Boolean).map(email => ({ id: null as number | null, email }));
  let watched = 0;
  for (const p of [...people, ...extra]) {
    if (domain && !p.email.toLowerCase().endsWith(`@${domain.toLowerCase()}`)) continue;
    const st = get<{ expires_at: string | null }>('SELECT expires_at FROM gmail_watch WHERE email = ?', p.email);
    if (st?.expires_at && new Date(st.expires_at).getTime() - Date.now() > 2 * 86400e3) continue;
    try { await watchMailbox(p.email, p.id); watched++; } catch (e) { console.error('gmail watch', p.email, (e as Error).message); }
  }
  return { watched };
}

function decodeBody(data?: string) {
  return data ? Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '';
}

function extractText(payload: any): { text: string; attachments: InboundEmail['attachments'] } {
  let text = ''; let html = '';
  const attachments: InboundEmail['attachments'] = [];
  const walk = (part: any) => {
    if (!part) return;
    const mt = part.mimeType ?? '';
    if (part.filename && part.body?.attachmentId) attachments.push({ filename: part.filename, mimeType: mt, attachmentId: part.body.attachmentId, size: part.body.size ?? 0 });
    else if (mt === 'text/plain' && part.body?.data) text += decodeBody(part.body.data);
    else if (mt === 'text/html' && part.body?.data) html += decodeBody(part.body.data);
    for (const p of part.parts ?? []) walk(p);
  };
  walk(payload);
  if (!text && html) text = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n');
  return { text: text.trim(), attachments };
}

export async function fetchMessage(user: string, id: string): Promise<InboundEmail> {
  const m = await gfetch<any>(`${GM}/me/messages/${id}?format=full`, SCOPES.gmailRead, user);
  const h = (name: string) => m.payload?.headers?.find((x: any) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const { text, attachments } = extractText(m.payload);
  return { user, messageId: m.id, threadId: m.threadId, from: h('From'), to: h('To'), subject: h('Subject'), date: h('Date'), text, attachments };
}

export async function fetchAttachment(user: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const a = await gfetch<{ data: string }>(`${GM}/me/messages/${messageId}/attachments/${attachmentId}`, SCOPES.gmailRead, user);
  return Buffer.from(a.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** New INBOX messages since the stored history id. Returns parsed emails and advances the cursor. */
export async function pullNewMessages(user: string, notifiedHistoryId?: string): Promise<InboundEmail[]> {
  const st = get<{ history_id: string | null }>('SELECT history_id FROM gmail_watch WHERE email = ?', user);
  const start = st?.history_id;
  const out: InboundEmail[] = [];
  if (!start) {
    // First contact: just record the cursor; don't replay the whole inbox.
    const prof = await gfetch<{ historyId: string }>(`${GM}/me/profile`, SCOPES.gmailRead, user);
    run('INSERT INTO gmail_watch(email, history_id) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET history_id = excluded.history_id', user, prof.historyId);
    return out;
  }
  let pageToken: string | undefined; let latest = start;
  const seen = new Set<string>();
  do {
    const p = new URLSearchParams({ startHistoryId: start, historyTypes: 'messageAdded', labelId: 'INBOX' });
    if (pageToken) p.set('pageToken', pageToken);
    let data: any;
    try { data = await gfetch(`${GM}/me/history?${p}`, SCOPES.gmailRead, user); }
    catch (e) {
      if (String((e as Error).message).includes('(404)')) { // history too old: reset cursor
        const prof = await gfetch<{ historyId: string }>(`${GM}/me/profile`, SCOPES.gmailRead, user);
        run('UPDATE gmail_watch SET history_id = ? WHERE email = ?', prof.historyId, user);
        return out;
      }
      throw e;
    }
    for (const h of data.history ?? []) for (const ma of h.messagesAdded ?? []) {
      const id = ma.message?.id; if (!id || seen.has(id)) continue; seen.add(id);
      if (get('SELECT 1 FROM mail_events WHERE gmail_user = ? AND message_id = ?', user, id)) continue;
      try { out.push(await fetchMessage(user, id)); } catch (e) { console.error('gmail fetch', id, (e as Error).message); }
    }
    if (data.historyId) latest = data.historyId;
    pageToken = data.nextPageToken;
  } while (pageToken);
  run("UPDATE gmail_watch SET history_id = ?, last_synced_at = datetime('now') WHERE email = ?", notifiedHistoryId && BigInt(notifiedHistoryId) > BigInt(latest) ? notifiedHistoryId : latest, user);
  return out;
}

export async function sendMail(fromUser: string, to: string, subject: string, text: string, opts: { threadId?: string; inReplyTo?: string } = {}) {
  const headers = [`From: ${fromUser}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"'];
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${text}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return gfetch(`${GM}/me/messages/send`, SCOPES.gmailRead, fromUser, { method: 'POST', body: JSON.stringify({ raw, threadId: opts.threadId }) });
}
