/**
 * Inbound webhooks from Google: Pub/Sub (Gmail), Chat app events, Calendar push.
 * These are the "bots running on everyone's mail and bookings".
 */
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { get, run } from '../db.ts';
import { HttpError } from '../http.ts';
import { pullNewMessages } from '../google/gmail.ts';
import { processInboundEmail } from '../bots/mailbot.ts';
import { pullCalendarChanges, calendarForChannel } from '../google/calendar.ts';
import { ensureConversation, askAssistant } from '../ai/assistant.ts';
import { handleHoursReply } from '../bots/nudges.ts';

export const google = new Hono();

function checkSecret(given: string | undefined) {
  const want = process.env.GOOGLE_WEBHOOK_SECRET;
  if (!want) return; // no secret configured: rely on the obscure URL + Google's own auth (set one in production)
  const a = Buffer.from(given ?? ''); const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'Bad webhook secret');
}

/** Gmail push: Pub/Sub wraps {emailAddress, historyId} in base64. */
google.post('/pubsub', async c => {
  checkSecret(c.req.query('secret'));
  const env = await c.req.json().catch(() => ({}));
  const data = env?.message?.data ? JSON.parse(Buffer.from(env.message.data, 'base64').toString('utf8')) : null;
  if (!data?.emailAddress) return c.json({ ok: true, ignored: true });
  // Ack fast; process in the background so Pub/Sub doesn't retry.
  void (async () => {
    try {
      const emails = await pullNewMessages(data.emailAddress, String(data.historyId));
      for (const e of emails) { try { await processInboundEmail(e); } catch (err) { console.error('mailbot', (err as Error).message); } }
    } catch (err) { console.error('gmail pull', data.emailAddress, (err as Error).message); }
  })();
  return c.json({ ok: true });
});

/** Google Chat app events. Reply synchronously with {text}. */
google.post('/chat', async c => {
  checkSecret(c.req.query('secret'));
  const ev = await c.req.json().catch(() => ({}));
  if (ev.type === 'ADDED_TO_SPACE') return c.json({ text: "Hi, I'm DeLorean. Tell me what to book, ask what's on, or send me your hours." });
  if (ev.type !== 'MESSAGE') return c.json({});
  const email: string = ev.message?.sender?.email ?? ev.user?.email ?? '';
  const text: string = (ev.message?.argumentText ?? ev.message?.text ?? '').trim();
  if (!text) return c.json({ text: 'Say something and I’ll get on it.' });
  const person = get<{ id: number; name: string }>("SELECT id, name FROM resources WHERE lower(email) = lower(?) AND type = 'person'", email);

  // Short numeric replies from a person with an open nudge are hours.
  if (person && /^\s*\d+([.,]\d+)?\s*(h|hrs|hours)?\b/i.test(text) && get("SELECT 1 FROM nudges WHERE resource_id = ? AND status = 'sent'", person.id)) {
    const r = await handleHoursReply(person.id, text, { source: 'reply' });
    return c.json({ text: r.reply });
  }
  const spaceName: string = ev.space?.name ?? `chat:${email}`;
  const convKey = `chat:${spaceName}`;
  let conv = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', convKey)?.value;
  const convId = ensureConversation(conv ? Number(conv) : null, `Chat with ${person?.name ?? email}`);
  if (!conv) run('INSERT INTO settings(key, value) VALUES (?, ?)', convKey, String(convId));
  try {
    const reply = await askAssistant(convId, `[Google Chat message from ${person ? `${person.name} (resource id ${person.id})` : email}]\n${text}`);
    return c.json({ text: reply || 'Done.' });
  } catch (e) {
    return c.json({ text: `Sorry, that failed: ${(e as Error).message}` });
  }
});

/** Calendar push notifications carry only headers; we pull the delta for that calendar. */
google.post('/calendar/notify', async c => {
  const channelId = c.req.header('x-goog-channel-id');
  const state = c.req.header('x-goog-resource-state');
  if (!channelId || state === 'sync') return c.body(null, 200);
  const calendarId = calendarForChannel(channelId);
  if (!calendarId) return c.body(null, 404);
  void pullCalendarChanges(calendarId).catch(err => console.error('calendar pull', calendarId, (err as Error).message));
  return c.body(null, 200);
});
