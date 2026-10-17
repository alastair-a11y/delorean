# ⚡ DeLorean

The scheduling, quoting and billing hub for The Refinery, built around Claude.

You tell it what you need, or drop a producer's spreadsheet or email on it. It sets up the job, books the people, rooms and kit, writes the quote from the rate card, pushes milestone invoices into Xero with the right tracking, puts bookings on everyone's Google Calendar, and chases people for their hours at the end of the day.

It replaces Farmer's Wife for crew/freelancer bookings, rooms/suites/kit, project tracking, and quoting/invoicing.

## What's in the box

| Part | What it does |
|---|---|
| **Ask** (chat) | The front door. Natural language in, bookings/quotes/invoices out. Drop files straight onto it. |
| **Inbox** | Proposals from dropped documents and from the mail bot. One click to create (pencil) or create & confirm. Also shows what the bots did. |
| **Schedule** | Resources × days grid. Pencil (hatched) vs confirmed (solid). Confirmed bookings can't double-book; pencils can. |
| **Jobs** | Every job has a JN. Bookings, quotes, milestone invoices and hours live on the job page. |
| **Money** | Invoices, quotes, work-in-progress (approved vs invoiced vs cost), rate card. |
| **People & rooms** | Staff, freelancers (with cost rates), suites, kit. Workspace email = calendar + Chat. |
| **Bots** | Hours nudges (Chat/email/magic link), Gmail watcher → triage → proposals, Calendar two-way sync, Xero status refresh. |

## Run it

```bash
npm run install:all            # server + web deps
cp .env.example .env           # fill in ANTHROPIC_API_KEY at minimum
export $(grep -v '^#' .env | xargs)
SEED_DEMO=1 npm run dev        # API on :8787, UI on :5173 (proxied)
```

Production: `npm run build` then `npm start`. The server serves `web/dist` itself. Data is one SQLite file (`server/data/delorean.db`, WAL mode). Node 22.18+ required (uses `node:sqlite` and native TypeScript).

The first run seeds departments, Xero account mappings and a rate card taken from existing Refinery invoices. `SEED_DEMO=1` adds demo people, rooms, jobs and bookings so you can click around.

## Connecting things

**Claude** – `ANTHROPIC_API_KEY`. Assistant and intake run on `claude-opus-5-5`; mail triage runs on `claude-haiku-5-5` (both overridable). Server-side refusal fallbacks are on.

**Xero** – create a Xero app (Accounting API, redirect `PUBLIC_URL/api/settings/xero/callback`), set `XERO_CLIENT_ID/SECRET`, then Settings → Connect. DeLorean finds the *Department* and *Job Number* tracking categories, creates the JN option when it first invoices a job, finds-or-creates the client contact, and pushes invoices as **DRAFT** so accounts still approve them in Xero.

**Google Workspace** – one service account with domain-wide delegation (scopes: calendar, gmail.readonly, gmail.send, chat.bot). Steps are listed on the Settings page. Then:
- every booking for a person with a Workspace email becomes an event on their calendar (and on the room/kit resource calendar if set); moving or deleting it in Google updates the booking;
- every watched mailbox is pushed to DeLorean via Pub/Sub; Claude triages each email; job/quote requests become Inbox proposals, schedule changes are applied (if `mail_autopilot=1`) or proposed, hours replies are logged;
- the Chat app answers DMs ("book me on 1600 Thursday", "7 hrs today") and sends nudges.

Nothing in Google or Xero is needed for the core to work. Without them, messages land in the Outbox tab and calendars just aren't synced.

## How billing mirrors what you do today

- Invoice reference: `Title | Service | JN: 1400 | 1st 50% | PO# 123`
- A milestone invoice takes the approved quote's lines and multiplies quantities by the fraction (10 grade days × 50% = 5), exactly like the existing invoices.
- Lines carry the department revenue account (995 Colour, 993 VFX, 994 Editorial, 997 Audio, 986 Flame, 991 Dailies, 989 QC, 998 Facility, 899 drives/stock) and both tracking categories.
- Multi-currency jobs (ZAR/USD/EUR/GBP) invoice in the job currency.

## Layout

```
server/src
  app.ts            core HTTP app; Claude tools call these routes in-process
  routes/           jobs, bookings, quotes, invoices, timesheets, reports, settings, assistant, google, magic
  ai/               client, context (system prompt), tools, assistant (SSE), intake (doc → proposal), parsers
  google/           auth (service account JWT), calendar, gmail, chat
  bots/             channels, nudges, mailbot, scheduler
  xero.ts           OAuth + invoice push + tracking
  schema.sql        SQLite schema
web/src             Vite + React UI (Chat, Schedule, Jobs, Inbox, People, Money, Settings)
```

See `ARCHITECTURE.md` for the design, the data model, how the bots make decisions, and the plan for moving off Farmer's Wife.
