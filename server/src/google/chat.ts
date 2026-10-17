/**
 * Google Chat app: people DM DeLorean ("book me on 1600 Thursday", "7 hrs today")
 * and DeLorean DMs them (call times, hours nudges). The app authenticates as
 * itself (service account, chat.bot scope) – no impersonation needed.
 */
import { get, run } from '../db.ts';
import { gfetch, SCOPES, googleConfigured } from './auth.ts';

const CHAT = 'https://chat.googleapis.com/v1';

/** Find (or create) the DM space between the app and a user. */
export async function dmSpaceFor(userEmail: string, resourceId?: number): Promise<string> {
  const cached = resourceId ? get<{ chat_space: string | null }>('SELECT chat_space FROM resources WHERE id = ?', resourceId)?.chat_space : null;
  if (cached) return cached;
  const res = await gfetch<{ name: string }>(`${CHAT}/spaces:setup`, SCOPES.chatBot, undefined, {
    method: 'POST',
    body: JSON.stringify({ space: { spaceType: 'DIRECT_MESSAGE' }, memberships: [{ member: { name: `users/${userEmail}`, type: 'HUMAN' } }] }),
  });
  if (resourceId) run('UPDATE resources SET chat_space = ? WHERE id = ?', res.name, resourceId);
  return res.name;
}

export async function sendChatMessage(space: string, text: string, threadKey?: string) {
  const p = threadKey ? `?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` : '';
  return gfetch(`${CHAT}/${space}/messages${p}`, SCOPES.chatBot, undefined, {
    method: 'POST', body: JSON.stringify({ text, ...(threadKey ? { thread: { threadKey } } : {}) }),
  });
}

export async function sendChatDM(userEmail: string, text: string, resourceId?: number) {
  if (!googleConfigured()) throw new Error('Google not configured');
  const space = await dmSpaceFor(userEmail, resourceId);
  return sendChatMessage(space, text);
}

/** Post to the shared ops space (e.g. "#delorean") if configured. */
export async function postToOpsSpace(text: string) {
  const space = process.env.GOOGLE_CHAT_SPACE ?? get<{ value: string }>("SELECT value FROM settings WHERE key = 'google_chat_space'")?.value;
  if (!space || !googleConfigured()) return false;
  await sendChatMessage(space, text);
  return true;
}
