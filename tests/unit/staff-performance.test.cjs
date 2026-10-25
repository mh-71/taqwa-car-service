/* staff-performance — Staff Management › Performance, from the job cards.

   Drives the REAL js/staff-performance.js (with the real api.js, storage.js,
   utils.js and app.js) through the shared harness. The job cards and
   mechanics come from a fake API the way the Worker serves them; the page
   counts what the app already loaded and asks for nothing more.

     1. Helpers: workshop days (Asia/Dhaka), the periods, a custom range that
        is not one.
     2. The counts: assigned by job date and split by current status,
        completed in the period by completion time (never mixed), on time
        against the estimated delivery date only where there is one, no job
        card counted twice, zero denominators shown as "—", one mechanic.
     3. The page in 'api' mode: the cards, the table, the job card list with
        links to the Job Cards page, period / custom range / invalid range,
        mechanic and status filters, search, Reset; it makes no request of its
        own and changes no job card.
     4. No backend shows nothing; the script only reads. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
const clone = x => JSON.parse(JSON.stringify(x));

function page({ origin = 'http://localhost:8787', fetch } = {}) {
  const h = boot({ origin, fetch, modules: ['js/staff-performance.js'] });
  vm.runInContext('globalThis.StaffPerformance = StaffPerformance;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, P: h.ctx.StaffPerformance };
}
const cards = el => ['mechanics', 'assigned', 'done', 'open', 'cancelled', 'ontime'].map(k => el(`prf-${k}`).textContent);
const rowIds = html => [...html.matchAll(/<tr data-id="([^"]+)"/g)].map(m => m[1]);

const MECHANICS = [
  { id: 'MEC-0001', name: 'Alpha Mechanic', specialization: 'Engine', status: 'Active', phone: '01700-000001', salary: 1 },
  { id: 'MEC-0002', name: 'Bravo Mechanic', specialization: 'Electrical', status: 'Active', phone: '01700-000002' },
  { id: 'MEC-0003', name: 'Charlie Mechanic', specialization: '', status: 'Inactive', phone: '01700-000003' },
  { id: 'MEC-0004', name: 'Delta Mechanic', specialization: 'Body', status: 'Active', phone: '01700-000004' },
];
const J = (id, mechanicId, date, status, extra = {}) => ({ id, mechanicId, date, status, estDelivery: '', completedAt: '', total: 1000, ...extra });

(async () => {
console.log('=== staff-performance: Performance ===\n');

/* ---------- 1. helpers ---------- */
console.log('-- 1. helpers --');
const { P: H } = page({ origin: '' });
check('a completion instant is read as a workshop day (Asia/Dhaka, UTC+6)', [H.dhakaDay('2026-03-15T17:59:00.000Z'), H.dhakaDay('2026-03-15T18:00:00.000Z'), H.dhakaDay('2026-03-15'), H.dhakaDay(''), H.dhakaDay('nope')],
  ['2026-03-15', '2026-03-16', '2026-03-15', '', '']);
check('the periods, for 15 Mar 2026', ['today', 'last7', 'month', 'lastMonth'].map(k => clone(H.periodRange(k, '2026-03-15'))),
  [{ from: '2026-03-15', to: '2026-03-15' }, { from: '2026-03-09', to: '2026-03-15' }, { from: '2026-03-01', to: '2026-03-15' }, { from: '2026-02-01', to: '2026-02-28' }]);
check('   ...last month across a year end', clone(H.periodRange('lastMonth', '2026-01-10')), { from: '2025-12-01', to: '2025-12-31' });
check('a custom range: valid, inverted, incomplete', [clone(H.periodRange('custom', '2026-03-15', '2026-01-01', '2026-01-31')),
  clone(H.periodRange('custom', '2026-03-15', '2026-02-01', '2026-01-01')), clone(H.periodRange('custom', '2026-03-15', '2026-02-01', ''))],
  [{ from: '2026-01-01', to: '2026-01-31' }, { invalid: true }, { invalid: true }]);

/* ---------- 2. the counts ---------- */
console.log('\n-- 2. the counts --');
{
  const R = { from: '2026-03-01', to: '2026-03-15' };
  const jobs = [
    J('JOB-1', 'MEC-0001', '2026-03-02', 'Completed', { estDelivery: '2026-03-05', completedAt: '2026-03-04T08:00:00.000Z' }),
    J('JOB-2', 'MEC-0001', '2026-03-03', 'In Progress'),
    J('JOB-3', 'MEC-0001', '2026-03-04', 'Cancelled'),
    J('JOB-4', 'MEC-0002', '2026-03-05', 'Delivered', { estDelivery: '2026-03-06', completedAt: '2026-03-07T04:00:00.000Z' }),
    J('JOB-5', 'MEC-0002', '2026-02-20', 'Completed', { completedAt: '2026-03-02T04:00:00.000Z' }),
    J('JOB-1', 'MEC-0001', '2026-03-02', 'Completed', { estDelivery: '2026-03-05', completedAt: '2026-03-04T08:00:00.000Z' }),
    J('JOB-7', 'MEC-0001', '2026-03-20', 'Received'),
    J('JOB-8', 'MEC-0004', '2026-02-27', 'Completed', { completedAt: '2026-03-15T20:00:00.000Z' }),
  ];
  const r = H.summarize(jobs, MECHANICS, R);
  const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
  check('rows: the active mechanics, sorted by name (the inactive one without job cards is left out)', r.rows.map(x => x.id), ['MEC-0001', 'MEC-0002', 'MEC-0004']);
  check('mechanic 1: 3 assigned by job date (the duplicate JOB-1 once, JOB-7 after the period not at all)',
    ['assigned', 'open', 'done', 'cancelled'].map(k => by['MEC-0001'][k]), [3, 1, 1, 1]);
  check('   ...completion rate = done / (assigned - cancelled) = 1 / 2', by['MEC-0001'].completionRate, 50);
  check('   ...completed in the period 1, on time 1 of 1', [by['MEC-0001'].completedIn, by['MEC-0001'].onTime, by['MEC-0001'].onTimeEligible, by['MEC-0001'].onTimeRate], [1, 1, 1, 100]);
  check('mechanic 2: 1 assigned (JOB-5 has an earlier job date), 2 completed in the period by completion time',
    [by['MEC-0002'].assigned, by['MEC-0002'].done, by['MEC-0002'].completedIn], [1, 1, 2]);
  check('   ...on time only where there is an estimated delivery date: 0 of 1 (late)', [by['MEC-0002'].onTime, by['MEC-0002'].onTimeEligible, by['MEC-0002'].onTimeRate], [0, 1, 0]);
  check('mechanic 4: completed at 20:00 UTC on the last day = the next workshop day, so outside; nothing to rate',
    [by['MEC-0004'].assigned, by['MEC-0004'].completedIn, by['MEC-0004'].completionRate, by['MEC-0004'].onTimeRate], [0, 0, null, null]);
  const t = r.totals;
  check('totals', [t.assigned, t.open, t.done, t.cancelled, t.completionRate, t.completedIn, t.onTime, t.onTimeEligible, t.onTimeRate, t.mechanicsWithWork, t.activeMechanics],
    [4, 1, 2, 1, 67, 3, 1, 2, 50, 2, 3]);
  check('the job card list: the period\'s job cards by job date, newest first, each once', r.assignedJobs.map(j => j.id), ['JOB-4', 'JOB-3', 'JOB-2', 'JOB-1']);
  const one = H.summarize(jobs, MECHANICS, R, { mechanicId: 'MEC-0002' });
  check('one mechanic: only their row and job cards', [one.rows.map(x => x.id), one.totals.assigned, one.totals.completedIn], [['MEC-0002'], 1, 2]);
  const inactive = H.summarize(jobs, MECHANICS, R, { mechanicId: 'MEC-0003' });
  check('   ...an inactive mechanic chosen on purpose still gets a (zero) row', [inactive.rows.map(x => x.id), inactive.totals.assigned], [['MEC-0003'], 0]);
  const cancelledOnly = H.summarize([J('JOB-9', 'MEC-0001', '2026-03-02', 'Cancelled')], MECHANICS, R).totals;
  check('only cancelled job cards: no completion rate (no division by zero)', [cancelledOnly.assigned, cancelledOnly.completionRate, cancelledOnly.onTimeRate], [1, null, null]);
  const orphan = H.summarize([J('JOB-10', 'MEC-0099', '2026-03-02', 'Received')], MECHANICS, R);
  ok('a job card whose mechanic is not in the list is still counted, under "Unknown mechanic"', orphan.rows.some(x => x.id === 'MEC-0099' && x.name === 'Unknown mechanic' && x.assigned === 1), '');
  const html = H.rowHtml({ ...by['MEC-0001'], name: '<img src=x onerror=alert(1)>' });
  ok('a row escapes the name and shows no phone or pay', html.includes('&lt;img src=x') && !html.includes('<img src=x') && !/01700|salary/.test(html), html.slice(0, 200));
}

/* ---------- 3. the page ---------- */
console.log('\n-- 3. the page in api mode --');
{
  const today = H.dhakaDay(new Date().toISOString());
  const d = n => H.addDays(today, n);
  const rows = {
    mechanics: clone(MECHANICS),
    'job-cards': [
      J('JOB-0001', 'MEC-0001', today, 'Completed', { estDelivery: today, completedAt: new Date().toISOString() }),
      J('JOB-0002', 'MEC-0001', today, 'Waiting for Parts'),
      J('JOB-0003', 'MEC-0002', today, 'Received'),
      J('JOB-0004', 'MEC-0002', d(-40), 'Delivered'),
    ],
  };
  const f = fakeApi({ rows });
  const { h, el, P } = page({ fetch: f });
  const before = clone(rows['job-cards']);
  h.fireReady();
  await tick(120);
  const afterReady = f.calls.length;
  P.state.period = 'today'; el('prfPeriod').dispatch('change', { target: { value: 'today' } });
  check('today: the cards', cards(el), ['2', '3', '1', '2', '0', '100%']);
  ok('   ...the completion rate and on-time basis are spelled out', /33% completion rate \(cancelled excluded\)/.test(el('prf-done-sub').textContent) && /1 of 1 completed in the period with an estimated delivery date/.test(el('prf-ontime-sub').textContent), el('prf-done-sub').textContent);
  check('   ...the table: the active mechanics', rowIds(el('prfBody').innerHTML), ['MEC-0001', 'MEC-0002', 'MEC-0004']);
  const list = el('prfJobsBody').innerHTML;
  ok('   ...the job card list links each job card to the Job Cards page', /href="job-cards\.html\?view=JOB-0001"/.test(list) && /href="job-cards\.html\?view=JOB-0003"/.test(list) && !/JOB-0004/.test(list), list.slice(0, 200));
  el('prfStatus').dispatch('change', { target: { value: 'Received' } });
  ok('the status filter narrows the job card list', /JOB-0003/.test(el('prfJobsBody').innerHTML) && !/JOB-0001/.test(el('prfJobsBody').innerHTML), '');
  el('prfStatus').dispatch('change', { target: { value: 'Cancelled' } });
  ok('   ...and says so when nothing has that status', /No job card has this status/.test(el('prfJobsBody').innerHTML), '');
  el('prfMechanic').dispatch('change', { target: { value: 'MEC-0002' } });
  check('the mechanic filter: one row, its counts', [rowIds(el('prfBody').innerHTML), el('prf-assigned').textContent], [['MEC-0002'], '1']);
  el('prfSearch').dispatch('input', { target: { value: 'nobody' } });
  ok('a search that matches no mechanic says so', /No mechanic matches/.test(el('prfBody').innerHTML), '');
  el('prfFrom').dispatch('change', { target: { value: d(-50) } });
  el('prfTo').dispatch('change', { target: { value: d(-60) } });
  ok('an inverted custom range is refused, with no numbers', el('prfRangeError').hidden === false && /date range is not valid/.test(el('prfBody').innerHTML) && cards(el).every(v => v === '—'), '');
  P.reset();
  check('Reset: this month, all mechanics, all statuses', [P.state.period, P.state.mechanic, P.state.status, P.state.q, el('prfRangeError').hidden], ['month', 'all', 'all', '', true]);
  el('prfFrom').dispatch('change', { target: { value: d(-45) } });
  el('prfTo').dispatch('change', { target: { value: d(-35) } });
  check('a custom range that holds only the delivered job card', [el('prf-assigned').textContent, el('prf-done').textContent, el('prfPeriod').value], ['1', '1', 'custom']);
  ok('   ...whose completion time is unknown, so it is not "completed in the period"', /No job card was completed in the period/.test(el('prf-ontime-sub').textContent), el('prf-ontime-sub').textContent);
  check('the page asked for nothing after loading (it counts what the app already holds)', f.calls.length - afterReady, 0);
  check('   ...every request the app made was a GET', f.calls.filter(c => c.method !== 'GET').length, 0);
  check('   ...and no job card changed', clone(f.db['job-cards']), before);
}
{
  const f = fakeApi({ rows: { mechanics: [], 'job-cards': [] } });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(120);
  ok('no mechanics and no job cards: zeros where zero is true, and honest empty states',
    cards(el).slice(0, 5).join() === '0,0,0,0,0' && el('prf-ontime').textContent === '—' && /No mechanics yet/.test(el('prfBody').innerHTML) && /No job cards in this period/.test(el('prfJobsBody').innerHTML), cards(el).join());
}

/* ---------- 4. no backend; the script only reads ---------- */
console.log('\n-- 4. no backend, read-only --');
{
  const { h, el } = page({ origin: '' });
  h.fireReady();
  await tick(40);
  ok('no backend: the page says it needs the workshop database, every number is "—" and the controls stay disabled',
    /needs the workshop database/.test(el('prfBody').innerHTML) && cards(el).every(v => v === '—') && el('prfPeriod').disabled === true, '');
  const code = fs.readFileSync(path.join(__dirname, '../../js/staff-performance.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  check('no request, browser storage, cookie, console logging or timer of its own', ['fetch(', 'XMLHttpRequest', 'Api.', 'localStorage', 'sessionStorage', 'cookie', 'console.', 'setInterval', 'setTimeout'].filter(t => code.includes(t)), []);
  check('only reads through Storage', [...new Set([...code.matchAll(/Storage\.(\w+)/g)].map(m => m[1]))].sort(), ['getById', 'getData', 'isApi', 'ready']);
  ok('never shows a phone number, e-mail address, salary or commission', !/\.(phone|email|salary|commissionRate)\b/.test(code), '');
}

summary('staff-performance');
})().catch(e => { console.error(e); process.exit(1); });
