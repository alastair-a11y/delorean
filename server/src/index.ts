import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { app } from './app.ts';
import { assistant } from './routes/assistant.ts';
import { google } from './routes/google.ts';
import { magic } from './routes/magic.ts';
import { startScheduler } from './bots/scheduler.ts';
import { aiConfigured } from './ai/client.ts';
import { googleStatus } from './google/auth.ts';
import { xeroStatus } from './xero.ts';

const here = dirname(fileURLToPath(import.meta.url));
openDb();

app.route('/api/assistant', assistant);
app.route('/api/google', google);
app.route('/', magic);

// Serve the built web app in production (web/dist); in dev, Vite proxies /api to us.
const dist = join(here, '..', '..', 'web', 'dist');
if (existsSync(dist)) {
  app.use('/*', serveStatic({ root: dist, rewriteRequestPath: p => p }));
  app.get('*', c => c.html(readFileSync(join(dist, 'index.html'), 'utf8')));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`DeLorean on http://localhost:${port}`);
  console.log(`  Claude: ${aiConfigured() ? 'ready' : 'NOT configured (set ANTHROPIC_API_KEY)'}`);
  console.log(`  Google: ${googleStatus().configured ? `service account ${googleStatus().service_account}` : 'not configured'}`);
  console.log(`  Xero:   ${xeroStatus().connected ? `connected to ${xeroStatus().tenant_name}` : xeroStatus().configured ? 'configured, not connected' : 'not configured'}`);
  if (process.env.DELOREAN_SCHEDULER !== '0') startScheduler();
});
