/* dashboard-crm — the Dashboard's Customer CRM Overview, on real data.

   Drives the REAL js/dashboard.js (and js/crm-reminders.js, to compare) with
   the real api.js, storage.js and utils.js through the shared harness,
   against the in-memory fake API. Every name and number is fictional.

     1. The counting rules: Dhaka day, date boundaries (today, +7, +8, +30,
        +31), Active vehicles with a real date only, distinct vehicles.
     2. The same numbers as Service Reminders on the same data.
     3. The page: the four cards, their sub-lines and links.
     4. Follow-ups: the Service Reminders rule; failure and denial.
     5. Offline and without a database: no guessed number.
     6. Service Reminders opens with the filter a card hands it. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

function dashboard({ origin = 'http://localhost:8787', api } = {}) {
  const h = boot({ origin, fetch: api, modules: ['js/dashboard.js'] });
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, D: () => h.ctx.DashboardCrm };
}
function reminders({ api, search = '' } = {}) {
  const h = boot({
    origin: 'http://localhost:8787', fetch: api, modules: ['js/crm-reminders.js'],
    beforeModules(doc, ctx) { ctx.location.search = search; ctx.location.reload = () => {}; },
  });
  vm.runInContext('globalThis.CrmReminders = CrmReminders;', h.ctx);
  return { h, el: id => h.ctx.document.getElementById(id), R: h.ctx.CrmReminders };
}

(async () => {
console.log('=== dashboard-crm: Customer CRM Overview ===\n');

/* ---------- 1. rules ---------- */
console.log('-- 1. counting rules --');
const TODAY = '2026-11-07';
const veh = (id, next, extra = {}) => ({ id, customerId: 'CUS-0001', regNo: id, brand: 'B', model: 'M', status: 'Active', nextServiceDate: next, ...extra });
const VEHICLES = [
  veh('VEH-01', addDays(TODAY, -1)),          // overdue
  veh('VEH-02', addDays(TODAY, -40)),         // overdue
  veh('VEH-03', TODAY),                       // due today: in 7 days, not upcoming, not overdue
  veh('VEH-04', addDays(TODAY, 1)),           // upcoming, in 7 days
  veh('VEH-05', addDays(TODAY, 7)),           // upcoming, in 7 days (boundary)
  veh('VEH-06', addDays(TODAY, 8)),           // upcoming only
  veh('VEH-07', addDays(TODAY, 30)),          // upcoming (boundary)
  veh('VEH-08', addDays(TODAY, 31)),          // beyond 30: nothing
  veh('VEH-09', addDays(TODAY, -3), { status: 'Inactive' }),   // inactive: nothing
  veh('VEH-10', '2026-02-30'),                // not a real date: nothing
  veh('VEH-11', ''),                          // no date: nothing
];
{
  const { D } = dashboard({ origin: '' });
  const d = D();
  const c = d.crmVehicleCounts(VEHICLES, TODAY);
  check('Upcoming (after today, up to +30) / Overdue (before today) / Due (today to +7)', [c.upcoming, c.overdue, c.due7], [4, 2, 3]);
  check('   ...the link dates are today+30 and today+7', [c.in30, c.in7], [addDays(TODAY, 30), addDays(TODAY, 7)]);
  const twice = d.crmVehicleCounts([...VEHICLES, VEHICLES[0], VEHICLES[2], VEHICLES[3]], TODAY);
  check('the same vehicle listed twice is counted once', [twice.upcoming, twice.overdue, twice.due7], [4, 2, 3]);
  check('17:59:59Z is still that day in Dhaka; 18:00Z is the next', [d.dhakaDay(new Date('2026-11-07T17:59:59Z')), d.dhakaDay(new Date('2026-11-07T18:00:00Z'))], ['2026-11-07', '2026-11-08']);
  const lateUtc = d.crmVehicleCounts(VEHICLES, d.dhakaDay(new Date('2026-11-07T18:30:00Z')));
  check('   ...so after 18:00 UTC the vehicle due "today" (7 Nov) is already overdue in Dhaka', lateUtc.overdue, 3);
  const fu = [
    { status: 'Open', dueDate: TODAY, customerId: 'CUS-A' },
    { status: 'Open', dueDate: addDays(TODAY, -2), customerId: 'CUS-A' },   // same customer: once
    { status: 'Open', dueDate: addDays(TODAY, -1), customerId: 'CUS-B' },
    { status: 'Open', dueDate: addDays(TODAY, 1), customerId: 'CUS-C' },    // not yet due
    { status: 'Completed', dueDate: TODAY, customerId: 'CUS-D' },           // closed
    { status: 'Open', dueDate: 'soon', customerId: 'CUS-E' },               // unreadable
  ];
  check('Customers to Follow Up: distinct customers, Open, due today or earlier', d.crmFollowUpCustomers(fu, TODAY), 2);
}

/* ---------- 2. same as Service Reminders ---------- */
console.log('\n-- 2. the same numbers as Service Reminders --');
{
  const { D } = dashboard({ origin: '' });
  const dhaka = D().dhakaDay();
  const vehicles = VEHICLES.map(v => ({ ...v, nextServiceDate: v.nextServiceDate && /^\d{4}-\d{2}-\d{2}$/.test(v.nextServiceDate) && v.nextServiceDate !== '2026-02-30'
    ? addDays(dhaka, Math.round((Date.parse(v.nextServiceDate) - Date.parse(TODAY)) / 86400000)) : v.nextServiceDate }));
  const { R } = reminders({ api: fakeApi({ rows: {} }) });
  const built = R.buildReminders({ vehicles, customers: [], jobCards: [], today: dhaka });
  const reminderOverdue = built.rows.filter(r => r.status === 'Overdue').length;
  const reminderUpcoming30 = R.filterRows(built.rows, { status: 'Upcoming', dueBy: addDays(dhaka, 30) }).length;
  const c = D().crmVehicleCounts(vehicles, dhaka);
  check('Overdue matches Service Reminders\' Overdue list', c.overdue, reminderOverdue);
  check('Upcoming matches Service Reminders\' Upcoming list due by today+30 (the card\'s link)', c.upcoming, reminderUpcoming30);
  check('Vehicles Due matches its Due Today + Upcoming rows up to today+7',
    c.due7, built.rows.filter(r => r.status !== 'Overdue' && r.next <= addDays(dhaka, 7)).length);
}

/* ---------- 3. the page ---------- */
console.log('\n-- 3. the Dashboard page --');
const dhakaNow = (() => { const { D } = dashboard({ origin: '' }); return D().dhakaDay(); })();
const rows = () => ({
  customers: [{ id: 'CUS-0001', name: 'Test', phone: '017' }, { id: 'CUS-0002', name: 'Two', phone: '018' }],
  vehicles: [
    veh('VEH-01', addDays(dhakaNow, -2)), veh('VEH-02', dhakaNow), veh('VEH-03', addDays(dhakaNow, 5)),
    veh('VEH-04', addDays(dhakaNow, 20)), veh('VEH-05', addDays(dhakaNow, 45)), veh('VEH-06', addDays(dhakaNow, -9), { status: 'Inactive' }),
  ],
  'follow-ups': [
    { id: 'FU-1', customerId: 'CUS-0001', status: 'Open', dueDate: dhakaNow },
    { id: 'FU-2', customerId: 'CUS-0002', status: 'Open', dueDate: addDays(dhakaNow, 3) },
  ],
});
{
  const { h, el } = dashboard({ api: fakeApi({ rows: rows() }) });
  h.fireReady();
  await tick(120);
  check('the four cards show the counts', [el('crmUpcoming').innerHTML, el('crmOverdue').innerHTML, el('crmFollowUp').innerHTML, el('crmDue7').innerHTML], ['2', '1', '1', '2']);
  check('   ...with a plain sub-line each', [el('crmUpcomingSub').textContent, el('crmOverdueSub').textContent, el('crmFollowUpSub').textContent, el('crmDue7Sub').textContent],
    ['Due in the next 30 days', 'Next service date has passed', 'Follow-up due today or overdue', 'Vehicles due today or in the next 7 days']);
  check('Upcoming opens Service Reminders filtered to Upcoming, due by today+30', el('crmUpcomingCard').href, `pages/crm-reminders.html?status=Upcoming&dueBy=${addDays(dhakaNow, 30)}`);
  check('Vehicles Due opens Service Reminders due by today+7', el('crmDue7Card').href, `pages/crm-reminders.html?dueBy=${addDays(dhakaNow, 7)}`);
}
{
  const r = rows(); r.vehicles = []; r['follow-ups'] = [];
  const { h, el } = dashboard({ api: fakeApi({ rows: r }) });
  h.fireReady();
  await tick(120);
  check('empty data: every card is a real 0', [el('crmUpcoming').innerHTML, el('crmOverdue').innerHTML, el('crmFollowUp').innerHTML, el('crmDue7').innerHTML], ['0', '0', '0', '0']);
  check('   ...and the follow-up card says so', el('crmFollowUpSub').textContent, 'No follow-up due today or overdue');
}

/* ---------- 4. follow-up failures ---------- */
console.log('\n-- 4. follow-up failures --');
for (const [label, status, code, expected] of [['a failed read', 500, 'database_error', 'Could not be loaded'], ['a role without CRM access', 403, 'forbidden', 'Your role does not include follow-ups']]) {
  const api = fakeApi({ rows: rows(), fail: ({ path }) => (path.startsWith('/follow-ups') ? { status, error: { code, message: 'x' } } : null) });
  const { h, el } = dashboard({ api });
  h.fireReady();
  await tick(120);
  check(`${label}: a dash and the reason, never a number`, [el('crmFollowUp').innerHTML, el('crmFollowUpSub').textContent], ['<span aria-hidden="true">—</span>', expected]);
  check('   ...while the vehicle cards still count', el('crmOverdue').innerHTML, '1');
}

/* ---------- 5. offline / no database ---------- */
console.log('\n-- 5. offline and without the database --');
{
  const { h, el, D } = dashboard({ api: fakeApi({ rows: rows() }) });
  h.fireReady();
  await tick(120);
  // Offline: the app keeps its copy; follow-ups are online only.
  const S = h.ctx.Storage;
  S.isApi = () => false; S.isOffline = () => true;
  D().renderCrmOverview();
  await tick(40);
  check('offline: the vehicle cards count from the copy this computer holds', [el('crmUpcoming').innerHTML, el('crmOverdue').innerHTML, el('crmDue7').innerHTML], ['2', '1', '2']);
  check('   ...and the follow-up card says it is unavailable offline', [el('crmFollowUp').innerHTML, el('crmFollowUpSub').textContent], ['<span aria-hidden="true">—</span>', 'Unavailable offline']);
}
{
  const { h, el } = dashboard({ origin: '' });
  h.fireReady();
  await tick(80);
  check('no workshop database: every card is a dash with the reason (no demo numbers)',
    [el('crmUpcoming').innerHTML, el('crmFollowUp').innerHTML, el('crmDue7Sub').textContent, el('crmFollowUpSub').textContent],
    ['<span aria-hidden="true">—</span>', '<span aria-hidden="true">—</span>', 'Needs the workshop database', 'Needs the workshop database']);
}

/* ---------- 6. Service Reminders reads the card's filter ---------- */
console.log('\n-- 6. Service Reminders opens with the card\'s filter --');
{
  const due = addDays(dhakaNow, 30);
  const { h, el, R } = reminders({ api: fakeApi({ rows: rows() }), search: `?status=Upcoming&dueBy=${due}` });
  h.fireReady();
  await tick(120);
  check('?status=Upcoming&dueBy=… sets both filters', [R.state.status, R.state.dueBy, el('crrStatus').value, el('crrDueBy').value], ['Upcoming', due, 'Upcoming', due]);
  check('   ...and lists exactly the Dashboard\'s Upcoming count', (el('crrBody').innerHTML.match(/<tr data-id=/g) || []).length, 2);
}
{
  const { h, R } = reminders({ api: fakeApi({ rows: rows() }), search: '?status=Overdue' });
  h.fireReady();
  await tick(120);
  check('?status=Overdue lists the Dashboard\'s Overdue vehicles', R.filterRows(R.state.rows, R.state).length, 1);
}
{
  const { h, R } = reminders({ api: fakeApi({ rows: rows() }), search: '?status=Bogus&dueBy=2026-02-30' });
  h.fireReady();
  await tick(120);
  check('an unknown status or an impossible date is ignored (every reminder shown)', [R.state.status, R.state.dueBy], ['all', '']);
}

process.exit(summary('Dashboard CRM unit') === 0 ? 0 : 1);
})();
