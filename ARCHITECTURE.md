# DeLorean architecture

## The idea

Farmer's Wife is a database with a UI you have to drive by hand. DeLorean is the same database with Claude driving it, and Google Workspace as the nervous system. The rule that keeps it sane: **everything goes through one validated API**. The UI calls it, the Claude tools call it in-process, the bots call it. Clash rules, job numbering, activity logging and calendar sync happen once, in the routes.

```
 producer email ─┐                       ┌─ Google Calendar (people + room calendars)
 spreadsheet ────┤                       ├─ Google Chat (DMs, ops room)
 Chat message ───┼─► Claude ─► API ─► DB ┼─ Gmail (send)
 UI "Ask" box ───┘      ▲                └─ Xero (draft invoices)
                        │
                 tools = the API
```

## Data model (SQLite, `server/src/schema.sql`)

- **jobs** – the unit of work. `job_number` (JN) is the identity everyone uses; it becomes a Xero tracking option. Status: enquiry → quoted → confirmed → in_progress → delivered → invoiced → closed.
- **clients** – production companies/agencies; `xero_contact_id` cached after first push.
- **departments** – mirrors the Xero *Department* tracking category and maps to the revenue account.
- **resources** – people, rooms, kit. People: `email` (Workspace), `is_freelancer`, `cost_day_rate`. Rooms/kit: `google_calendar_id`.
- **bookings** – one resource, one window, one job. `pencil | confirmed | cancelled`. One booking per day is the convention (hours tracking and calendar events stay simple). Carries `google_event_id`.
- **rate_card_items** – description, unit (day/week/gb/unit…), price, account code. Seeded from real invoice lines.
- **quotes / quote_lines** – headings, lines, separators (the shape of existing invoices). Approving a quote confirms the job and supersedes older approved quotes.
- **invoices / invoice_lines** – `milestone_fraction` scales the quote; `reference` is auto-built; Xero ids/status cached after push.
- **timesheets** – hours per person per day, attached to the booking on that day when unambiguous.
- **nudges / outbox** – what the hours bot asked, via which channel, and the reply.
- **intakes** – a dropped document or email and the Claude-extracted proposal; `committed_job_id` once accepted.
- **conversations / conversation_messages** – assistant threads, stored as raw API content blocks so tool calls and thinking replay correctly.
- **mail_events, gmail_watch, google_calendar_sync, xero_connection, sync_log, activity** – integration state and audit.

## Clash rules

`findConflicts(resource, start, end)` returns overlapping non-cancelled bookings. A **confirmed** booking is refused (409 with the clashes) if any overlap is confirmed, unless `force`. **Pencils** always succeed and report soft clashes. `confirm-job` flips every pencil on a job and reports which ones were blocked. The assistant is told never to force; it offers alternatives instead.

## The Claude layer (`server/src/ai`)

- **context.ts** – the stable system prompt: how the business bills, every department/resource/rate-card item/client with ids. Deterministic so it prompt-caches; "today" is a separate small block.
- **tools.ts** – `betaZodTool` definitions. Lookup tools (search_jobs, get_job, list_bookings, check_availability, …) and write tools (create_job, create_bookings, create_quote, create_invoice, push_invoice_to_xero, log_hours, message_person, …). Each `run` calls the API in-process and returns JSON, errors included, so the model can recover.
- **assistant.ts** – `client.beta.messages.toolRunner` with `stream: true`, adaptive thinking, effort high, max 25 iterations, server-side refusal fallback. Streams SSE to the UI; persists the whole turn (assistant + tool_result messages) to SQLite.
- **intake.ts** – `messages.parse` with a Zod output schema → `Proposal` (job, bookings by day, quote lines with rate-card ids, milestones, questions, confidence). `commitIntake` turns it into records through the API; rolls back the job on failure.
- **parsers.ts** – `parseHoursReply` (free text → entries, knows the person's bookings that day) and `triageEmail` (category, JN, proposed action) on the cheaper model.

Guardrails live in the prompt and the tools: money-moving actions (Xero push, client-facing sends) require a yes in the conversation; bulk changes get a summary first; the model can't bypass clash rules because the tool is the API.

## Google layer (`server/src/google`)

- **auth.ts** – service-account JWT signed with `node:crypto`, exchanged for an access token, optionally impersonating a Workspace user (domain-wide delegation). No Google SDK dependency.
- **calendar.ts** – outbound: `syncBookingToCalendar` upserts an event (summary `JN 1600 · Title — label`, `[PENCIL]` prefix and transparent for pencils, `extendedProperties.private.delorean_booking_id`). Called fire-and-forget after booking writes; `reconcileCalendar` retries anything stale. Inbound: `events.watch` channels per calendar → `/api/google/calendar/notify` → incremental sync with sync tokens → moved/deleted events update bookings.
- **gmail.ts** – `users.watch` per mailbox to a Pub/Sub topic; push → `/api/google/pubsub` → `history.list` since the stored id → full message fetch (text + attachments) → mail bot. `sendMail` for nudges/replies.
- **chat.ts** – DM space setup + `messages.create` as the app; inbound events at `/api/google/chat` are answered synchronously by the assistant (or the hours parser for short numeric replies).

## Bots (`server/src/bots`)

- **scheduler.ts** – one `setInterval` a minute. Nudges at `nudge_time` once per day; calendar reconcile every 5 min; Gmail/Calendar watch renewal every 6 h (both expire in 7 days); Xero open-invoice refresh hourly. `POST /api/assistant/scheduler/tick?force=…` runs any of them now.
- **nudges.ts** – `runDailyNudges(date)`: everyone booked (confirmed) that day without hours gets a message with a magic link (`/t/:token`, no login). `handleHoursReply` parses the reply and writes timesheets.
- **mailbot.ts** – triage → action: job/quote request → intake + proposal (attachments are read: xlsx/csv/docx/eml as text, PDF/images natively) + Chat announcement; schedule change / PO → assistant applies (autopilot) or drafts (default) and posts to the ops space; hours → logged; else ignored/flagged. Every email is recorded in `mail_events`.
- **channels.ts** – `sendToPerson`: Chat DM → email from the ops mailbox → in-app outbox. The outbox always gets a copy.

## Xero (`server/src/xero.ts`)

Authorization-code OAuth with refresh. Push = ensure contact → ensure JN tracking option → `PUT /Invoices` with `Type ACCREC`, `Status DRAFT`, `LineAmountTypes Exclusive`, `TaxType OUTPUT3` (this org's standard-rate output VAT), `AccountCode` from the line or the department, and `Tracking: [{Department}, {Job Number}]`. Headings/separators become description-only lines. `GET /invoices/:id/xero-preview` shows the exact payload before anything is sent.

## Moving off Farmer's Wife

1. **Export from FW**: resources (people/rooms/kit), clients, open projects, future bookings. CSV is fine.
2. **Import**: clients and resources via the API or the People page; jobs with their existing JNs (`job_number` is settable); bookings as confirmed. A one-off import script is a small addition; the API already enforces the rules.
3. **Set `next_job_number`** in Settings to the next free JN so numbering continues unbroken (Xero currently has options up to ~1546).
4. **Run both for two weeks**: DeLorean as the source of truth for new jobs, FW read-only. Calendar sync means everyone sees their bookings without opening either tool.
5. **Historic invoices stay in Xero**; DeLorean only needs to know about open jobs.

## Roadmap (suggested order)

1. Live run with a real `ANTHROPIC_API_KEY`; tune the assistant prompt on real requests and a handful of real producer spreadsheets (the intake schema is where most tuning lands).
2. Google service account + Calendar sync (highest day-to-day value, least risk).
3. Hours nudges on Chat; the magic link already works without Google.
4. Xero connect; push a couple of drafts and have accounts check them.
5. Gmail watch on shared inboxes first (bookings@, accounts@), then personal mailboxes; keep `mail_autopilot=0` until the proposals look right.
6. Client-facing quote PDF/email from DeLorean; purchase orders from freelancers; margin reporting from timesheets × cost rates.
7. Auth. There is none yet; put it behind Google sign-in (Workspace domain) before exposing it on the internet.
