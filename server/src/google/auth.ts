/**
 * Google Workspace auth: a service account with domain-wide delegation lets
 * DeLorean act as any user in the domain (read their Gmail, write their
 * Calendar) and as itself for the Chat app.
 *
 * Env:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  path to the key file, or the JSON itself
 *   GOOGLE_WORKSPACE_DOMAIN      e.g. therefinery.tv
 *   GOOGLE_PUBSUB_TOPIC          projects/<p>/topics/delorean-gmail (for Gmail push)
 *   PUBLIC_URL                   https://delorean.therefinery.tv (webhooks + magic links)
 */
import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { setting } from '../db.ts';

interface ServiceAccount { client_email: string; private_key: string; project_id?: string }

let sa: ServiceAccount | null | undefined;
export function serviceAccount(): ServiceAccount | null {
  if (sa !== undefined) return sa;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return (sa = null);
  try {
    sa = raw.trim().startsWith('{') ? JSON.parse(raw) : existsSync(raw) ? JSON.parse(readFileSync(raw, 'utf8')) : null;
  } catch { sa = null; }
  return sa ?? null;
}

export function googleConfigured() { return serviceAccount() !== null; }
export function workspaceDomain() { return process.env.GOOGLE_WORKSPACE_DOMAIN ?? setting('google_domain') ?? null; }
export function publicUrl() { return (process.env.PUBLIC_URL ?? 'http://localhost:8787').replace(/\/$/, ''); }

export const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events',
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
  chatBot: 'https://www.googleapis.com/auth/chat.bot',
};

const cache = new Map<string, { token: string; expires: number }>();

function b64url(input: string | Buffer) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Access token for `scope`, impersonating `subject` (a Workspace user) when given. */
export async function googleToken(scope: string, subject?: string): Promise<string> {
  const acct = serviceAccount();
  if (!acct) throw new Error('Google service account is not configured (GOOGLE_SERVICE_ACCOUNT_JSON)');
  const key = `${subject ?? '-'}|${scope}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now() + 30_000) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { iss: acct.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  if (subject) claims.sub = subject;
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(acct.private_key);
  const assertion = `${unsigned}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  const json = await res.json() as { access_token: string; expires_in: number };
  cache.set(key, { token: json.access_token, expires: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

export async function gfetch<T = any>(url: string, scope: string, subject: string | undefined, init: RequestInit = {}): Promise<T> {
  const token = await googleToken(scope, subject);
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google ${init.method ?? 'GET'} ${url.split('?')[0]} failed (${res.status}): ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export function googleStatus() {
  const acct = serviceAccount();
  return {
    configured: Boolean(acct),
    service_account: acct?.client_email ?? null,
    domain: workspaceDomain(),
    pubsub_topic: process.env.GOOGLE_PUBSUB_TOPIC ?? null,
    public_url: publicUrl(),
    chat_webhook: `${publicUrl()}/api/google/chat`,
    gmail_push_endpoint: `${publicUrl()}/api/google/pubsub`,
    calendar_push_endpoint: `${publicUrl()}/api/google/calendar/notify`,
  };
}
