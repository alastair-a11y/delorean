PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  colour                TEXT NOT NULL DEFAULT '#6b7280',
  xero_revenue_account  TEXT,            -- e.g. 993 for VFX
  xero_tracking_option  TEXT,            -- option name under the "Department" tracking category
  sort_order            INTEGER NOT NULL DEFAULT 0,
  active                INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clients (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  contact_name     TEXT,
  email            TEXT,
  phone            TEXT,
  vat_number       TEXT,
  currency         TEXT NOT NULL DEFAULT 'ZAR',
  payment_terms    INTEGER NOT NULL DEFAULT 30,   -- days
  xero_contact_id  TEXT,
  notes            TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS clients_name_idx ON clients(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS jobs (
  id             INTEGER PRIMARY KEY,
  job_number     INTEGER NOT NULL UNIQUE,         -- the JN used on every Xero invoice
  title          TEXT NOT NULL,
  client_id      INTEGER REFERENCES clients(id),
  department_id  INTEGER REFERENCES departments(id),
  status         TEXT NOT NULL DEFAULT 'enquiry'
                 CHECK (status IN ('enquiry','quoted','confirmed','in_progress','delivered','invoiced','closed','cancelled')),
  kind           TEXT,                            -- Feature, Series, TVC, Music Video, Dailies, Dry Hire, ...
  currency       TEXT NOT NULL DEFAULT 'ZAR',
  po_number      TEXT,
  producer       TEXT,
  start_date     TEXT,
  end_date       TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS jobs_client_idx ON jobs(client_id);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);

CREATE TABLE IF NOT EXISTS resources (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('person','room','kit')),
  department_id   INTEGER REFERENCES departments(id),
  role            TEXT,                           -- Colourist, Editor, Flame Op, Grade Suite 1, LTO deck...
  is_freelancer   INTEGER NOT NULL DEFAULT 0,
  cost_day_rate   REAL,                           -- what it costs us (freelancer day rate)
  charge_day_rate REAL,                           -- what we charge for it (rate card default)
  email           TEXT,
  phone           TEXT,
  notes           TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  google_calendar_id TEXT,                      -- person: their Workspace email; room/kit: the resource calendar id
  chat_space      TEXT                          -- Google Chat DM space name once established (spaces/AAAA)
);
CREATE INDEX IF NOT EXISTS resources_type_idx ON resources(type, active);

CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  resource_id  INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  starts_at    TEXT NOT NULL,                     -- ISO local datetime 'YYYY-MM-DDTHH:MM'
  ends_at      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pencil' CHECK (status IN ('pencil','confirmed','cancelled')),
  title        TEXT,                              -- optional override, e.g. "Grade day 3"
  notes        TEXT,
  google_event_id    TEXT,
  google_calendar_id TEXT,
  google_synced_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS bookings_resource_time_idx ON bookings(resource_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS bookings_job_idx ON bookings(job_id);

CREATE TABLE IF NOT EXISTS rate_card_items (
  id                 INTEGER PRIMARY KEY,
  code               TEXT UNIQUE,
  description        TEXT NOT NULL,
  unit               TEXT NOT NULL DEFAULT 'day' CHECK (unit IN ('day','half_day','week','hour','gb','unit','flat')),
  unit_price         REAL NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'ZAR',
  department_id      INTEGER REFERENCES departments(id),
  xero_account_code  TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  sort_order         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quotes (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  number       TEXT NOT NULL UNIQUE,              -- Q-1547-1
  version      INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','approved','declined','superseded')),
  title        TEXT,                              -- e.g. "Picture & Sound Post"
  currency     TEXT NOT NULL DEFAULT 'ZAR',
  tax_rate     REAL NOT NULL DEFAULT 15,
  valid_until  TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quote_lines (
  id                 INTEGER PRIMARY KEY,
  quote_id           INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  kind               TEXT NOT NULL DEFAULT 'line' CHECK (kind IN ('heading','line','separator')),
  description        TEXT NOT NULL DEFAULT '',
  quantity           REAL,
  unit               TEXT,
  unit_price         REAL,
  xero_account_code  TEXT,
  rate_card_item_id  INTEGER REFERENCES rate_card_items(id)
);
CREATE INDEX IF NOT EXISTS quote_lines_quote_idx ON quote_lines(quote_id, sort_order);

CREATE TABLE IF NOT EXISTS invoices (
  id                  INTEGER PRIMARY KEY,
  job_id              INTEGER NOT NULL REFERENCES jobs(id),
  quote_id            INTEGER REFERENCES quotes(id),
  number              TEXT NOT NULL UNIQUE,       -- our internal number; Xero assigns INV-xxxx on push
  milestone_label     TEXT,                       -- "1st 50%", "Final 25%", "Additional"
  milestone_fraction  REAL,                       -- 0.5 -> quote quantities × 0.5
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','approved','pushed','paid','void')),
  currency            TEXT NOT NULL DEFAULT 'ZAR',
  tax_rate            REAL NOT NULL DEFAULT 15,
  issue_date          TEXT NOT NULL,
  due_date            TEXT NOT NULL,
  reference           TEXT,                       -- "Title | Service | JN: 1400 | 1st 50% | PO# x"
  po_number           TEXT,
  xero_invoice_id     TEXT,
  xero_invoice_number TEXT,
  xero_status         TEXT,
  amount_due          REAL,
  pushed_at           TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS invoices_job_idx ON invoices(job_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id                 INTEGER PRIMARY KEY,
  invoice_id         INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  kind               TEXT NOT NULL DEFAULT 'line' CHECK (kind IN ('heading','line','separator')),
  description        TEXT NOT NULL DEFAULT '',
  quantity           REAL,
  unit_price         REAL,
  xero_account_code  TEXT
);
CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx ON invoice_lines(invoice_id, sort_order);

CREATE TABLE IF NOT EXISTS xero_connection (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id      TEXT,
  tenant_name    TEXT,
  access_token   TEXT,
  refresh_token  TEXT,
  expires_at     TEXT,
  scopes         TEXT,
  dept_tracking_category_id TEXT,
  job_tracking_category_id  TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  entity      TEXT NOT NULL,     -- invoice, contact, tracking
  entity_id   INTEGER,
  action      TEXT NOT NULL,     -- push, pull, create_option
  ok          INTEGER NOT NULL,
  detail      TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT
);

-- ---- DeLorean assistant, intake, and hours-tracking bots ---------------------

CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY,
  title       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id               INTEGER PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content          TEXT NOT NULL,           -- JSON: API content blocks (kept verbatim so thinking/tool blocks replay)
  display_text     TEXT,                    -- plain text for the UI
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS conv_msgs_idx ON conversation_messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS intakes (
  id               INTEGER PRIMARY KEY,
  source_type      TEXT NOT NULL CHECK (source_type IN ('text','email','spreadsheet','pdf','image')),
  filename         TEXT,
  raw_text         TEXT NOT NULL,
  proposal         TEXT,                    -- JSON: {job, bookings[], quote} as extracted by Claude
  status           TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','committed','discarded','failed')),
  error            TEXT,
  committed_job_id INTEGER REFERENCES jobs(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS timesheets (
  id           INTEGER PRIMARY KEY,
  resource_id  INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  job_id       INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  booking_id   INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  work_date    TEXT NOT NULL,
  hours        REAL NOT NULL CHECK (hours >= 0 AND hours <= 24),
  notes        TEXT,
  source       TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','reply','link','assistant','import')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS timesheets_res_date_idx ON timesheets(resource_id, work_date);
CREATE INDEX IF NOT EXISTS timesheets_job_idx ON timesheets(job_id, work_date);

CREATE TABLE IF NOT EXISTS nudges (
  id           INTEGER PRIMARY KEY,
  resource_id  INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  work_date    TEXT NOT NULL,               -- the day we are asking about
  channel      TEXT NOT NULL CHECK (channel IN ('inapp','email','slack','whatsapp')),
  token        TEXT NOT NULL UNIQUE,        -- magic-link token for no-login replies
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','answered','failed','skipped')),
  sent_at      TEXT,
  reply_text   TEXT,
  replied_at   TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS nudges_res_date_idx ON nudges(resource_id, work_date);

CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY,
  channel     TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  subject     TEXT,
  body        TEXT NOT NULL,
  nudge_id    INTEGER REFERENCES nudges(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Google Workspace sync state -------------------------------------------

CREATE TABLE IF NOT EXISTS google_calendar_sync (
  calendar_id   TEXT PRIMARY KEY,               -- email of the user or resource calendar
  resource_id   INTEGER REFERENCES resources(id) ON DELETE CASCADE,
  sync_token    TEXT,
  channel_id    TEXT,
  channel_resource_id TEXT,
  channel_expires_at  TEXT,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS gmail_watch (
  email          TEXT PRIMARY KEY,
  history_id     TEXT,
  expires_at     TEXT,
  resource_id    INTEGER REFERENCES resources(id) ON DELETE SET NULL,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS mail_events (
  id            INTEGER PRIMARY KEY,
  gmail_user    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  thread_id     TEXT,
  from_addr     TEXT,
  to_addr       TEXT,
  subject       TEXT,
  received_at   TEXT,
  triage        TEXT,                           -- JSON TriageResult
  action        TEXT,                           -- what DeLorean did: intake:12, hours:3, flagged, ignored
  intake_id     INTEGER REFERENCES intakes(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','handled','flagged','ignored','failed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (gmail_user, message_id)
);
