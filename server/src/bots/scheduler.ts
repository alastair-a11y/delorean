/**
 * The heartbeat. Runs every minute and does whatever is due:
 *  - end-of-day hours nudges
 *  - Google watch renewals (Gmail 7 days, Calendar 7 days)
 *  - calendar reconcile for bookings that changed
 *  - Xero invoice status refresh
 */
import { setting, run, get } from '../db.ts';
import { runDailyNudges, localToday, localTimeHHMM } from './nudges.ts';
import { ensureMailWatches } from '../google/gmail.ts';
import { ensureCalendarWatches, reconcileCalendar } from '../google/calendar.ts';
import { googleConfigured } from '../google/auth.ts';
import { refreshAllOpenInvoices, xeroStatus } from '../xero.ts';
import { aiConfigured } from '../ai/client.ts';

let timer: NodeJS.Timeout | null = null;
let busy = false;
const last: Record<string, number> = {};
const due = (key: string, ms: number) => Date.now() - (last[key] ?? 0) >= ms;
const mark = (key: string) => { last[key] = Date.now(); };

export function schedulerStatus() {
  return { running: timer !== null, last: Object.fromEntries(Object.entries(last).map(([k, v]) => [k, new Date(v).toISOString()])) };
}

export async function tick(force: string[] = []) {
  if (busy) return; busy = true;
  const log: string[] = [];
  try {
    // 1. Hours nudges at the configured local time (default 17:30), once per day.
    const nudgeAt = setting('nudge_time') ?? '17:30';
    const today = localToday();
    const sentKey = get<{ value: string }>("SELECT value FROM settings WHERE key = 'nudges_sent_for'")?.value;
    if ((force.includes('nudges') || (localTimeHHMM() >= nudgeAt && sentKey !== today)) && aiConfigured()) {
      const r = await runDailyNudges(today);
      run("INSERT INTO settings(key, value) VALUES ('nudges_sent_for', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", today);
      log.push(`nudges: ${r.results.filter(x => x.status === 'sent').length} sent`);
    }
    if (googleConfigured()) {
      if (force.includes('calendar') || due('calendar', 5 * 60e3)) { const r = await reconcileCalendar(); mark('calendar'); if (r.synced) log.push(`calendar: ${r.synced} synced`); }
      if (force.includes('watches') || due('watches', 6 * 3600e3)) {
        const m = await ensureMailWatches(); const c = await ensureCalendarWatches(); mark('watches');
        if (m.watched || c.watched) log.push(`watches: ${m.watched} mail, ${c.watched} calendar`);
      }
    }
    if (xeroStatus().connected && (force.includes('xero') || due('xero', 60 * 60e3))) {
      const r = await refreshAllOpenInvoices(); mark('xero'); if (r.updated) log.push(`xero: ${r.updated} invoices refreshed`);
    }
  } catch (e) {
    console.error('[scheduler]', (e as Error).message);
  } finally { busy = false; }
  if (log.length) console.log('[scheduler]', log.join(' · '));
  return log;
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, 60_000);
  setTimeout(() => { void tick(); }, 5_000);
}
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }
