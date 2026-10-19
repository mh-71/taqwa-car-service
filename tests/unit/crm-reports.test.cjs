/* crm-reports — Customer CRM › CRM Reports, connected to the database.

   Drives the REAL js/crm-reports.js (with the real api.js, storage.js and
   utils.js) through the shared harness, against a fake API.

     1. Periods: Last 7 / Last 30 / This month / Custom, inclusive, Dhaka
        midnight, impossible dates, From after To, at most 366 days.
     2. Figures: the reminder snapshot (never historical), Open / Completed /
        Cancelled follow-ups, completion by closedAt in Dhaka, returning
        customers (distinct, Completed / Delivered only, owner changes,
        several vehicles, malformed dates, duplicated records).
     3. Chart: daily vs weekly buckets, open-at-end reconstruction, nothing
        after today, follow-up series absent when follow-ups failed.
     4. Rows, search, status filters and pagination (0 / 25 / 26).
     5. CSV: quoting, newlines, Bengali + BOM, formula neutralisation, only
        the filtered rows, no phone numbers, no file for no rows.
     6. The page: loading, connected, cards independent of the list,
        period changes reset the page, escaping, follow-ups failure with the
        other figures still shown, no backend, signed out, no demo data. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

function page({ origin = 'http://localhost:8787', fetch, seedDemo = false } = {}) {
  const downloads = [];
  const h = boot({
    origin, fetch, modules: ['js/crm-reports.js'],
    beforeModules(doc, ctx) {
      // A download is an <a download> clicked once; record it instead.
      const make = doc.createElement;
      doc.createElement = tag => { const el = make(tag); el.click = () => downloads.push({ name: el.download, href: el.href }); return el; };
      ctx.Blob = class { constructor(parts, opts) { this.text = parts.join(''); this.type = opts && opts.type; } };
      ctx.URL = { createObjectURL: b => { downloads.blobs = (downloads.blobs || []).concat(b); return 'blob:x'; }, revokeObjectURL() {} };
    },
  });
  vm.runInContext('globalThis.CrmReports = CrmReports;', h.ctx);
  if (seedDemo) {
    h.ctx.localStorage.setItem('taqwa_followUps', JSON.stringify([{ id: 'FUP-9999', customerId: 'CUS-0001', reason: 'DEMO ROW', status: 'Open', dueDate: '2026-10-10', createdAt: '2026-10-01T00:00:00.000Z' }]));
    h.ctx.localStorage.setItem('taqwa_jobCards', JSON.stringify([{ id: 'JOB-9999', customerId: 'CUS-0001', vehicleId: 'VEH-0001', status: 'Completed', date: '2026-10-10' }]));
  }
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, R: h.ctx.CrmReports, downloads };
}

(async () => {
console.log('=== crm-reports: CRM Reports ===\n');
const { R } = page({ origin: '' });
const TODAY = '2026-10-19';
const P = (from, to) => ({ from, to, days: 0 });

/* ---------- 1. periods ---------- */
console.log('-- 1. periods --');
{
  check('17:59:59Z is still the same Dhaka day', R.dhakaToday(new Date('2026-10-18T17:59:59Z')), '2026-10-18');
  check('18:00:00Z is already the next Dhaka day', R.dhakaToday(new Date('2026-10-18T18:00:00Z')), '2026-10-19');
  const p7 = R.resolvePeriod('last7', TODAY);
  check('Last 7 days = today and the six days before (inclusive)', [p7.from, p7.to, p7.days], ['2026-10-13', TODAY, 7]);
  const p30 = R.resolvePeriod('last30', TODAY);
  check('Last 30 days = today and the 29 days before', [p30.from, p30.to, p30.days], ['2026-09-20', TODAY, 30]);
  const pm = R.resolvePeriod('month', TODAY);
  check('This month = the 1st to today', [pm.from, pm.to, pm.days], ['2026-10-01', TODAY, 19]);
  check('   ...on the 1st it is one day', [R.resolvePeriod('month', '2026-11-01').from, R.resolvePeriod('month', '2026-11-01').days], ['2026-11-01', 1]);
  check('Last 7 days across a month and a leap day', R.resolvePeriod('last7', '2028-03-02').from, '2028-02-25');
  const c = R.resolvePeriod('custom', TODAY, '2026-10-01', '2026-10-01');
  check('Custom: one day, inclusive', [c.ok, c.days], [true, 1]);
  check('Custom: From after To is refused', [R.resolvePeriod('custom', TODAY, '2026-10-02', '2026-10-01').ok, /on or before/.test(R.resolvePeriod('custom', TODAY, '2026-10-02', '2026-10-01').error)], [false, true]);
  check('Custom: impossible dates are refused', ['2026-02-30', '2026-13-01', '20261001', ''].map(d => R.resolvePeriod('custom', TODAY, d, '2026-10-01').ok), [false, false, false, false]);
  check('Custom: 366 days allowed, 367 refused',
    [R.resolvePeriod('custom', TODAY, '2025-10-19', '2026-10-19').ok, R.resolvePeriod('custom', TODAY, '2025-10-18', '2026-10-19').ok], [true, false]);
  check('   ...the refusal says how long the range is', /367/.test(R.resolvePeriod('custom', TODAY, '2025-10-18', '2026-10-19').error), true);
  check('an unknown period kind is refused', R.resolvePeriod('year', TODAY).ok, false);
}

/* ---------- 2. figures ---------- */
console.log('\n-- 2. figures --');
{
  const veh = (id, next, status = 'Active') => ({ id, customerId: 'CUS-0001', regNo: id, nextServiceDate: next, status });
  const snap = R.reminderSnapshot([veh('V1', '2026-10-01'), veh('V2', TODAY), veh('V3', '2026-11-01'), veh('V4', '2026-10-01', 'Inactive'),
    veh('V5', ''), veh('V6', '2026-02-30'), veh('V1', '2026-10-01')], TODAY);
  check('reminders: overdue + due today among ACTIVE vehicles; inactive, blank and duplicate rows ignored', [snap.due, snap.overdue, snap.dueToday, snap.upcoming], [2, 1, 1, 1]);
  check('   ...a malformed next service date is left out and counted', snap.unreadable, 1);
  check('   ...and the snapshot is the same whatever period is chosen (it takes no period)', R.reminderSnapshot.length, 2);

  const fu = (id, status, createdAt, closedAt = null, extra = {}) => ({ id, customerId: 'CUS-0001', reason: 'r', status, dueDate: '2026-10-15', createdAt, closedAt, ...extra });
  const FUS = [
    fu('F1', 'Open', '2026-09-01T00:00:00Z'),
    fu('F2', 'Completed', '2026-09-01T00:00:00Z', '2026-10-05T10:00:00Z'),
    fu('F3', 'Completed', '2026-09-01T00:00:00Z', '2026-09-30T18:30:00Z'),   // 1 Oct in Dhaka
    fu('F4', 'Completed', '2026-09-01T00:00:00Z', '2026-09-30T17:59:59Z'),   // 30 Sep in Dhaka
    fu('F5', 'Cancelled', '2026-09-01T00:00:00Z', '2026-10-05T10:00:00Z'),
    fu('F6', 'Completed', '2026-10-05T00:00:00Z', 'garbage'),
    fu('F1', 'Open', '2026-09-01T00:00:00Z'),
  ];
  const oct = P('2026-10-01', '2026-10-31');
  const f = R.followUpFigures(FUS, oct);
  check('Open = status Open now (one, duplicates dropped)', f.open, 1);
  check('Completed in October by closedAt in Dhaka: F2, and F3 (18:30Z = 1 Oct), not F4 (17:59Z = 30 Sep)', f.completed, 2);
  check('   ...Cancelled is never completed; an unreadable closedAt is left out and counted', f.unreadable, 1);
  check('   ...createdAt is never used as the completion time', R.followUpFigures([fu('X', 'Completed', '2026-10-10T00:00:00Z', '2026-09-01T00:00:00Z')], oct).completed, 0);

  const jc = (id, customerId, date, status = 'Completed', vehicleId = 'VEH-1') => ({ id, customerId, vehicleId, date, status, mechanicId: 'MEC-1' });
  const JOBS = [
    jc('J1', 'C1', '2026-09-10'), jc('J2', 'C1', '2026-10-05'),                         // returning
    jc('J3', 'C2', '2026-10-06'), jc('J4', 'C2', '2026-10-20'),                         // two visits inside, none before: not returning
    jc('J5', 'C3', '2026-09-01', 'Cancelled'), jc('J6', 'C3', '2026-10-07'),            // earlier visit cancelled: not returning
    jc('J7', 'C4', '2026-09-01', 'In Progress'), jc('J8', 'C4', '2026-10-08'),          // earlier visit unfinished: not returning
    jc('J9', 'C5', '2026-08-01', 'Delivered', 'VEH-A'), jc('J10', 'C5', '2026-10-09', 'Completed', 'VEH-B'),
    jc('J11', 'C5', '2026-10-10', 'Delivered', 'VEH-C'),                               // several vehicles: counted once
    jc('J12', 'C6', '2026-09-01', 'Completed', 'VEH-S'), jc('J13', 'C7', '2026-10-11', 'Completed', 'VEH-S'),   // vehicle sold C6 -> C7
    jc('J14', 'C8', '2026-02-30'), jc('J15', 'C8', '2026-10-12'),                      // malformed earlier date: left out
    jc('J2', 'C1', '2026-10-05'), jc('J2', 'C1', '2026-10-05'),                         // the same job card repeated
  ];
  const r = R.returningCustomers(JOBS, oct);
  check('returning customers: C1 and C5 only, each once', r.returning, 2);
  check('   ...customers with an eligible visit in the period (C1 C2 C3 C4 C5 C7 C8)', r.withVisit, 7);
  check('   ...the sold vehicle\'s new owner is not "returning" from the old owner\'s visit', R.returningCustomers([JOBS[11], JOBS[12]], oct).returning, 0);
  check('   ...a malformed job card date is left out and counted', r.unreadable, 1);
  check('   ...an unfinished visit IN the period does not make anyone returning',
    R.returningCustomers([jc('A', 'C9', '2026-09-01'), jc('B', 'C9', '2026-10-05', 'Waiting for Parts')], oct).returning, 0);
}

/* ---------- 3. chart ---------- */
console.log('\n-- 3. chart --');
{
  check('31 days -> daily buckets; 32 -> weekly', [R.buckets({ from: '2026-10-01', to: '2026-10-31', days: 31 }).size, R.buckets({ from: '2026-10-01', to: '2026-11-01', days: 32 }).size], [1, 7]);
  const wk = R.buckets({ from: '2026-01-01', to: '2026-02-01', days: 32 }).list;
  check('weekly buckets start at the period start; the last one is shorter', [wk.length, wk[0].from, wk[0].to, wk[4].from, wk[4].to], [5, '2026-01-01', '2026-01-07', '2026-01-29', '2026-02-01']);
  const fu = (id, status, createdAt, closedAt = null) => ({ id, customerId: 'C', status, createdAt, closedAt, dueDate: '2026-10-15' });
  const s = R.chartSeries({
    followUps: [fu('A', 'Open', '2026-10-01T03:00:00Z'), fu('B', 'Completed', '2026-10-01T03:00:00Z', '2026-10-03T03:00:00Z'),
      fu('C', 'Cancelled', '2026-10-01T03:00:00Z', '2026-10-04T03:00:00Z'), fu('D', 'Open', 'nonsense')],
    jobCards: [], p: { from: '2026-10-01', to: '2026-10-05', days: 5 }, today: '2026-10-04',
  });
  check('open at the end of each day: A always, B until it is completed (3 Oct), C until it is cancelled (4 Oct); unreadable createdAt never',
    s.points.map(p => p.open), [3, 3, 2, 1, null]);
  const day = (closedAt, status = 'Cancelled') => R.chartSeries({ followUps: [fu('X', status, '2026-10-01T03:00:00Z', closedAt)], jobCards: [],
    p: { from: '2026-10-01', to: '2026-10-04', days: 4 }, today: '2026-10-04' }).points.map(p => p.open);
  check('a cancelled follow-up is open from its creation day up to the day before it was cancelled, never after', day('2026-10-03T06:00:00Z'), [1, 1, 0, 0]);
  check('   ...cancelled at 17:59:59Z = that Dhaka day; at 18:00:00Z = the next Dhaka day',
    [day('2026-10-02T17:59:59Z'), day('2026-10-02T18:00:00Z')], [[1, 0, 0, 0], [1, 1, 0, 0]]);
  check('   ...cancelled on its creation day: never open at any day end', day('2026-10-01T05:00:00Z'), [0, 0, 0, 0]);
  check('   ...a completed one follows the same rule', day('2026-10-03T06:00:00Z', 'Completed'), [1, 1, 0, 0]);
  check('   ...closed but with an unreadable close date: never counted as open', [day('not a date'), day(null)], [[0, 0, 0, 0], [0, 0, 0, 0]]);
  check('   ...still Open: open on every day from its creation', R.chartSeries({ followUps: [fu('Y', 'Open', '2026-10-02T03:00:00Z')], jobCards: [],
    p: { from: '2026-10-01', to: '2026-10-04', days: 4 }, today: '2026-10-04' }).points.map(p => p.open), [0, 1, 1, 1]);
  check('   ...and the Open card still counts only follow-ups whose status is Open now (a cancelled one never)',
    R.followUpFigures([fu('A', 'Open', '2026-10-01T03:00:00Z'), fu('C', 'Cancelled', '2026-10-01T03:00:00Z', '2026-10-09T03:00:00Z')], { from: '2026-10-01', to: '2026-10-31' }).open, 1);
  check('completed per day by closedAt', s.points.map(p => p.completed), [0, 0, 1, 0, null]);
  check('days after today are not drawn (no data, not zero)', [s.points[4].future, s.points[4].returning], [true, null]);
  const nf = R.chartSeries({ followUps: [fu('A', 'Open', '2026-10-01T03:00:00Z')], jobCards: [], p: { from: '2026-10-01', to: '2026-10-02', days: 2 }, today: '2026-10-04', followUpsOk: false });
  check('with follow-ups unavailable, their series are absent but returning customers still count', [nf.points[0].open, nf.points[0].completed, nf.points[0].returning], [null, null, 0]);
  check('reminders are never a chart series', Object.keys(s.points[0]).some(k => /remind/i.test(k)), false);
}

/* ---------- 4. rows, filters, pagination ---------- */
console.log('\n-- 4. rows, filters, pagination --');
const CUSTOMERS = [
  { id: 'CUS-0001', name: 'Rahim Uddin', phone: '+880 1712-345678', status: 'Active' },
  { id: 'CUS-0002', name: '<img src=x onerror=alert(1)>', phone: '01800000000', status: 'Active' },
  { id: 'CUS-0003', name: 'মোঃ করিম', phone: '01900000000', status: 'Active' },
];
const VEHICLES = [
  { id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHAKA-GA-1234', brand: 'Toyota', model: 'Corolla', status: 'Active' },
  { id: 'VEH-0002', customerId: 'CUS-0002', regNo: 'CTG-KHA-5678', brand: 'Honda', model: 'Civic', status: 'Active' },
];
const MECHANICS = [{ id: 'MEC-0001', name: 'Selim Mia', status: 'Active' }];
{
  const oct = { from: '2026-10-01', to: '2026-10-31', days: 31 };
  const jobs = [
    { id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: '2026-10-05', status: 'Completed' },
    { id: 'JOB-0002', customerId: 'CUS-0002', vehicleId: 'VEH-0002', mechanicId: 'MEC-0001', date: '2026-10-06', status: 'In Progress' },
    { id: 'JOB-0003', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0009', date: '2026-10-07', status: 'Cancelled' },
    { id: 'JOB-0004', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: '2026-09-30', status: 'Completed' },
    { id: 'JOB-0005', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: 'bad', status: 'Completed' },
    { id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: '2026-10-05', status: 'Completed' },
  ];
  const v = R.visitRows({ jobCards: jobs, customers: CUSTOMERS, vehicles: VEHICLES, mechanics: MECHANICS, p: oct });
  check('visits: one row per job card dated in the period, newest first (outside, malformed and repeated left out)', v.rows.map(r => r.id), ['JOB-0003', 'JOB-0002', 'JOB-0001']);
  check('   ...a malformed date is counted, not guessed', v.unreadable, 1);
  check('   ...the mechanic comes from the job card; a missing one keeps its id', [v.rows[2].mechanicName, v.rows[0].mechanicName, v.rows[0].mechanicId], ['Selim Mia', '', 'MEC-0009']);
  const ids = o => R.filterRows(v.rows, 'visits', o).map(r => r.id);
  check('status filter: completed / pending / cancelled', [ids({ status: 'completed' }), ids({ status: 'pending' }), ids({ status: 'cancelled' })], [['JOB-0001'], ['JOB-0002'], ['JOB-0003']]);
  check('search by customer, registration (with or without dashes), job card, mechanic, phone digits',
    [ids({ search: 'rahim' }).length, ids({ search: 'ctgkha' }), ids({ search: 'job-0002' }), ids({ search: 'selim' }).length, ids({ search: '01712345678' }).length],
    [2, ['JOB-0002'], ['JOB-0002'], 2, 2]);
  check('no match -> nothing', ids({ search: 'zzz' }), []);

  const fus = [
    { id: 'FUP-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', reason: 'Brake check', status: 'Open', dueDate: '2026-10-20', createdAt: '2026-09-01T00:00:00Z', closedAt: null, lastOutcome: 'reached' },
    { id: 'FUP-0002', customerId: 'CUS-0002', vehicleId: null, reason: 'Estimate', status: 'Completed', dueDate: '2026-09-10', createdAt: '2026-09-01T00:00:00Z', closedAt: '2026-10-02T04:00:00Z', lastOutcome: null },
    { id: 'FUP-0003', customerId: 'CUS-0003', vehicleId: null, reason: 'Old', status: 'Cancelled', dueDate: '2026-08-01', createdAt: '2026-08-01T00:00:00Z', closedAt: '2026-08-02T00:00:00Z', lastOutcome: null },
    { id: 'FUP-0004', customerId: 'CUS-0003', vehicleId: null, reason: 'New', status: 'Open', dueDate: '2026-11-30', createdAt: '2026-10-03T00:00:00Z', closedAt: null, lastOutcome: 'callback_requested' },
  ];
  const f = R.followUpRows({ followUps: fus, customers: CUSTOMERS, vehicles: VEHICLES, p: oct });
  check('follow-ups: created, due or closed in the period (FUP-0003 had nothing in October)', f.map(r => r.id).sort(), ['FUP-0001', 'FUP-0002', 'FUP-0004']);
  check('   ...status filter and outcome labels', [R.filterRows(f, 'followUps', { status: 'Open' }).length, f.find(r => r.id === 'FUP-0004').outcome], [2, 'Callback requested']);
  check('   ...a follow-up row has no staff and no job card (none exists in the data)', Object.keys(f[0]).some(k => /mechanic|staff|assigned|jobCard/i.test(k)), false);

  const list = n => Array.from({ length: n }, (_, i) => i);
  check('pagination: 0 rows / 25 / 26 (page 2 holds one) / clamped', [R.paginate([], 1).total, R.paginate(list(25), 1).pages, R.paginate(list(26), 2).items, R.paginate(list(26), 9).page],
    [0, 1, [25], 2]);
  check('PAGE_SIZE is 25', R.PAGE_SIZE, 25);
}

/* ---------- 5. CSV ---------- */
console.log('\n-- 5. CSV --');
{
  check('quotes, commas and newlines are quoted', R.csvCell('a, "b"\nc'), '"a, ""b""\nc"');
  check('formula-like cells are neutralised (= + - @, after spaces / control characters, tab, CR)',
    ['=SUM(A1)', '+1', '-2', '@x', '  =1', '\u0001=1', '\tx', '\rx'].map(R.csvCell),
    ['"\'=SUM(A1)"', '"\'+1"', '"\'-2"', '"\'@x"', '"\'  =1"', '"\'\u0001=1"', '"\'\tx"', '"\'\rx"']);
  check('ordinary text, dates and empty values are unchanged', [R.csvCell('2026-10-01'), R.csvCell(null), R.csvCell('Rahim')], ['"2026-10-01"', '""', '"Rahim"']);
  const rows = [{ id: 'JOB-1', date: '2026-10-01', status: 'Completed', customerName: 'মোঃ করিম', customerId: 'CUS-3', phoneDigits: '8801900000000', regNo: 'X', vehicleId: 'V', vehicleKnown: true, vehicleLabel: 'Kia', mechanicName: '=cmd', mechanicId: 'M' }];
  const csv = R.buildCsv('visits', rows);
  check('a UTF-8 BOM, then a header row', csv.slice(0, 1) === '﻿' && csv.split('\r\n')[0], '﻿"Service Date","Job Card","Status","Customer","Registration","Vehicle","Mechanic"');
  ok('   ...Bengali text kept as is', csv.includes('"মোঃ করিম"'), csv);
  ok('   ...no phone number anywhere', !csv.includes('1900000000') && !/phone/i.test(csv), csv);
  ok('   ...the formula in a name is neutralised', csv.includes('"\'=cmd"'), csv);
  check('no rows -> no file', [R.buildCsv('visits', []), R.buildCsv('followUps', null)], [null, null]);
  check('file name names the tab and the period', R.csvFilename('followUps', { from: '2026-10-01', to: '2026-10-31' }), 'crm-report-follow-ups-2026-10-01_to_2026-10-31.csv');
}

/* ---------- 6. the page ---------- */
console.log('\n-- 6. the page --');
{
  // Fixtures relative to the real Dhaka today, so the default period (Last 30 days) holds them.
  const today = R.dhakaToday();
  const d = n => R.addDays(today, n);
  const jobs = [];
  for (let i = 0; i < 26; i++) jobs.push({ id: `JOB-${String(i + 1).padStart(4, '0')}`, customerId: i % 2 ? 'CUS-0001' : 'CUS-0002', vehicleId: i % 2 ? 'VEH-0001' : 'VEH-0002', mechanicId: 'MEC-0001', date: d(-(i % 20)), status: i === 3 ? 'Cancelled' : 'Completed' });
  jobs.push({ id: 'JOB-0100', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: d(-200), status: 'Delivered' });   // makes CUS-0001 returning
  const vehicles = [{ ...VEHICLES[0], nextServiceDate: d(-3) }, { ...VEHICLES[1], nextServiceDate: today }, { id: 'VEH-0003', customerId: 'CUS-0003', regNo: 'X', brand: 'B', model: 'M', status: 'Active', nextServiceDate: d(10) }];
  const followUps = [
    { id: 'FUP-0001', customerId: 'CUS-0002', vehicleId: 'VEH-0002', reason: '<b>Call</b> back', status: 'Open', dueDate: d(2), createdAt: `${d(-5)}T04:00:00.000Z`, closedAt: null, lastOutcome: null },
    { id: 'FUP-0002', customerId: 'CUS-0001', vehicleId: null, reason: 'Done', status: 'Completed', dueDate: d(-4), createdAt: `${d(-9)}T04:00:00.000Z`, closedAt: `${d(-2)}T04:00:00.000Z`, lastOutcome: 'reached' },
    { id: 'FUP-0003', customerId: 'CUS-0001', vehicleId: null, reason: 'Gone', status: 'Cancelled', dueDate: d(-4), createdAt: `${d(-9)}T04:00:00.000Z`, closedAt: `${d(-2)}T04:00:00.000Z`, lastOutcome: null },
  ];
  const api = ({ fail = false } = {}) => {
    const base = fakeApi({ rows: { customers: CUSTOMERS, vehicles, 'job-cards': jobs, mechanics: MECHANICS } });
    const calls = base.calls;
    const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
    const fn = async (url, init = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
      if (!path.startsWith('/follow-up')) return base(url, init);
      calls.push({ method: init.method || 'GET', path });
      if (fail) return res(500, { error: { code: 'database_error', message: 'x' } });
      return res(200, { data: followUps, count: followUps.length, total: followUps.length, limit: 1000, offset: 0 });
    };
    fn.calls = calls;
    return fn;
  };

  const f = api();
  const { h, el, R: P2, downloads } = page({ fetch: f });
  ok('before the data loads nothing is read from the follow-ups', !f.calls.some(c => c.path.startsWith('/follow-up')), '');
  h.fireReady();
  await tick(100);
  ok('follow-ups are loaded on demand, once', f.calls.filter(c => c.path.startsWith('/follow-ups')).length === 1, JSON.stringify(f.calls.map(c => c.path)));
  ok('   ...and nothing is written', !f.calls.some(c => c.method && c.method !== 'GET'), '');
  ok('controls are enabled; From / To only for a custom range', ['crpPeriodKind', 'crpSearch', 'crpStatus', 'crpClear', 'crpTabVisits', 'crpTabFollowUps'].every(id => el(id).disabled === false) && el('crpFrom').disabled && el('crpTo').disabled, '');
  check('the period is shown resolved, in Dhaka time', /· 30 days · Asia\/Dhaka/.test(el('crpPeriod').textContent), true);
  const cards = () => ['crpReminders', 'crpOpen', 'crpCompleted', 'crpReturning'].map(id => el(id).innerHTML);
  check('cards: reminders due 2 (overdue + today), open 1, completed 1, returning 1', cards(), ['2', '1', '1', '1']);
  {
    // FUP-0001 open since d(-5); FUP-0002 completed on d(-2); FUP-0003 cancelled on d(-2) (both created d(-9)).
    const lbl = n => { const [y, m, dd] = d(n).split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }); };
    const openOn = n => { const m = el('crpChart').innerHTML.match(new RegExp(`aria-label="${lbl(n)}: Open follow-ups (\\d+)"`)); return m ? Number(m[1]) : null; };
    check('   ...chart: open at the end of d-3 counts the later-cancelled follow-up (3); from its cancellation day d-2 it does not (1)',
      [openOn(-6), openOn(-3), openOn(-2), openOn(0)], [2, 3, 1, 1]);
  }
  ok('   ...the reminder card says it is a current snapshot', /Current snapshot as of/.test(el('crpRemindersSub').textContent) && /1 overdue, 1 due today, 1 upcoming/.test(el('crpRemindersSub').textContent), el('crpRemindersSub').textContent);
  ok('   ...Open is labelled as independent of the period', /whatever the period/.test(el('crpOpenSub').textContent), '');
  ok('the chart is drawn with three honest series and a table alternative',
    /crp-bar crp-bar--info/.test(el('crpChart').innerHTML) && /Daily/.test(el('crpChartCaption').textContent) && /not charted/.test(el('crpChartCaption').textContent) && el('crpChartData').hidden === false, el('crpChartCaption').textContent);
  const body = () => el('crpBody').innerHTML;
  const rowCount = () => (body().match(/<tr data-id=/g) || []).length;
  check('Service Visits: 25 rows on page 1 of the 26 in the period, with a pager', [rowCount(), el('crpPager').hidden, el('crpPageRange').textContent], [25, false, '1–25 of 26']);
  ok('   ...every value escaped', !body().includes('<img src=x') && body().includes('&lt;img src=x onerror=alert(1)&gt;'), '');
  ok('   ...rows link to their job card', body().includes('href="job-cards.html?view=JOB-0001"'), '');
  P2.state.page = 2; P2.renderList();
  check('page 2 holds the 26th', rowCount(), 1);
  const before = cards();
  P2.state.search = 'zzzz'; P2.state.page = 1; P2.renderList();
  ok('no matches: a message with Clear filters, export disabled', /No service visits match/.test(body()) && /data-action="clear"/.test(body()) && el('crpExport').disabled === true, '');
  check('   ...and the cards did not change', cards(), before);
  P2.clearFilters();
  check('Clear filters restores the list', rowCount(), 25);
  el('crpStatus').value = 'cancelled'; el('crpStatus').dispatch('change');
  check('status filter: the one cancelled job card', [rowCount(), P2.state.page], [1, 1]);
  check('   ...cards still unchanged', cards(), before);
  P2.clearFilters();
  P2.state.page = 2; P2.renderList();
  el('crpPeriodKind').value = 'last7'; el('crpPeriodKind').dispatch('change');
  check('changing the period resets to page 1 and recomputes', [P2.state.page, /· 7 days ·/.test(el('crpPeriod').textContent)], [1, true]);
  el('crpPeriodKind').value = 'custom'; el('crpPeriodKind').dispatch('change');
  check('Custom enables From / To', [el('crpFrom').disabled, el('crpTo').disabled], [false, false]);
  el('crpFrom').value = d(1); el('crpTo').value = d(0); el('crpFrom').dispatch('change');
  ok('From after To: an inline error, and the last valid report stays', el('crpRangeError').hidden === false && /on or before/.test(el('crpRangeError').textContent) && /· 7 days ·/.test(el('crpPeriod').textContent), el('crpRangeError').textContent);
  el('crpFrom').value = d(-400); el('crpTo').value = d(0); el('crpTo').dispatch('change');
  ok('more than 366 days: refused', /at most 366 days/.test(el('crpRangeError').textContent), el('crpRangeError').textContent);
  el('crpFrom').value = d(-60); el('crpTo').value = d(0); el('crpTo').dispatch('change');
  ok('a valid custom range clears the error; 61 days -> weekly chart', el('crpRangeError').hidden === true && /Weekly/.test(el('crpChartCaption').textContent), el('crpChartCaption').textContent);
  el('crpPeriodKind').value = 'last30'; el('crpPeriodKind').dispatch('change');

  // Follow-ups tab
  P2.setTab('followUps');
  ok('Follow-ups tab: its own columns, rows and status options', /Last Outcome/.test(el('crpHeadRow').innerHTML) && rowCount() === 3 && /value="Open"/.test(el('crpStatus').innerHTML), body().slice(0, 200));
  ok('   ...reasons escaped', body().includes('&lt;b&gt;Call&lt;/b&gt; back') && !body().includes('<b>Call</b>'), '');
  el('crpStatus').value = 'Completed'; el('crpStatus').dispatch('change');
  check('   ...status filter Completed', rowCount(), 1);

  // CSV of the filtered follow-ups
  const name = P2.exportCsv();
  const csv = downloads.blobs && downloads.blobs[downloads.blobs.length - 1].text;
  ok('export: one file, named for the tab and period', name && downloads.length === 1 && downloads[0].name === name && /^crm-report-follow-ups-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv$/.test(name), String(name));
  ok('   ...holding exactly the filtered row (FUP-0002 only)', csv && csv.split('\r\n').filter(Boolean).length === 2 && csv.includes('FUP-0002') && !csv.includes('FUP-0001'), csv);
  ok('   ...with no phone numbers', csv && !csv.includes('1712') && !csv.includes('01800000000'), '');
  P2.state.search = 'zzzz'; P2.renderList();
  check('   ...no rows -> no file', [P2.exportCsv(), downloads.length], [null, 1]);
  P2.clearFilters();
  // keyboard between tabs
  el('crpTabFollowUps').dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });
  check('arrow keys move between the tabs', P2.state.tab, 'visits');
}
{
  // Follow-ups fail; everything else still reports.
  const today = R.dhakaToday();
  const base = fakeApi({ rows: { customers: CUSTOMERS, vehicles: [{ ...VEHICLES[0], nextServiceDate: today }], 'job-cards': [{ id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: today, status: 'Completed' }], mechanics: MECHANICS } });
  const calls = base.calls;
  const f = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (path.startsWith('/follow-up')) { calls.push({ path }); return { status: 500, ok: false, json: async () => ({ error: { code: 'database_error', message: 'x' } }) }; }
    return base(url, init);
  };
  const { h, el, R: P3 } = page({ fetch: f, seedDemo: true });
  h.fireReady();
  await tick(100);
  check('follow-ups failed: their cards say Unavailable, the others still show', ['crpReminders', 'crpOpen', 'crpCompleted', 'crpReturning'].map(id => el(id).innerHTML),
    ['1', '<span aria-hidden="true">&#8212;</span>', '<span aria-hidden="true">&#8212;</span>', '0']);
  ok('   ...the cards explain why', /follow-ups could not be loaded/.test(el('crpOpenSub').textContent), el('crpOpenSub').textContent);
  ok('   ...the service visits are still listed (from the database, not the planted demo job card)', /JOB-0001/.test(el('crpBody').innerHTML) && !/JOB-9999/.test(el('crpBody').innerHTML), '');
  ok('   ...the chart says the follow-up series are unavailable', /follow-up series unavailable/.test(el('crpChartCaption').textContent), '');
  P3.setTab('followUps');
  ok('   ...the Follow-ups tab offers Retry and no demo row; export disabled', /could not be loaded/.test(el('crpBody').innerHTML) && /data-action="retry"/.test(el('crpBody').innerHTML) && !/DEMO ROW/.test(el('crpBody').innerHTML) && el('crpExport').disabled === true, '');
  check('   ...and exporting it creates nothing', P3.exportCsv(), null);
  const n = calls.filter(c => c.path && c.path.startsWith('/follow-up')).length;
  await P3.loadFollowUps();
  ok('Retry reads the follow-ups again', calls.filter(c => c.path && c.path.startsWith('/follow-up')).length > n, '');
}
{
  const { h, el } = page({ origin: '', seedDemo: true });
  h.ctx.Storage.seedIfEmpty();
  h.fireReady();
  await tick(60);
  ok('no backend: the page says it needs the workshop database, shows no figure and no row',
    /need the workshop database/.test(el('crpBody').innerHTML) && !/<tr data-id=/.test(el('crpBody').innerHTML) && el('crpReminders').innerHTML.includes('&#8212;'), el('crpBody').innerHTML.slice(0, 200));
  ok('   ...every control disabled, export too', ['crpPeriodKind', 'crpSearch', 'crpStatus', 'crpExport', 'crpTabVisits'].every(id => el(id).disabled === true), '');
}
{
  const f = fakeApi({ authenticated: false });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(60);
  ok('signed out: nothing is read', !f.calls.some(c => c.path.startsWith('/follow-up') || c.path.startsWith('/job-cards')), JSON.stringify(f.calls.map(c => c.path)));
  ok('   ...and nothing is shown', !/<tr data-id=/.test(el('crpBody').innerHTML), '');
}

process.exit(summary('CRM reports unit') === 0 ? 0 : 1);
})();
