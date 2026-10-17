/**
 * Bookings ↔ Google Calendar.
 *  Outbound: every booking becomes an event on the person's calendar (and the room/kit resource calendar).
 *  Inbound:  calendar push notifications → incremental sync → moved/deleted events update the booking.
 */
import { randomUUID } from 'node:crypto';
import { all, get, run, setting, logActivity } from '../db.ts';
import { gfetch, SCOPES, googleConfigured, publicUrl, workspaceDomain } from './auth.ts';

const CAL = 'https://www.googleapis.com/calendar/v3';

interface BookingRow {
  id: number; job_id: number | null; resource_id: number; starts_at: string; ends_at: string; status: string; title: string | null; notes: string | null;
  google_event_id: string | null; google_calendar_id: string | null;
  resource_name: string; resource_type: string; resource_email: string | null; google_calendar_id_res: string | null;
  job_number: number | null; job_title: string | null; client_name: string | null; po_number: string | null;
}

function loadBooking(id: number): BookingRow | undefined {
  return get<BookingRow>(
    `SELECT b.*, r.name AS resource_name, r.type AS resource_type, r.email AS resource_email, r.google_calendar_id AS google_calendar_id_res,
            j.job_number, j.title AS job_title, j.po_number, c.name AS client_name
       FROM bookings b JOIN resources r ON r.id = b.resource_id LEFT JOIN jobs j ON j.id = b.job_id LEFT JOIN clients c ON c.id = j.client_id WHERE b.id = ?`, id);
}

/** Which calendar a resource's bookings live on. People: their Workspace email. Rooms/kit: a resource calendar id. */
export function calendarIdFor(r: { resource_type: string; resource_email: string | null; google_calendar_id_res: string | null }) {
  if (r.google_calendar_id_res) return r.google_calendar_id_res;
  if (r.resource_type === 'person' && r.resource_email) return r.resource_email;
  return null;
}

/** Calendar API impersonates a user; for resource calendars we act as the delegated admin who owns them. */
function actingUser(calendarId: string) {
  if (calendarId.includes('@') && !calendarId.endsWith('resource.calendar.google.com') && !calendarId.includes('@group.')) return calendarId;
  return process.env.GOOGLE_DELEGATED_ADMIN ?? setting('google_delegated_admin') ?? undefined;
}

function eventBody(b: BookingRow) {
  const tz = setting('timezone') ?? 'Africa/Johannesburg';
  const jn = b.job_number ? `JN ${b.job_number} · ` : '';
  const summary = `${b.status === 'pencil' ? '[PENCIL] ' : ''}${jn}${b.job_title ?? b.title ?? 'Booking'}${b.title && b.job_title ? ` — ${b.title}` : ''}`;
  const lines = [
    b.job_title ? `Job: ${b.job_number} ${b.job_title}` : null,
    b.client_name ? `Client: ${b.client_name}` : null,
    b.po_number ? `PO: ${b.po_number}` : null,
    `Resource: ${b.resource_name}`,
    `Status: ${b.status}`,
    b.notes ? `\n${b.notes}` : null,
    `\nManaged by DeLorean · ${publicUrl()}/jobs/${b.job_id ?? ''}`,
  ].filter(Boolean).join('\n');
  return {
    summary, description: lines,
    start: { dateTime: `${b.starts_at}:00`, timeZone: tz },
    end: { dateTime: `${b.ends_at}:00`, timeZone: tz },
    colorId: b.status === 'pencil' ? '8' : undefined,
    transparency: b.status === 'pencil' ? 'transparent' : 'opaque',
    extendedProperties: { private: { delorean_booking_id: String(b.id), delorean_job_id: String(b.job_id ?? '') } },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
  };
}

/** Create/update/delete the Google event for a booking. Safe to call repeatedly. */
export async function syncBookingToCalendar(bookingId: number): Promise<{ action: string; event_id?: string } | { skipped: string }> {
  if (!googleConfigured() || (setting('auto_calendar_sync') ?? '1') === '0') return { skipped: 'calendar sync off' };
  const b = loadBooking(bookingId);
  if (!b) {
    // Booking deleted: nothing to look up; deletions are handled by deleteBookingEvent before the row goes.
    return { skipped: 'booking gone' };
  }
  const calendarId = calendarIdFor(b);
  if (!calendarId) return { skipped: 'resource has no calendar/email' };
  const user = actingUser(calendarId);
  const base = `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`;

  if (b.status === 'cancelled') {
    if (b.google_event_id) {
      await gfetch(`${base}/${b.google_event_id}`, SCOPES.calendar, user, { method: 'DELETE' }).catch(() => undefined);
      run('UPDATE bookings SET google_event_id = NULL, google_synced_at = datetime(\'now\') WHERE id = ?', b.id);
    }
    return { action: 'deleted' };
  }
  const body = JSON.stringify(eventBody(b));
  if (b.google_event_id && b.google_calendar_id === calendarId) {
    const ev = await gfetch<{ id: string }>(`${base}/${b.google_event_id}`, SCOPES.calendar, user, { method: 'PATCH', body });
    run("UPDATE bookings SET google_synced_at = datetime('now') WHERE id = ?", b.id);
    return { action: 'updated', event_id: ev.id };
  }
  if (b.google_event_id && b.google_calendar_id && b.google_calendar_id !== calendarId) {
    // Resource changed: remove from the old calendar.
    await gfetch(`${CAL}/calendars/${encodeURIComponent(b.google_calendar_id)}/events/${b.google_event_id}`, SCOPES.calendar, actingUser(b.google_calendar_id), { method: 'DELETE' }).catch(() => undefined);
  }
  const ev = await gfetch<{ id: string }>(base, SCOPES.calendar, user, { method: 'POST', body });
  run("UPDATE bookings SET google_event_id = ?, google_calendar_id = ?, google_synced_at = datetime('now') WHERE id = ?", ev.id, calendarId, b.id);
  return { action: 'created', event_id: ev.id };
}

export async function deleteBookingEvent(bookingId: number) {
  const b = get<{ google_event_id: string | null; google_calendar_id: string | null }>('SELECT google_event_id, google_calendar_id FROM bookings WHERE id = ?', bookingId);
  if (!googleConfigured() || !b?.google_event_id || !b.google_calendar_id) return;
  await gfetch(`${CAL}/calendars/${encodeURIComponent(b.google_calendar_id)}/events/${b.google_event_id}`, SCOPES.calendar, actingUser(b.google_calendar_id), { method: 'DELETE' }).catch(() => undefined);
}

/** Bookings whose event is missing or stale (the scheduler retries these). */
export async function reconcileCalendar(limit = 50) {
  if (!googleConfigured()) return { synced: 0 };
  const rows = all<{ id: number }>(
    `SELECT b.id FROM bookings b JOIN resources r ON r.id = b.resource_id
      WHERE b.status <> 'cancelled' AND (r.email IS NOT NULL OR r.google_calendar_id IS NOT NULL)
        AND (b.google_event_id IS NULL OR b.google_synced_at IS NULL OR b.google_synced_at < b.updated_at)
      ORDER BY b.updated_at LIMIT ?`, limit);
  let synced = 0;
  for (const r of rows) { try { await syncBookingToCalendar(r.id); synced++; } catch (e) { console.error('calendar sync', r.id, (e as Error).message); } }
  return { synced };
}

// ---- Inbound: watch channels + incremental sync -----------------------------

export async function watchCalendar(calendarId: string, resourceId: number | null) {
  const user = actingUser(calendarId);
  const channelId = randomUUID();
  const res = await gfetch<{ resourceId: string; expiration: string }>(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events/watch`, SCOPES.calendar, user, {
    method: 'POST', body: JSON.stringify({ id: channelId, type: 'web_hook', address: `${publicUrl()}/api/google/calendar/notify`, params: { ttl: '604800' } }),
  });
  run(`INSERT INTO google_calendar_sync(calendar_id, resource_id, channel_id, channel_resource_id, channel_expires_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(calendar_id) DO UPDATE SET resource_id = excluded.resource_id, channel_id = excluded.channel_id,
       channel_resource_id = excluded.channel_resource_id, channel_expires_at = excluded.channel_expires_at`,
    calendarId, resourceId, channelId, res.resourceId, new Date(Number(res.expiration)).toISOString());
  return channelId;
}

/** Pull changes since the stored sync token and apply moves/deletes made in Google back onto bookings. */
export async function pullCalendarChanges(calendarId: string) {
  const state = get<{ sync_token: string | null; resource_id: number | null }>('SELECT sync_token, resource_id FROM google_calendar_sync WHERE calendar_id = ?', calendarId);
  const user = actingUser(calendarId);
  let pageToken: string | undefined;
  let syncToken = state?.sync_token ?? undefined;
  let applied = 0;
  do {
    const p = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', maxResults: '250' });
    if (syncToken && !pageToken) p.set('syncToken', syncToken);
    else if (!syncToken) p.set('timeMin', new Date(Date.now() - 7 * 86400e3).toISOString());
    if (pageToken) p.set('pageToken', pageToken);
    let data: any;
    try {
      data = await gfetch(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${p}`, SCOPES.calendar, user);
    } catch (e) {
      if (String((e as Error).message).includes('(410)')) { syncToken = undefined; pageToken = undefined; continue; } // token expired: full resync
      throw e;
    }
    for (const ev of data.items ?? []) {
      const bid = Number(ev.extendedProperties?.private?.delorean_booking_id);
      if (!bid) continue;
      const booking = get<{ id: number; starts_at: string; ends_at: string; status: string }>('SELECT id, starts_at, ends_at, status FROM bookings WHERE id = ?', bid);
      if (!booking) continue;
      if (ev.status === 'cancelled') {
        if (booking.status !== 'cancelled') { run("UPDATE bookings SET status = 'cancelled', google_event_id = NULL, updated_at = datetime('now'), google_synced_at = datetime('now') WHERE id = ?", bid); logActivity('booking', bid, 'cancelled_from_calendar'); applied++; }
        continue;
      }
      const s = ev.start?.dateTime?.slice(0, 16); const e = ev.end?.dateTime?.slice(0, 16);
      if (s && e && (s !== booking.starts_at || e !== booking.ends_at)) {
        run("UPDATE bookings SET starts_at = ?, ends_at = ?, updated_at = datetime('now'), google_synced_at = datetime('now') WHERE id = ?", s, e, bid);
        logActivity('booking', bid, 'moved_from_calendar', { from: [booking.starts_at, booking.ends_at], to: [s, e] });
        applied++;
      }
    }
    pageToken = data.nextPageToken;
    if (data.nextSyncToken) syncToken = data.nextSyncToken;
  } while (pageToken);
  run(`INSERT INTO google_calendar_sync(calendar_id, resource_id, sync_token, last_synced_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(calendar_id) DO UPDATE SET sync_token = excluded.sync_token, last_synced_at = excluded.last_synced_at`, calendarId, state?.resource_id ?? null, syncToken ?? null);
  return { applied };
}

/** Make sure every person with an email (and every room/kit with a calendar) has a live watch channel. */
export async function ensureCalendarWatches() {
  if (!googleConfigured()) return { watched: 0 };
  const domain = workspaceDomain();
  const resources = all<{ id: number; type: string; email: string | null; google_calendar_id: string | null }>('SELECT id, type, email, google_calendar_id FROM resources WHERE active = 1');
  let watched = 0;
  for (const r of resources) {
    const cal = calendarIdFor({ resource_type: r.type, resource_email: r.email, google_calendar_id_res: r.google_calendar_id });
    if (!cal) continue;
    if (domain && cal.includes('@') && !cal.endsWith(domain) && !cal.endsWith('resource.calendar.google.com')) continue; // outside the Workspace: can't impersonate
    const st = get<{ channel_expires_at: string | null }>('SELECT channel_expires_at FROM google_calendar_sync WHERE calendar_id = ?', cal);
    if (st?.channel_expires_at && new Date(st.channel_expires_at).getTime() - Date.now() > 86400e3) continue;
    try { await watchCalendar(cal, r.id); watched++; } catch (e) { console.error('calendar watch', cal, (e as Error).message); }
  }
  return { watched };
}

export function calendarForChannel(channelId: string) {
  return get<{ calendar_id: string }>('SELECT calendar_id FROM google_calendar_sync WHERE channel_id = ?', channelId)?.calendar_id;
}
