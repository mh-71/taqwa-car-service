/* crm-reminders — Customer CRM › Service Reminders, connected to real data.

   Drives the REAL js/crm-reminders.js (with the real api.js, storage.js and
   utils.js) through the shared harness, against the in-memory fake API.

     1. Dates: today is the Asia/Dhaka calendar day; date-only values are
        never shifted; impossible dates are rejected.
     2. The list: active vehicles with a real next service date only;
        Overdue / Due Today / Upcoming; a missing customer is shown as
        unknown, never invented.
     3. Last service: only Completed / Delivered job cards count.
     4. Search, status and due-by filters.
     5. The page in 'api' mode: cards, rows, escaping, actions, filters.
     6. Empty collections: a genuine empty state.
     7. Failures and no backend: an unavailable state, never demo data,
        even after the app has seeded this browser; Retry reloads.
     8. Signed out: the page renders nothing (the sign-in screen covers it). */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

function page({ origin = 'http://localhost:8787', api } = {}) {
  let reloads = 0;
  const h = boot({
    origin, fetch: api, modules: ['js/crm-reminders.js'],
    beforeModules(doc, ctx) { ctx.location.reload = () => { reloads++; }; },
  });
  vm.runInContext('globalThis.CrmReminders = CrmReminders;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, R: h.ctx.CrmReminders, reloads: () => reloads };
}

const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

(async () => {
console.log('=== crm-reminders: Service Reminders ===\n');

/* ---------- 1. dates ---------- */
console.log('-- 1. Dhaka dates --');
{
  const { R } = page({ origin: '' });
  check('17:59:59Z is still the same day in Dhaka', R.dhakaToday(new Date('2026-10-13T17:59:59Z')), '2026-10-13');
  check('18:00:00Z is already the next day in Dhaka (UTC+6)', R.dhakaToday(new Date('2026-10-13T18:00:00Z')), '2026-10-14');
  check('a job completed at 00:30 Dhaka time counts on that Dhaka day', R.dhakaDateOf('2026-09-30T18:30:00.000Z'), '2026-10-01');
  check('an empty or unreadable timestamp gives no day', [R.dhakaDateOf(''), R.dhakaDateOf(null), R.dhakaDateOf('soon')], ['', '', '']);
  check('isDateOnly accepts a real YYYY-MM-DD day', R.isDateOnly('2026-10-14'), true);
  check('   ...and rejects impossible or differently written dates',
    ['2026-02-30', '2026-13-01', '2026-2-3', '14/10/2026', '2026-10-14T00:00:00Z', 20261014, null].map(R.isDateOnly),
    [false, false, false, false, false, false, false]);
  check('a date-only value is formatted as that calendar day, not shifted', R.formatDay('2026-10-14'), '14 Oct 2026');
  check('   ...and anything else shows a dash instead of being echoed', R.formatDay('<b>x</b>'), '—');
}

/* ---------- 2. the reminder list ---------- */
console.log('\n-- 2. the reminder list --');
const TODAY = '2026-10-14';
const customers = [
  { id: 'CUS-0001', name: 'Rahim Uddin', phone: '+880 1712-345678' },
  { id: 'CUS-0002', name: 'Karim Mia', phone: '017' },
];
const vehicles = [
  { id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHAKA-METRO-GA-1234', brand: 'Toyota', model: 'Corolla', status: 'Active', nextServiceDate: '2026-10-13' },
  { id: 'VEH-0002', customerId: 'CUS-0002', regNo: 'DHAKA-METRO-KHA-5678', brand: 'Honda', model: 'Civic', status: 'Active', nextServiceDate: '2026-10-14' },
  { id: 'VEH-0003', customerId: 'CUS-0001', regNo: 'CTG-GA-9012', brand: 'Nissan', model: 'X-Trail', status: 'Active', nextServiceDate: '2026-10-20' },
  { id: 'VEH-0004', customerId: 'CUS-0001', regNo: 'INACTIVE-1', brand: 'Toyota', model: 'Axio', status: 'Inactive', nextServiceDate: '2026-10-01' },
  { id: 'VEH-0005', customerId: 'CUS-0002', regNo: 'NO-DATE-1', brand: 'Suzuki', model: 'Swift', status: 'Active', nextServiceDate: '' },
  { id: 'VEH-0006', customerId: 'CUS-0002', regNo: 'BAD-DATE-1', brand: 'Kia', model: 'Rio', status: 'Active', nextServiceDate: '2026-02-30' },
  { id: 'VEH-0007', customerId: 'CUS-0002', regNo: 'BAD-DATE-2', brand: 'Kia', model: 'Picanto', status: 'Active', nextServiceDate: '14/10/2026' },
  { id: 'VEH-0008', customerId: 'CUS-0002', regNo: 'NULL-DATE', brand: 'Mazda', model: '2', status: 'Active', nextServiceDate: null },
  { id: 'VEH-0009', customerId: 'CUS-9999', regNo: 'ORPHAN-1', brand: 'Ford', model: 'Focus', status: 'Active', nextServiceDate: '2026-11-01' },
];
const jobCards = [
  // VEH-0001: the Completed one (00:30 Dhaka on 1 Oct) is the latest finished visit.
  { id: 'JOB-0001', vehicleId: 'VEH-0001', status: 'Completed', completedAt: '2026-09-30T18:30:00.000Z', actualDelivery: '', date: '2026-09-28' },
  { id: 'JOB-0002', vehicleId: 'VEH-0001', status: 'Delivered', completedAt: '', actualDelivery: '2026-09-15', date: '2026-09-14' },
  { id: 'JOB-0003', vehicleId: 'VEH-0001', status: 'Cancelled', completedAt: '', actualDelivery: '', date: '2026-10-10' },
  { id: 'JOB-0004', vehicleId: 'VEH-0001', status: 'In Progress', completedAt: '', actualDelivery: '', date: '2026-10-12' },
  // VEH-0002: a legacy Completed card with no stamps falls back to its own date.
  { id: 'JOB-0005', vehicleId: 'VEH-0002', status: 'Delivered', completedAt: '2026-08-01T17:59:00.000Z', actualDelivery: '2026-08-02', date: '2026-07-30' },
  { id: 'JOB-0006', vehicleId: 'VEH-0002', status: 'Completed', completedAt: '', actualDelivery: '', date: '2026-08-05' },
  // VEH-0003: nothing finished -- every unfinished state is ignored.
  ...['Received', 'Inspection', 'Waiting for Approval', 'Waiting for Parts', 'Cancelled'].map((status, i) =>
    ({ id: `JOB-01${i}`, vehicleId: 'VEH-0003', status, completedAt: '', actualDelivery: '', date: '2026-10-11' })),
];
{
  const { R } = page({ origin: '' });
  const built = R.buildReminders({ vehicles, customers, jobCards, today: TODAY });
  check('only active vehicles with a real next service date are listed, soonest first',
    built.rows.map(r => r.vehicleId), ['VEH-0001', 'VEH-0002', 'VEH-0003', 'VEH-0009']);
  check('   ...each with its status: Overdue / Due Today / Upcoming',
    built.rows.map(r => r.status), ['Overdue', 'Due Today', 'Upcoming', 'Upcoming']);
  check('   ...and the days to (or past) the date', built.rows.map(r => r.days), [-1, 0, 6, 18]);
  check('inactive, empty and null dates are left out without being counted as errors; impossible dates are counted',
    built.invalid, 2);
  check('the counts come from the same rows', R.countByStatus(built.rows), { 'Upcoming': 2, 'Due Today': 1, 'Overdue': 1 });
  const orphan = built.rows.find(r => r.vehicleId === 'VEH-0009');
  check('a vehicle whose customer is missing keeps no invented name, id or phone',
    [orphan.customerName, orphan.customerId, orphan.phone], ['', '', '']);
  check('the customer is linked by the vehicle\'s customerId', built.rows[0].customerName, 'Rahim Uddin');
  check('a valid phone becomes a dialable number; a short one becomes none',
    [built.rows[0].phone, built.rows[1].phone], ['+8801712345678', '']);
  check('telNumber refuses anything that is not a phone number',
    ['abc', '"><script>', '12345', '+880 1712 345678'].map(R.telNumber), ['', '', '', '+8801712345678']);
}

/* ---------- 3. last service ---------- */
console.log('\n-- 3. last service --');
{
  const { R } = page({ origin: '' });
  const last = R.lastServiceDates(jobCards);
  check('Completed counts, dated by completedAt in Dhaka time (later than the Delivered visit)', last.get('VEH-0001'), '2026-10-01');
  check('   ...a later Cancelled or In Progress card is ignored', last.get('VEH-0001') < '2026-10-10', true);
  check('a finished card with no completion stamps falls back to its own date, and the latest wins', last.get('VEH-0002'), '2026-08-05');
  check('no finished card means no last service (unfinished states and Cancelled never count)', last.has('VEH-0003'), false);
  check('the list carries it', R.buildReminders({ vehicles, customers, jobCards, today: TODAY }).rows.map(r => r.lastService),
    ['2026-10-01', '2026-08-05', '', '']);
}

/* ---------- 4. filters ---------- */
console.log('\n-- 4. search and filters --');
{
  const { R } = page({ origin: '' });
  const rows = R.buildReminders({ vehicles, customers, jobCards, today: TODAY }).rows;
  const ids = opts => R.filterRows(rows, opts).map(r => r.vehicleId);
  check('no filter shows everything', ids({}), ['VEH-0001', 'VEH-0002', 'VEH-0003', 'VEH-0009']);
  check('search by customer name', ids({ search: 'rahim' }), ['VEH-0001', 'VEH-0003']);
  check('search by brand or model', [ids({ search: 'HONDA' }), ids({ search: 'x-trail' }), ids({ search: 'toyota corolla' })],
    [['VEH-0002'], ['VEH-0003'], ['VEH-0001']]);
  check('search by registration, with or without spaces and dashes',
    [ids({ search: 'GA-1234' }), ids({ search: 'dhaka metro ga1234' })], [['VEH-0001'], ['VEH-0001']]);
  check('status filter', [ids({ status: 'Overdue' }), ids({ status: 'Due Today' }), ids({ status: 'Upcoming' })],
    [['VEH-0001'], ['VEH-0002'], ['VEH-0003', 'VEH-0009']]);
  check('"due by" means on or before that day, overdue included', ids({ dueBy: TODAY }), ['VEH-0001', 'VEH-0002']);
  check('   ...an unreadable due-by date is ignored rather than hiding everything', ids({ dueBy: 'nope' }).length, 4);
  check('filters combine', ids({ search: 'rahim', status: 'Upcoming' }), ['VEH-0003']);
  check('a search that matches nothing returns nothing (and creates nothing)', ids({ search: 'zzz' }), []);
}

/* ---------- 5. the page, connected ---------- */
console.log('\n-- 5. the page, connected --');
{
  // Dates relative to the real Dhaka today, because the page reads the clock.
  const probe = page({ origin: '' });
  const today = probe.R.dhakaToday();
  const api = fakeApi({ rows: {
    customers: [
      { id: 'CUS-0001', name: 'Rahim Uddin', phone: '+880 1712-345678' },
      { id: 'CUS-0002', name: '<img src=x onerror=alert(1)>', phone: '01812345678' },
    ],
    vehicles: [
      { id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHAKA-METRO-GA-1234', brand: 'Toyota', model: 'Corolla', status: 'Active', nextServiceDate: addDays(today, -3) },
      { id: 'VEH-0002', customerId: 'CUS-0002', regNo: '<b>REG</b>', brand: 'Honda', model: 'Civic', status: 'Active', nextServiceDate: today },
      { id: 'VEH-0003', customerId: 'CUS-0404', regNo: 'ORPHAN-1', brand: 'Ford', model: 'Focus', status: 'Active', nextServiceDate: addDays(today, 10) },
      { id: 'VEH-0004', customerId: 'CUS-0001', regNo: 'INACTIVE-1', brand: 'Toyota', model: 'Axio', status: 'Inactive', nextServiceDate: today },
      { id: 'VEH-0005', customerId: 'CUS-0001', regNo: 'BAD-1', brand: 'Kia', model: 'Rio', status: 'Active', nextServiceDate: '2026-02-30' },
    ],
    'job-cards': [
      { id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', status: 'Delivered', completedAt: '', actualDelivery: '2026-09-15', date: '2026-09-14', services: [], parts: [] },
    ],
  } });
  const { h, el, R } = page({ api });
  h.fireReady();
  await tick();
  check('the page is reading the database', h.ctx.Storage.isApi(), true);
  check('the cards count Upcoming / Due Today / Overdue', [el('crrUpcoming').innerHTML, el('crrDueToday').innerHTML, el('crrOverdue').innerHTML], ['1', '1', '1']);
  check('   ...with a plain-language note under each', el('crrDueTodaySub').textContent, 'Next service is today');
  check('the controls are enabled once the data has loaded',
    ['crrSearch', 'crrStatus', 'crrDueBy'].map(id => el(id).disabled), [false, false, false]);
  const body = el('crrBody').innerHTML;
  check('one row per listed vehicle (inactive and unreadable dates left out)', (body.match(/<tr data-id=/g) || []).length, 3);
  ok('   ...the inactive vehicle is not listed', !body.includes('INACTIVE-1'), '');
  ok('customer, vehicle and registration text is escaped, never markup',
    body.includes('&lt;img src=x onerror=alert(1)&gt;') && body.includes('&lt;b&gt;REG&lt;/b&gt;')
      && !body.includes('<img src=x') && !body.includes('<b>REG</b>'), body.slice(0, 300));
  ok('a missing customer reads "Unknown customer"', body.includes('Unknown customer'), '');
  // Compared with the page's own formatter: ICU versions spell September "Sep" or "Sept".
  ok('the last service comes from the Delivered job card', body.includes(`<td>${R.formatDay('2026-09-15')}</td>`), '');
  ok('View vehicle uses the existing vehicle deep link', body.includes('href="vehicles.html?view=VEH-0001"'), '');
  ok('Service history opens the customer\'s existing history view', body.includes('href="customers.html?view=CUS-0001"'), '');
  ok('   ...and is disabled where no customer is linked', /<button type="button" class="icon-btn icon-btn--sm crr-act--off" disabled title="No customer record is linked/.test(body), '');
  ok('Contact uses a tel: link with the cleaned number, without printing the number',
    body.includes('href="tel:+8801712345678"') && !body.includes('1712-345678'), '');
  ok('"Create follow-up task" is present but disabled on every row',
    (body.match(/disabled title="Available once Follow-up Tasks is connected"/g) || []).length === 3, '');
  ok('statuses use the existing badge tones',
    body.includes('badge badge--bad">Overdue') && body.includes('badge badge--warn">Due Today') && body.includes('badge badge--info">Upcoming'), '');
  check('the note reports what is shown, and the skipped vehicle', el('crrToolbarNote').textContent,
    'Showing 3 of 3 reminders · 1 vehicle skipped: unreadable next service date');

  // The real event handlers, driven as the browser would.
  el('crrSearch').dispatch('input', { target: { value: 'corolla' } });
  check('typing in search narrows the table', (el('crrBody').innerHTML.match(/<tr data-id=/g) || []).length, 1);
  check('   ...and the note', el('crrToolbarNote').textContent.startsWith('Showing 1 of 3 reminders'), true);
  check('   ...while the cards keep counting every reminder', el('crrUpcoming').innerHTML + el('crrDueToday').innerHTML + el('crrOverdue').innerHTML, '111');
  el('crrSearch').dispatch('input', { target: { value: '' } });
  el('crrStatus').dispatch('change', { target: { value: 'Due Today' } });
  check('the status filter', (el('crrBody').innerHTML.match(/<tr data-id="VEH-0002"/g) || []).length
    + (el('crrBody').innerHTML.match(/<tr data-id=/g) || []).length, 2);
  el('crrStatus').dispatch('change', { target: { value: 'all' } });
  el('crrDueBy').dispatch('change', { target: { value: today } });
  check('the due-by filter keeps overdue and due-today reminders', (el('crrBody').innerHTML.match(/<tr data-id=/g) || []).length, 2);
  el('crrSearch').dispatch('input', { target: { value: 'nothing-matches-this' } });
  ok('no matches shows a message, not an empty table', /No reminders match your search or filters/.test(el('crrBody').innerHTML), '');
  check('   ...and writes nothing to the database', api.calls.filter(c => c.method !== 'GET').length, 0);
}

/* ---------- 6. empty collections ---------- */
console.log('\n-- 6. empty database --');
{
  const { h, el } = page({ api: fakeApi({ rows: {} }) });
  h.fireReady();
  await tick();
  check('an empty database is still the database', h.ctx.Storage.isApi(), true);
  ok('it shows a genuine empty state', /No service reminders yet/.test(el('crrBody').innerHTML), '');
  check('   ...with zero counts, not dashes', [el('crrUpcoming').innerHTML, el('crrDueToday').innerHTML, el('crrOverdue').innerHTML], ['0', '0', '0']);
  check('   ...and no rows', (el('crrBody').innerHTML.match(/<tr data-id=/g) || []).length, 0);
  check('   ...and nothing seeded into the browser', h.ctx.localStorage.getItem('taqwa_seeded'), null);
}

/* ---------- 7. failures ---------- */
console.log('\n-- 7. failures: never demo data --');
for (const [why, fail] of [
  ['the vehicles request fails (500)', ({ method, path }) => method === 'GET' && path.startsWith('/vehicles') && { status: 500, error: { code: 'database_error', message: 'x' } }],
  ['the job cards request fails (500)', ({ method, path }) => method === 'GET' && path.startsWith('/job-cards') && { status: 500, error: { code: 'database_error', message: 'x' } }],
  ['the health check fails (503)', ({ path }) => path === '/health' && { status: 503, error: { code: 'not_migrated', message: 'x' } }],
]) {
  const p = page({ api: fakeApi({ rows: { vehicles: [{ id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'REAL-1', brand: 'A', model: 'B', status: 'Active', nextServiceDate: '2026-10-14' }] }, fail }) });
  p.h.fireReady();
  await tick();
  // What app.js does today after any failed load: seed demo data into this
  // browser. The page must still show none of it.
  p.h.ctx.Storage.seedIfEmpty();
  p.R.render({ mode: 'local', reason: 'database_error' });
  const body = p.el('crrBody').innerHTML;
  const demo = p.h.ctx.Storage.getData('vehicles');
  ok(`${why}: the browser now holds demo vehicles (the global fallback this page must not show)`, demo.length > 0, String(demo.length));
  ok('   ...but the page lists none of them, and no row at all', (body.match(/<tr data-id=/g) || []).length === 0
    && demo.every(v => !body.includes(v.regNo)), body.slice(0, 200));
  ok('   ...it says the reminders could not be loaded', /Service reminders could not be loaded/.test(body), '');
  ok('   ...offers Retry', /data-action="retry"/.test(body), '');
  check('   ...shows dashes, not counts', [p.el('crrUpcoming').innerHTML, p.el('crrOverdue').innerHTML],
    ['<span aria-hidden="true">&#8212;</span>', '<span aria-hidden="true">&#8212;</span>']);
  check('   ...and keeps the controls disabled', ['crrSearch', 'crrStatus', 'crrDueBy'].map(id => p.el(id).disabled), [true, true, true]);
  p.el('crrBody').dispatch('click', { target: { closest: sel => (sel === '[data-action="retry"]' ? {} : null) } });
  check('   ...and Retry reloads the page, which runs the load again', p.reloads(), 1);
  p.el('crrBody').dispatch('click', { target: { closest: () => null } });
  check('   ...while other clicks in the table do not', p.reloads(), 1);
}
{
  const p = page({ origin: '' });   // file:// or the static demo: no backend at all
  p.h.fireReady();
  await tick(5);
  p.h.ctx.Storage.seedIfEmpty();
  p.R.render({ mode: 'local', reason: 'no_api' });
  const body = p.el('crrBody').innerHTML;
  ok('with no backend at all, the page explains it needs the database', /need the workshop database/.test(body), '');
  ok('   ...shows no demo vehicle', (body.match(/<tr data-id=/g) || []).length === 0, '');
  ok('   ...and offers no Retry (there is nothing to retry)', !/data-action="retry"/.test(body), '');
}

/* ---------- 8. signed out ---------- */
console.log('\n-- 8. signed out --');
{
  const p = page({ api: fakeApi({ authenticated: false, rows: { vehicles: [{ id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'REAL-1', brand: 'A', model: 'B', status: 'Active', nextServiceDate: '2026-10-14' }] } }) });
  p.h.fireReady();
  await tick();
  check('a locked app renders nothing into the table (the sign-in screen covers the page)', p.el('crrBody').innerHTML, '');
  check('   ...and leaves the cards untouched', p.el('crrUpcoming').innerHTML, '');
}

process.exit(summary('CRM reminders unit') === 0 ? 0 : 1);
})();
