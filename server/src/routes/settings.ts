import { Hono } from 'hono';
import { z } from 'zod';
import { all, setSetting } from '../db.ts';
import { body } from '../http.ts';
import { xeroStatus, authorizeUrl, handleCallback, disconnect, ensureTrackingCategories, refreshAllOpenInvoices } from '../xero.ts';
import { googleStatus } from '../google/auth.ts';

export const settingsRoutes = new Hono();

const EDITABLE = ['company_name', 'legal_name', 'base_currency', 'tax_rate', 'next_job_number', 'default_payment_terms', 'timezone',
  'working_day_start', 'working_day_end', 'nudge_time', 'nudge_channel', 'google_domain', 'google_chat_space', 'auto_calendar_sync',
  'mail_autopilot', 'xero_default_revenue_account', 'xero_stock_account'];

settingsRoutes.get('/', c => {
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key');
  return c.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])), editable: EDITABLE, xero: xeroStatus(), google: googleStatus(),
    claude: { configured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), model: process.env.DELOREAN_MODEL ?? 'claude-opus-5-5' } });
});

settingsRoutes.patch('/', async c => {
  const d = await body(c, z.record(z.string(), z.string()));
  for (const [k, v] of Object.entries(d)) if (EDITABLE.includes(k)) setSetting(k, v);
  return c.json({ ok: true });
});

// ---- Xero connection -------------------------------------------------------
settingsRoutes.get('/xero', c => c.json(xeroStatus()));
settingsRoutes.get('/xero/connect', c => c.redirect(authorizeUrl()));
settingsRoutes.get('/xero/callback', async c => {
  await handleCallback(c.req.query('code') ?? '', c.req.query('state') ?? '');
  return c.redirect('/settings?xero=connected');
});
settingsRoutes.post('/xero/disconnect', c => { disconnect(); return c.json({ ok: true }); });
settingsRoutes.post('/xero/sync-tracking', async c => c.json(await ensureTrackingCategories()));
settingsRoutes.post('/xero/refresh-invoices', async c => c.json(await refreshAllOpenInvoices()));
