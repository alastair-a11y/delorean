/** No-login hours page behind the magic link in each nudge. */
import { Hono } from 'hono';
import { nudgeByToken, handleHoursReply } from '../bots/nudges.ts';
import { all } from '../db.ts';

export const magic = new Hono();

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#111}
h1{font-size:20px}button{font:inherit;padding:10px 16px;border:0;border-radius:8px;background:#111;color:#fff}input,textarea{font:inherit;width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
.ok{background:#e8f7ee;padding:12px;border-radius:8px}.job{padding:8px 0;border-bottom:1px solid #eee}</style></head><body>${body}</body></html>`;

magic.get('/t/:token', c => {
  const n = nudgeByToken(c.req.param('token'));
  if (!n) return c.html(page('DeLorean', '<h1>Link expired</h1><p>Ask DeLorean for a new one.</p>'), 404);
  const jobs = all<{ job_number: number; title: string; starts_at: string; ends_at: string }>(
    `SELECT j.job_number, j.title, b.starts_at, b.ends_at FROM bookings b JOIN jobs j ON j.id = b.job_id
      WHERE b.resource_id = ? AND b.status <> 'cancelled' AND substr(b.starts_at,1,10) <= ? AND substr(b.ends_at,1,10) >= ?`, n.resource_id, n.work_date, n.work_date);
  const answered = n.status === 'answered' ? '<p class="ok">Already logged for this day. You can add more below.</p>' : '';
  return c.html(page('Your hours', `<h1>Hi ${n.name.split(' ')[0]}, hours for ${n.work_date}</h1>${answered}
    ${jobs.map(j => `<div class="job"><b>JN ${j.job_number}</b> ${j.title}<br><small>${j.starts_at.slice(11)}–${j.ends_at.slice(11)}</small></div>`).join('') || '<p>No bookings found for that day.</p>'}
    <form method="post"><p><textarea name="text" rows="3" placeholder='e.g. "8" or "6 on ${jobs[0]?.job_number ?? '1600'}, 2 on the other"'></textarea></p><button>Log hours</button></form>`));
});

magic.post('/t/:token', async c => {
  const n = nudgeByToken(c.req.param('token'));
  if (!n) return c.html(page('DeLorean', '<h1>Link expired</h1>'), 404);
  const form = await c.req.parseBody();
  const text = String(form.text ?? '').trim();
  if (!text) return c.redirect(`/t/${c.req.param('token')}`);
  const r = await handleHoursReply(n.resource_id, text, { token: c.req.param('token'), source: 'link' });
  return c.html(page('Thanks', `<h1>${r.ok ? 'Logged' : 'Hmm'}</h1><p class="${r.ok ? 'ok' : ''}">${r.reply}</p><p><a href="/t/${c.req.param('token')}">Back</a></p>`));
});
