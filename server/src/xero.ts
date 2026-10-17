/**
 * Xero adapter. OAuth2 authorization-code flow + the handful of Accounting API
 * calls DeLorean needs: contacts, tracking categories/options, invoices.
 *
 * Env: XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI (default http://localhost:8787/api/xero/callback)
 */
import { randomBytes } from 'node:crypto';
import { get, run, setting, logActivity } from './db.ts';
import { HttpError } from './http.ts';

const AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const API = 'https://api.xero.com/api.xro/2.0';
const SCOPES = 'openid profile email offline_access accounting.transactions accounting.contacts accounting.settings';

interface Connection {
  tenant_id: string | null; tenant_name: string | null; access_token: string | null; refresh_token: string | null;
  expires_at: string | null; dept_tracking_category_id: string | null; job_tracking_category_id: string | null;
}

const pendingStates = new Set<string>();

export function xeroConfigured() {
  return Boolean(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET);
}
export function xeroConnection(): Connection | undefined {
  return get<Connection>('SELECT * FROM xero_connection WHERE id = 1');
}
export function xeroStatus() {
  const conn = xeroConnection();
  return {
    configured: xeroConfigured(),
    connected: Boolean(conn?.refresh_token && conn?.tenant_id),
    tenant_name: conn?.tenant_name ?? null,
    expires_at: conn?.expires_at ?? null,
    tracking: { department: conn?.dept_tracking_category_id ?? null, job_number: conn?.job_tracking_category_id ?? null },
  };
}

export function authorizeUrl() {
  if (!xeroConfigured()) throw new HttpError(400, 'Set XERO_CLIENT_ID and XERO_CLIENT_SECRET first');
  const state = randomBytes(16).toString('hex');
  pendingStates.add(state);
  const p = new URLSearchParams({
    response_type: 'code', client_id: process.env.XERO_CLIENT_ID!, redirect_uri: redirectUri(), scope: SCOPES, state,
  });
  return `${AUTH_URL}?${p}`;
}
function redirectUri() { return process.env.XERO_REDIRECT_URI ?? 'http://localhost:8787/api/xero/callback'; }

async function tokenRequest(params: Record<string, string>) {
  const basic = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new HttpError(502, `Xero token request failed (${res.status})`, await res.text());
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

function saveTokens(t: { access_token: string; refresh_token: string; expires_in: number }, extra: Partial<Connection> = {}) {
  const expires = new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString();
  run(`INSERT INTO xero_connection(id, access_token, refresh_token, expires_at, scopes, tenant_id, tenant_name)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at, tenant_id = COALESCE(excluded.tenant_id, xero_connection.tenant_id),
         tenant_name = COALESCE(excluded.tenant_name, xero_connection.tenant_name), updated_at = datetime('now')`,
    t.access_token, t.refresh_token, expires, SCOPES, extra.tenant_id ?? null, extra.tenant_name ?? null);
}

export async function handleCallback(code: string, state: string) {
  if (!pendingStates.delete(state)) throw new HttpError(400, 'Unknown OAuth state');
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  const conns = await (await fetch('https://api.xero.com/connections', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).json() as { tenantId: string; tenantName: string }[];
  const first = conns[0];
  if (!first) throw new HttpError(400, 'No Xero organisation was authorised');
  saveTokens(tokens, { tenant_id: first.tenantId, tenant_name: first.tenantName });
  await ensureTrackingCategories();
  logActivity('xero', null, 'connect', { tenant: first.tenantName });
}

export function disconnect() {
  run('DELETE FROM xero_connection WHERE id = 1');
}

async function accessToken(): Promise<string> {
  const conn = xeroConnection();
  if (!conn?.refresh_token) throw new HttpError(409, 'Xero is not connected. Open Settings → Xero and connect.');
  if (conn.access_token && conn.expires_at && new Date(conn.expires_at) > new Date()) return conn.access_token;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: conn.refresh_token });
  saveTokens(t);
  return t.access_token;
}

export async function xeroFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken();
  const tenant = xeroConnection()!.tenant_id!;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Xero-Tenant-Id': tenant, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `Xero ${init.method ?? 'GET'} ${path} failed (${res.status})`, safeJson(text));
  return safeJson(text) as T;
}
function safeJson(t: string) { try { return JSON.parse(t); } catch { return t; } }

/** Look up (and cache) the IDs of the "Department" and "Job Number" tracking categories. */
export async function ensureTrackingCategories() {
  const data = await xeroFetch<{ TrackingCategories: { TrackingCategoryID: string; Name: string; Options: { TrackingOptionID: string; Name: string; Status: string }[] }[] }>('/TrackingCategories');
  const deptName = setting('xero_dept_tracking_name') ?? 'Department';
  const jobName = setting('xero_job_tracking_name') ?? 'Job Number';
  const dept = data.TrackingCategories.find(t => t.Name === deptName);
  const job = data.TrackingCategories.find(t => t.Name === jobName);
  run('UPDATE xero_connection SET dept_tracking_category_id = ?, job_tracking_category_id = ? WHERE id = 1', dept?.TrackingCategoryID ?? null, job?.TrackingCategoryID ?? null);
  return { dept, job };
}

/** Xero needs every JN to exist as an option under "Job Number" before it can be used on a line. */
export async function ensureJobNumberOption(jobNumber: number) {
  const conn = xeroConnection();
  let catId = conn?.job_tracking_category_id;
  if (!catId) catId = (await ensureTrackingCategories()).job?.TrackingCategoryID;
  if (!catId) throw new HttpError(409, 'Xero has no "Job Number" tracking category');
  const cat = await xeroFetch<{ TrackingCategories: { Options: { Name: string; Status: string }[] }[] }>(`/TrackingCategories/${catId}`);
  const exists = cat.TrackingCategories[0]?.Options.some(o => o.Name === String(jobNumber) && o.Status === 'ACTIVE');
  if (exists) return;
  await xeroFetch(`/TrackingCategories/${catId}/Options`, { method: 'PUT', body: JSON.stringify({ Name: String(jobNumber) }) });
  run('INSERT INTO sync_log(entity, entity_id, action, ok, detail) VALUES (?, ?, ?, 1, ?)', 'tracking', jobNumber, 'create_option', String(jobNumber));
}

/** Find or create the Xero contact for a client, storing the ContactID locally. */
export async function ensureContact(clientId: number): Promise<string> {
  const client = get<{ id: number; name: string; email: string | null; contact_name: string | null; xero_contact_id: string | null; vat_number: string | null }>('SELECT * FROM clients WHERE id = ?', clientId);
  if (!client) throw new HttpError(404, 'Client not found');
  if (client.xero_contact_id) return client.xero_contact_id;
  const found = await xeroFetch<{ Contacts: { ContactID: string; Name: string }[] }>(`/Contacts?where=${encodeURIComponent(`Name=="${client.name.replace(/"/g, '\\"')}"`)}`);
  let id = found.Contacts?.[0]?.ContactID;
  if (!id) {
    const [first, ...rest] = (client.contact_name ?? '').split(' ');
    const created = await xeroFetch<{ Contacts: { ContactID: string }[] }>('/Contacts', {
      method: 'PUT',
      body: JSON.stringify({ Contacts: [{ Name: client.name, EmailAddress: client.email ?? undefined, FirstName: first || undefined, LastName: rest.join(' ') || undefined, TaxNumber: client.vat_number ?? undefined }] }),
    });
    id = created.Contacts[0].ContactID;
    run('INSERT INTO sync_log(entity, entity_id, action, ok, detail) VALUES (?, ?, ?, 1, ?)', 'contact', clientId, 'create', id);
  }
  run('UPDATE clients SET xero_contact_id = ? WHERE id = ?', id, clientId);
  return id;
}

interface InvoiceForXero {
  id: number; job_id: number; job_number: number; job_title: string; client_id: number | null; client_name: string | null; xero_contact_id: string | null;
  currency: string; tax_rate: number; issue_date: string; due_date: string; reference: string | null; number: string;
  lines: { kind: string; description: string; quantity: number | null; unit_price: number | null; xero_account_code: string | null }[];
}

/** Pure function: the ACCREC invoice body. Headings/separators become description-only lines, as on existing Refinery invoices. */
export function buildXeroInvoicePayload(inv: InvoiceForXero, contactId?: string) {
  const job = get<{ department_id: number | null }>('SELECT department_id FROM jobs WHERE id = ?', inv.job_id);
  const dept = job?.department_id ? get<{ xero_tracking_option: string | null; xero_revenue_account: string | null }>('SELECT xero_tracking_option, xero_revenue_account FROM departments WHERE id = ?', job.department_id) : undefined;
  const defaultAccount = dept?.xero_revenue_account ?? setting('xero_default_revenue_account') ?? '200';
  const deptTrackingName = setting('xero_dept_tracking_name') ?? 'Department';
  const jobTrackingName = setting('xero_job_tracking_name') ?? 'Job Number';
  const taxType = inv.tax_rate > 0 ? 'OUTPUT3' : 'NONE'; // OUTPUT3 = SA standard-rate output VAT in this org's chart
  const LineItems = inv.lines.map(l => {
    if (l.kind !== 'line') return { Description: l.kind === 'separator' ? '//' : l.description };
    return {
      Description: l.description,
      Quantity: l.quantity ?? 0,
      UnitAmount: l.unit_price ?? 0,
      AccountCode: l.xero_account_code ?? defaultAccount,
      TaxType: taxType,
      Tracking: [
        ...(dept?.xero_tracking_option ? [{ Name: deptTrackingName, Option: dept.xero_tracking_option }] : []),
        { Name: jobTrackingName, Option: String(inv.job_number) },
      ],
    };
  });
  return {
    Type: 'ACCREC',
    Contact: contactId ? { ContactID: contactId } : inv.xero_contact_id ? { ContactID: inv.xero_contact_id } : { Name: inv.client_name ?? 'Unknown' },
    Date: inv.issue_date,
    DueDate: inv.due_date,
    Reference: inv.reference ?? undefined,
    CurrencyCode: inv.currency,
    LineAmountTypes: 'Exclusive',
    Status: 'DRAFT',
    LineItems,
  };
}

export async function pushInvoice(inv: InvoiceForXero) {
  if (!inv.client_id) throw new HttpError(400, 'Job has no client; set one before pushing to Xero');
  try {
    const contactId = await ensureContact(inv.client_id);
    await ensureJobNumberOption(inv.job_number);
    const payload = buildXeroInvoicePayload(inv, contactId);
    const res = await xeroFetch<{ Invoices: { InvoiceID: string; InvoiceNumber: string; Status: string; AmountDue: number }[] }>('/Invoices', { method: 'PUT', body: JSON.stringify({ Invoices: [payload] }) });
    const x = res.Invoices[0];
    run(`UPDATE invoices SET status = 'pushed', xero_invoice_id = ?, xero_invoice_number = ?, xero_status = ?, amount_due = ?, pushed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      x.InvoiceID, x.InvoiceNumber, x.Status, x.AmountDue, inv.id);
    run("UPDATE jobs SET status = 'invoiced', updated_at = datetime('now') WHERE id = ? AND status IN ('delivered')", inv.job_id);
    run('INSERT INTO sync_log(entity, entity_id, action, ok, detail) VALUES (?, ?, ?, 1, ?)', 'invoice', inv.id, 'push', x.InvoiceNumber);
    logActivity('job', inv.job_id, 'invoice.pushed', { invoice_id: inv.id, xero: x.InvoiceNumber });
    return x;
  } catch (e) {
    run('INSERT INTO sync_log(entity, entity_id, action, ok, detail) VALUES (?, ?, ?, 0, ?)', 'invoice', inv.id, 'push', String((e as Error).message));
    throw e;
  }
}

export async function refreshInvoiceStatus(inv: { id: number; xero_invoice_id: string | null }) {
  if (!inv.xero_invoice_id) throw new HttpError(409, 'Invoice has not been pushed to Xero');
  const res = await xeroFetch<{ Invoices: { Status: string; AmountDue: number; InvoiceNumber: string }[] }>(`/Invoices/${inv.xero_invoice_id}`);
  const x = res.Invoices[0];
  const paid = x.Status === 'PAID';
  run(`UPDATE invoices SET xero_status = ?, amount_due = ?, xero_invoice_number = ?, status = CASE WHEN ? THEN 'paid' WHEN ? = 'VOIDED' THEN 'void' ELSE status END, updated_at = datetime('now') WHERE id = ?`,
    x.Status, x.AmountDue, x.InvoiceNumber, paid ? 1 : 0, x.Status, inv.id);
  return x;
}

/** Refresh every pushed-but-unpaid invoice (run from the scheduler or Settings). */
export async function refreshAllOpenInvoices() {
  const open = get<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE status = 'pushed'");
  const rows = (await import('./db.ts')).all<{ id: number; xero_invoice_id: string }>("SELECT id, xero_invoice_id FROM invoices WHERE status = 'pushed' AND xero_invoice_id IS NOT NULL");
  let updated = 0;
  for (const r of rows) { try { await refreshInvoiceStatus(r); updated++; } catch { /* keep going */ } }
  return { open: open?.n ?? 0, updated };
}
