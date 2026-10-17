import { Hono } from 'hono';
import { all, get } from '../db.ts';

export const reports = new Hono();

function range(c: any) {
  const today = new Date();
  const from = c.req.query('from') ?? new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const to = c.req.query('to') ?? new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { from, to };
}

/** Booked days per resource in a window, split pencil/confirmed, with logged hours. */
reports.get('/utilisation', c => {
  const { from, to } = range(c);
  return c.json({ from, to, rows: all(
    `SELECT r.id, r.name, r.type, d.name AS department,
            SUM(CASE WHEN b.status = 'confirmed' THEN MAX(1, ROUND(julianday(b.ends_at) - julianday(b.starts_at))) ELSE 0 END) AS confirmed_days,
            SUM(CASE WHEN b.status = 'pencil' THEN MAX(1, ROUND(julianday(b.ends_at) - julianday(b.starts_at))) ELSE 0 END) AS pencil_days,
            (SELECT COALESCE(SUM(hours), 0) FROM timesheets t WHERE t.resource_id = r.id AND t.work_date BETWEEN ? AND ?) AS logged_hours
       FROM resources r LEFT JOIN departments d ON d.id = r.department_id
       LEFT JOIN bookings b ON b.resource_id = r.id AND b.status <> 'cancelled' AND substr(b.starts_at,1,10) <= ? AND substr(b.ends_at,1,10) >= ?
      WHERE r.active = 1 GROUP BY r.id ORDER BY r.type, d.sort_order, r.name`, from, to, to, from) });
});

/** Work in progress: confirmed/in-progress jobs with approved quote value vs invoiced to date. */
reports.get('/wip', c => c.json(all(
  `SELECT j.id, j.job_number, j.title, j.status, j.currency, c.name AS client_name,
          (SELECT COALESCE(SUM(ql.quantity * ql.unit_price), 0) FROM quotes q JOIN quote_lines ql ON ql.quote_id = q.id WHERE q.job_id = j.id AND q.status = 'approved' AND ql.kind = 'line') AS approved_net,
          (SELECT COALESCE(SUM(il.quantity * il.unit_price), 0) FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id WHERE i.job_id = j.id AND i.status <> 'void' AND il.kind = 'line') AS invoiced_net,
          (SELECT COALESCE(SUM(hours), 0) FROM timesheets t WHERE t.job_id = j.id) AS hours_logged,
          (SELECT COALESCE(SUM(r.cost_day_rate * MAX(1, ROUND(julianday(b.ends_at) - julianday(b.starts_at)))), 0) FROM bookings b JOIN resources r ON r.id = b.resource_id WHERE b.job_id = j.id AND b.status = 'confirmed' AND r.cost_day_rate IS NOT NULL) AS freelancer_cost
     FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
    WHERE j.status IN ('confirmed','in_progress','delivered','invoiced') ORDER BY j.job_number DESC`)));

/** Dashboard numbers for the home screen. */
reports.get('/today', c => {
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10);
  const booked = all(
    `SELECT b.id, b.starts_at, b.ends_at, b.status, b.title, r.name AS resource_name, r.type AS resource_type, j.job_number, j.title AS job_title, d.colour
       FROM bookings b JOIN resources r ON r.id = b.resource_id LEFT JOIN jobs j ON j.id = b.job_id LEFT JOIN departments d ON d.id = j.department_id
      WHERE b.status <> 'cancelled' AND substr(b.starts_at,1,10) <= ? AND substr(b.ends_at,1,10) >= ? ORDER BY r.type, r.name`, date, date);
  const counts = get(
    `SELECT (SELECT COUNT(*) FROM jobs WHERE status IN ('confirmed','in_progress')) AS live_jobs,
            (SELECT COUNT(*) FROM jobs WHERE status IN ('enquiry','quoted')) AS pipeline_jobs,
            (SELECT COUNT(*) FROM invoices WHERE status = 'draft') AS draft_invoices,
            (SELECT COUNT(*) FROM invoices WHERE status = 'pushed') AS awaiting_payment,
            (SELECT COUNT(*) FROM intakes WHERE status = 'proposed') AS pending_intakes,
            (SELECT COUNT(*) FROM nudges WHERE status = 'sent') AS unanswered_nudges`);
  return c.json({ date, booked, ...counts });
});
