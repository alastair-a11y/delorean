import type { DatabaseSync } from 'node:sqlite';

/**
 * Seeds reference data the first time the database is created.
 * Departments mirror the Xero "Department" tracking category and the
 * per-department revenue accounts already in the Refinery chart of accounts.
 * Demo clients/jobs/resources are only inserted when SEED_DEMO=1.
 */
export function seed(db: DatabaseSync) {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM departments').get() as { n: number }).n;
  if (count > 0) return;

  const departments: [string, string, string | null, string][] = [
    // name, colour, xero revenue account, xero tracking option
    ['VFX',                 '#7c3aed', '993', 'VFX'],
    ['Colour / Online',     '#f59e0b', '995', 'Colour / Online'],
    ['Editorial',           '#2563eb', '994', 'Editorial'],
    ['Audio / Sound',       '#10b981', '997', 'Audio / Sound'],
    ['Flame',               '#ef4444', '986', 'Flame'],
    ['Dailies / On-Set',    '#0ea5e9', '991', 'Dailies / On-Set'],
    ['QC / Deliverables',   '#64748b', '989', 'QC / Deliverables'],
    ['Producers / Facility','#d946ef', '998', 'Producers / Facility'],
    ['Features / Television','#0f766e', '200', 'Features / Television'],
    ['IT / Engineering',    '#78716c', null,  'IT / Engineering'],
    ['Shared Services',     '#a3a3a3', null,  'Shared Services'],
  ];
  const insDept = db.prepare(
    'INSERT INTO departments(name, colour, xero_revenue_account, xero_tracking_option, sort_order) VALUES (?, ?, ?, ?, ?)');
  departments.forEach((d, i) => insDept.run(d[0], d[1], d[2], d[3], i));

  const settings: [string, string][] = [
    ['company_name', 'The Refinery'],
    ['legal_name', 'Searle Street Post Production (Pty) Ltd t/a The Refinery'],
    ['base_currency', 'ZAR'],
    ['tax_rate', '15'],
    ['next_job_number', '1600'],
    ['default_payment_terms', '30'],
    ['timezone', 'Africa/Johannesburg'],
    ['xero_dept_tracking_name', 'Department'],
    ['xero_job_tracking_name', 'Job Number'],
    ['xero_default_revenue_account', '200'],
    ['xero_stock_account', '899'],
    ['working_day_start', '09:00'],
    ['working_day_end', '18:00'],
  ];
  const insSetting = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)');
  settings.forEach(([k, v]) => insSetting.run(k, v));

  const deptId = (name: string) =>
    (db.prepare('SELECT id FROM departments WHERE name = ?').get(name) as { id: number }).id;

  // Rate card: seeded from line items that already appear on Refinery invoices.
  const rate: [string, string, string, number, string, string][] = [
    // code, description, unit, price, dept, account
    ['DL-TEST',   'Pre Tests / Workflow (includes all machinery and operator)', 'day',  22000, 'Dailies / On-Set', '991'],
    ['DL-OFF',    'Dailies Offloads',                                           'day',  2000,  'Dailies / On-Set', '991'],
    ['DL-OP',     'Dailies Operator',                                           'week', 15000, 'Dailies / On-Set', '991'],
    ['DL-SYS1',   'Dailies processing / System (Resolve + Avid)',               'week', 18000, 'Dailies / On-Set', '991'],
    ['DL-STOR',   'Temp working storage',                                       'week', 5000,  'Dailies / On-Set', '991'],
    ['DL-OLED',   'Sony OLED Monitor',                                          'week', 3000,  'Dailies / On-Set', '991'],
    ['DL-SYS2',   'Dailies System 2 (connected to internet for uploads)',       'week', 2000,  'Dailies / On-Set', '991'],
    ['DL-LTO',    'Dailies System 3 - LTO 9 Master & Clone Decks',              'week', 20000, 'Dailies / On-Set', '991'],
    ['DL-UPGB',   'Upload editorial proxies to editor',                         'gb',   150,   'Dailies / On-Set', '991'],
    ['LTO-STOCK', 'LTO Master & Clone stock',                                   'unit', 3000,  'QC / Deliverables', '899'],
    ['COL-SDR',   'Colour Correction SDR',                                      'day',  25000, 'Colour / Online', '995'],
    ['COL-HDR',   'Colour Correction HDR',                                      'day',  30000, 'Colour / Online', '995'],
    ['COL-FIX',   'Approval & Fixes',                                           'day',  22500, 'Colour / Online', '995'],
    ['QC-WIP',    'WIP renders',                                                'unit', 1875,  'QC / Deliverables', '989'],
    ['QC-4K',     '4K Final Render SDR',                                        'unit', 9375,  'QC / Deliverables', '989'],
    ['ED-SUITE',  'Edit Suite Dry Hire (Avid, incl. storage)',                  'week', 25000, 'Editorial', '994'],
    ['ED-ASST',   'Assistant Editor',                                           'week', 18000, 'Editorial', '994'],
    ['FL-OP',     'Flame Artist & Suite',                                       'day',  28000, 'Flame', '986'],
    ['VFX-COMP',  'VFX Compositor',                                             'day',  12000, 'VFX', '993'],
    ['VFX-SUP',   'VFX Supervisor',                                             'day',  18000, 'VFX', '993'],
    ['AU-MIX',    'Final Mix (5.1 / stereo)',                                   'day',  20000, 'Audio / Sound', '997'],
    ['AU-SD',     'Sound Design',                                               'day',  14000, 'Audio / Sound', '997'],
    ['FAC-SUITE', 'Suite Dry Hire',                                             'day',  6000,  'Producers / Facility', '998'],
    ['DRIVE',     'Travel drives (SSD)',                                        'unit', 7500,  'QC / Deliverables', '899'],
  ];
  const insRate = db.prepare(
    'INSERT INTO rate_card_items(code, description, unit, unit_price, currency, department_id, xero_account_code, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  rate.forEach((r, i) => insRate.run(r[0], r[1], r[2], r[3], 'ZAR', deptId(r[4]), r[5], i));

  if (process.env.SEED_DEMO !== '1') return;
  seedDemo(db, deptId);
}

function seedDemo(db: DatabaseSync, deptId: (n: string) => number) {
  const insRes = db.prepare(
    'INSERT INTO resources(name, type, department_id, role, is_freelancer, cost_day_rate, charge_day_rate, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const resources: [string, 'person' | 'room' | 'kit', string, string, number, number | null, number | null][] = [
    ['Grade Suite 1 (Baselight)', 'room', 'Colour / Online', 'Grade suite', 0, null, 25000],
    ['Grade Suite 2 (Resolve)',   'room', 'Colour / Online', 'Grade suite', 0, null, 18000],
    ['Flame Suite',               'room', 'Flame',           'Flame suite', 0, null, 28000],
    ['Edit 1',                    'room', 'Editorial',       'Avid suite',  0, null, 5000],
    ['Edit 2',                    'room', 'Editorial',       'Avid suite',  0, null, 5000],
    ['Edit 3',                    'room', 'Editorial',       'Avid suite',  0, null, 5000],
    ['Mix Theatre',               'room', 'Audio / Sound',   'Dolby 5.1',   0, null, 20000],
    ['Dailies System 1',          'kit',  'Dailies / On-Set','Resolve + Avid', 0, null, 18000],
    ['Dailies System 2',          'kit',  'Dailies / On-Set','Upload system', 0, null, 2000],
    ['LTO-9 Deck A',              'kit',  'Dailies / On-Set','LTO deck',    0, null, 10000],
    ['Sony OLED A',               'kit',  'Dailies / On-Set','Monitor',     0, null, 3000],
    ['Thandi M.',                 'person','Colour / Online','Senior Colourist', 0, null, 25000],
    ['Pieter v.d.M.',             'person','Flame',          'Flame Artist', 0, null, 28000],
    ['Naledi K.',                 'person','Editorial',      'Editor',       1, 4500, 9000],
    ['Jonas R.',                  'person','Editorial',      'Assistant Editor', 0, null, 3600],
    ['Sipho D.',                  'person','Audio / Sound',  'Re-recording Mixer', 0, null, 20000],
    ['Lerato N.',                 'person','VFX',            'VFX Supervisor', 0, null, 18000],
    ['Chris B.',                  'person','VFX',            'Compositor',   1, 5500, 12000],
    ['Ayesha P.',                 'person','Dailies / On-Set','Dailies Operator', 1, 2800, 3000],
    ['Mike T.',                   'person','QC / Deliverables','QC / Deliverables', 0, null, 6000],
  ];
  resources.forEach((r, i) => insRes.run(r[0], r[1], deptId(r[2]), r[3], r[4], r[5], r[6], i));

  const insClient = db.prepare('INSERT INTO clients(name, contact_name, email, currency) VALUES (?, ?, ?, ?)');
  const clients: [string, string, string, string][] = [
    ['FA Angel (Pty) Ltd', 'Production Office', 'accounts@example.com', 'ZAR'],
    ['BIA 28 Productions (RF) (Pty) Ltd', 'Post Supervisor', 'post@example.com', 'ZAR'],
    ['Ogilvy Cape Town', 'Agency Producer', 'producer@example.com', 'ZAR'],
    ['Northlight Pictures Ltd', 'Head of Post', 'post@example.co.uk', 'GBP'],
  ];
  clients.forEach(c => insClient.run(...c));

  const insJob = db.prepare(
    'INSERT INTO jobs(job_number, title, client_id, department_id, status, kind, currency, po_number, producer, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const today = new Date();
  const d = (offset: number) => {
    const x = new Date(today); x.setDate(x.getDate() + offset);
    return x.toISOString().slice(0, 10);
  };
  insJob.run(1600, 'Angel in the Rubble', 1, deptId('Colour / Online'), 'in_progress', 'Feature', 'ZAR', null, 'Alastair', d(-3), d(12));
  insJob.run(1601, 'Changing Gears S2 - Dailies', 2, deptId('Dailies / On-Set'), 'confirmed', 'Series', 'ZAR', 'PO# 00412', 'Alastair', d(2), d(40));
  insJob.run(1602, 'Lindt Lindor 30s - Flame', 3, deptId('Flame'), 'quoted', 'TVC', 'ZAR', null, null, d(5), d(7));
  insJob.run(1603, 'Northlight - VFX Shots', 4, deptId('VFX'), 'in_progress', 'Series', 'GBP', 'NL-2026-18', null, d(-10), d(20));
  db.prepare("UPDATE settings SET value = '1604' WHERE key = 'next_job_number'").run();

  const resId = (name: string) => (db.prepare('SELECT id FROM resources WHERE name = ?').get(name) as { id: number }).id;
  const insBooking = db.prepare(
    'INSERT INTO bookings(job_id, resource_id, starts_at, ends_at, status, title) VALUES (?, ?, ?, ?, ?, ?)');
  const day = (offset: number, from = '09:00', to = '18:00') => [`${d(offset)}T${from}`, `${d(offset)}T${to}`];
  for (let i = 0; i < 5; i++) {
    const wd = new Date(today); wd.setDate(wd.getDate() + i);
    if (wd.getDay() === 0 || wd.getDay() === 6) continue;
    insBooking.run(1, resId('Grade Suite 1 (Baselight)'), ...day(i), 'confirmed', `Grade day ${i + 1}`);
    insBooking.run(1, resId('Thandi M.'), ...day(i), 'confirmed', `Grade day ${i + 1}`);
  }
  insBooking.run(3, resId('Flame Suite'), ...day(5), 'pencil', 'Flame day 1');
  insBooking.run(3, resId('Pieter v.d.M.'), ...day(5), 'pencil', 'Flame day 1');
  insBooking.run(3, resId('Flame Suite'), ...day(6), 'pencil', 'Flame day 2');
  insBooking.run(3, resId('Pieter v.d.M.'), ...day(6), 'pencil', 'Flame day 2');
  for (let i = 2; i < 12; i++) {
    insBooking.run(2, resId('Dailies System 1'), ...day(i, '07:00', '22:00'), 'confirmed', 'Dailies');
    insBooking.run(2, resId('Ayesha P.'), ...day(i, '07:00', '22:00'), 'confirmed', 'Dailies');
  }
  for (let i = -2; i < 8; i++) {
    insBooking.run(4, resId('Chris B.'), ...day(i), 'confirmed', 'Comp');
    insBooking.run(4, resId('Lerato N.'), ...day(i, '09:00', '13:00'), 'confirmed', 'Sup review');
  }

  // A quote + first milestone invoice on the feature grade, matching the real invoice shape.
  db.prepare("INSERT INTO quotes(job_id, number, title, currency, tax_rate, status) VALUES (1, 'Q-1600-1', 'Picture & Sound Post', 'ZAR', 15, 'approved')").run();
  const ql = db.prepare('INSERT INTO quote_lines(quote_id, sort_order, kind, description, quantity, unit, unit_price, xero_account_code) VALUES (1, ?, ?, ?, ?, ?, ?, ?)');
  const lines: [string, string, number | null, string | null, number | null, string | null][] = [
    ['heading', 'SDR COLOUR CORRECTION', null, null, null, null],
    ['line', 'Colour Correction SDR per day', 10, 'day', 25000, '995'],
    ['line', 'Approval & Fixes', 1, 'day', 22500, '995'],
    ['line', 'SDR WIP renders', 4, 'unit', 1875, '989'],
    ['line', '4K Final Render SDR per unit', 2, 'unit', 9375, '989'],
    ['separator', '', null, null, null, null],
    ['heading', 'SOUND', null, null, null, null],
    ['line', 'Final Mix (5.1 / stereo)', 5, 'day', 20000, '997'],
  ];
  lines.forEach((l, i) => ql.run(i, ...l));
}
