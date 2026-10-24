/* staff-overview — Staff Management › Overview, connected to the database.

   Drives the REAL js/staff-overview.js (with the real api.js, storage.js,
   utils.js and app.js) through the shared harness, against a fake API that
   answers /api/staff, /api/attendance, /api/leave-requests and
   /api/activity-log the way the Worker does (filtered, limited).

     1. Helpers: totals and active staff (unknown when the roster is cut
        short), one day's counts with no one counted twice, "Not recorded"
        (active staff who had joined, never Absent), newest staff first,
        rows that are escaped and never show a phone or e-mail address.
     2. The page in 'api' mode: exactly four reads, all GET, each limited;
        the six cards; the four sections; choosing another day asks for that
        day only, and going back to today asks nothing.
     3. States: one section failing leaves the others drawn (and Retry asks
        again), 403 on the activity log, an ended session, no backend, empty
        data.
     4. It only reads: no request but GET, nothing in browser storage. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

const STAFF = [
  { id: 'MEC-0001', isMechanic: true, name: 'Rahim Mechanic', department: 'Workshop', joiningDate: '2024-01-10', status: 'Active', createdAt: '2026-01-01T00:00:00.000Z', phone: '01700-000001', email: 'rahim@example.com' },
  { id: 'STF-0001', name: 'Karim Cashier', department: 'Accounts', joiningDate: '2025-03-01', status: 'Active', createdAt: '2026-05-01T00:00:00.000Z', phone: '01700-000002', email: 'karim@example.com' },
  { id: 'STF-0002', name: 'Old Helper', department: 'Workshop', joiningDate: '2023-01-01', status: 'Inactive', createdAt: '2026-02-01T00:00:00.000Z', phone: '', email: '' },
  { id: 'STF-0003', name: 'New <b>Advisor</b>', department: 'Front Desk', joiningDate: '2099-01-01', status: 'Active', createdAt: '2026-09-01T00:00:00.000Z', phone: '', email: '' },
];

/** fakeApi for the hydrated collections; the four Overview routes answered as the Worker would. */
function api({ staff = STAFF, days = {}, pending = null, activity = null, fail = {} } = {}) {
  const base = fakeApi({ rows: { mechanics: [] } });
  const calls = base.calls;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(JSON.stringify(body)) });
  const pend = pending || [{ id: 'LVR-0002', staffId: 'STF-0001', staffName: 'Karim Cashier', leaveType: 'Sick', startDate: '2026-10-26', endDate: '2026-10-27', days: 2, status: 'Pending', reason: 'private reason' }];
  const acts = activity || [{ id: '7', occurredAt: '2026-10-24T05:00:00.000Z', actorKind: 'passphrase', actorAccountId: '', actorName: 'Workshop passphrase', action: 'create', module: 'attendance', recordId: 'ATT-0001', summary: 'Recorded Present for Rahim Mechanic (MEC-0001) on 2026-10-24' }];
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    const method = init.method || 'GET';
    if (path === '/session' && method === 'GET') return res(200, { data: { authenticated: true, passphrase: true, accounts: true } });
    const route = path.split('?')[0];
    if (!['/staff', '/attendance', '/leave-requests', '/activity-log'].includes(route)) return base(url, init);
    calls.push({ method, path });
    const f = fail[route];
    if (f && (typeof f.times !== 'number' || f.times-- > 0)) return res(f.status, { error: { code: f.code, message: 'x' } });
    const q = new URLSearchParams(path.split('?')[1] || '');
    const limit = Number(q.get('limit') || 500);
    if (route === '/staff') return res(200, { data: staff.slice(0, limit), count: Math.min(limit, staff.length), total: staff.length });
    if (route === '/attendance') { const rows = days[q.get('date')] || []; return res(200, { data: rows, count: rows.length, total: rows.length }); }
    if (route === '/leave-requests') { const rows = pend.filter(r => r.status === q.get('status')); return res(200, { data: rows.slice(0, limit), count: Math.min(limit, rows.length), total: rows.length }); }
    return res(200, { data: acts.slice(0, limit), count: Math.min(limit, acts.length), total: acts.length });
  };
  fn.calls = calls;
  return fn;
}

function page({ origin = 'http://localhost:8787', fetch } = {}) {
  const h = boot({ origin, fetch, modules: ['js/staff-overview.js'] });
  vm.runInContext('globalThis.StaffOverview = StaffOverview;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, O: h.ctx.StaffOverview };
}
const reads = f => f.calls.filter(c => /^\/(staff|attendance|leave-requests|activity-log)(\?|$)/.test(c.path)).map(c => c.path);
const cards = el => ['total', 'active', 'present', 'late', 'absent', 'pending'].map(k => el(`sov-${k}`).textContent);
const att = (id, staffId, status) => ({ id, staffId, staffName: staffId, status, date: '' });

(async () => {
console.log('=== staff-overview: Staff Overview dashboard ===\n');

/* ---------- 1. helpers ---------- */
console.log('-- 1. helpers --');
{
  const { O } = page({ origin: '' });
  check('totals: all staff, active and inactive', JSON.parse(JSON.stringify(O.staffSummary(STAFF, 4))), { total: 4, active: 3, inactive: 1, complete: true });
  check('   ...a roster cut short does not guess the active count', JSON.parse(JSON.stringify(O.staffSummary(STAFF.slice(0, 2), 1500))), { total: 1500, active: null, inactive: null, complete: false });
  const c = O.attendanceCounts([att('A1', 'MEC-0001', 'Present'), att('A2', 'STF-0001', 'Late'), att('A9', 'MEC-0001', 'Absent'), att('A3', 'STF-0002', 'On Leave')]);
  check('one day counted by status, no one counted twice', [c.Present, c.Late, c['Half-day'], c.Absent, c['On Leave'], c.Holiday, c.recorded], [1, 1, 0, 0, 1, 0, 3]);
  check('Not recorded: active staff who had joined by that day and have no record (never "absent")',
    JSON.parse(JSON.stringify(O.notRecorded(STAFF, [att('A1', 'MEC-0001', 'Present')], '2026-10-24'))), { expected: 2, missing: 1 });
  check('   ...an inactive member or someone not yet joined is not expected', O.notRecorded(STAFF, [], '2026-10-24').expected, 2);
  check('newest staff first', O.recentStaff(STAFF).map(s => s.id), ['STF-0003', 'STF-0001', 'STF-0002', 'MEC-0001']);
  const row = O.staffRow(STAFF[3]) + O.staffRow(STAFF[0]);
  ok('a staff row escapes the name and never shows a phone number or e-mail address',
    row.includes('New &lt;b&gt;Advisor&lt;/b&gt;') && !row.includes('<b>Advisor') && !/01700|example\.com/.test(row), row);
  const lv = O.leaveRow({ staffId: 'STF-0001', staffName: 'Karim', leaveType: 'Sick', startDate: '2026-10-26', endDate: '2026-10-27', days: 2, status: 'Pending', reason: 'private reason' });
  ok('a leave row shows the type, dates and status, not the reason', /Sick leave/.test(lv) && /2 days/.test(lv) && />Pending</.test(lv) && !/private reason/.test(lv), lv);
  check('times are workshop time (Asia/Dhaka)', O.fmtWhen('2026-10-23T20:30:00.000Z'), '24 Oct 2026, 02:30');
}

/* ---------- 2. the page, connected ---------- */
console.log('\n-- 2. the page in api mode --');
{
  const pre = page({ origin: '' });
  const today = pre.h.ctx.Utils.todayStr();
  const f = api({ days: { [today]: [att('A1', 'MEC-0001', 'Present'), att('A2', 'STF-0001', 'Late')], '2026-10-01': [att('A5', 'MEC-0001', 'Absent')] } });
  const { h, el, O } = page({ fetch: f });
  h.fireReady();
  await tick(120);
  check('exactly four reads, each limited (no whole-history download)', reads(f).sort(),
    ['/activity-log?limit=5', `/attendance?date=${today}&limit=1000`, '/leave-requests?status=Pending&limit=5', '/staff?limit=1000'].sort());
  check('the six cards, from the database', cards(el), ['4', '3', '1', '1', '0', '1']);
  ok('   ...Absent counts recorded absences only', el('sov-absent-sub').textContent === 'Recorded absences only', el('sov-absent-sub').textContent);
  const a = el('sovAttBody').innerHTML;
  ok('Attendance: the six statuses and Not recorded (0 of the 2 active staff who have joined)',
    ['Present', 'Late', 'Half-day', 'Absent', 'On Leave', 'Holiday', 'Not recorded'].every(s => a.includes(s)) && /0 of 2 active staff members not recorded/.test(a), a.slice(0, 300));
  ok('   ...and says a missing record is never Absent and nothing is changed here', /never as Absent/.test(a) && /Nothing here records or changes attendance/.test(a), '');
  ok('Pending leave: the request with its type and dates', /Karim Cashier/.test(el('sovLeaveBody').innerHTML) && /Sick leave/.test(el('sovLeaveBody').innerHTML), '');
  check('Recently added staff: newest first', [...el('sovStaffBody').innerHTML.matchAll(/<span class="cell-sub">((?:MEC|STF)-\d+)<\/span>/g)].map(m => m[1]), ['STF-0003', 'STF-0001', 'STF-0002', 'MEC-0001']);
  ok('Recent activity: the entry with who, module and time', /Recorded Present for Rahim Mechanic/.test(el('sovActBody').innerHTML) && /Workshop passphrase · Attendance/.test(el('sovActBody').innerHTML), '');
  ok('the day picker is enabled, set to today and capped at today', el('sovDay').disabled === false && el('sovDay').value === today, '');
  const before = reads(f).length;
  el('sovDay').dispatch('change', { target: { value: '2026-10-01' } });
  await tick(80);
  check('another day asks for that day only', reads(f).slice(before), ['/attendance?date=2026-10-01&limit=1000']);
  ok('   ...and shows it (1 record, 1 of 2 not recorded), while the cards stay on today', /Showing 1 Oct 2026/.test(el('sovAttNote').textContent)
    && /1 record for 1 Oct 2026; 1 of 2 active staff members not recorded/.test(el('sovAttBody').innerHTML) && cards(el)[2] === '1' && cards(el)[4] === '0', el('sovAttBody').innerHTML.slice(0, 200));
  el('sovDay').dispatch('change', { target: { value: today } });
  await tick(40);
  check('going back to today asks nothing more', reads(f).length, before + 1);
  el('sovDay').dispatch('change', { target: { value: '2999-01-01' } });
  await tick(40);
  check('a future day is refused without a request', [reads(f).length, el('sovDay').value], [before + 1, today]);
  check('it only reads: every request was a GET', f.calls.filter(c => c.method !== 'GET').length, 0);
  ok('nothing about the overview reached browser storage', ['taqwa_staff', 'taqwa_attendance', 'taqwa_leaveRequests', 'taqwa_activityLog'].every(k => h.ctx.localStorage.getItem(k) === null), '');
  ok('no section is left loading', ['sovAttBody', 'sovLeaveBody', 'sovStaffBody', 'sovActBody'].every(id => !/sov-row--skel/.test(el(id).innerHTML)), '');
  void O;
}

/* ---------- 3. states ---------- */
console.log('\n-- 3. states --');
{
  const f = api({ fail: { '/leave-requests': { status: 500, code: 'database_error', times: 1 } } });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(120);
  ok('one failing section says so, with Retry, and shows no numbers', /Could not load leave requests/.test(el('sovLeaveBody').innerHTML) && /data-action="retry" data-section="leave"/.test(el('sovLeaveBody').innerHTML)
    && el('sov-pending').textContent === '—' && /Could not be loaded/.test(el('sov-pending-sub').textContent), el('sovLeaveBody').innerHTML.slice(0, 200));
  ok('   ...while the other sections are drawn', /STF-0001/.test(el('sovStaffBody').innerHTML) && /Recorded Present/.test(el('sovActBody').innerHTML) && el('sov-total').textContent === '4', '');
  el('sovLeaveBody').dispatch('click', { target: { closest: () => ({ dataset: { action: 'retry', section: 'leave' }, disabled: false }) } });
  await tick(80);
  ok('   ...and Retry asks again and draws it', reads(f).filter(p => p.startsWith('/leave-requests')).length === 2 && /Karim Cashier/.test(el('sovLeaveBody').innerHTML) && el('sov-pending').textContent === '1', '');
}
{
  const f = api({ fail: { '/activity-log': { status: 403, code: 'forbidden' } } });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(120);
  ok('a non-administrator sees why there is no activity (403), and nothing else is affected',
    /Only an administrator can read the activity log/.test(el('sovActBody').innerHTML) && el('sov-total').textContent === '4' && el('sovAlert').hidden === true, el('sovActBody').innerHTML.slice(0, 200));
}
{
  const f = api({ fail: { '/staff': { status: 401, code: 'unauthorized' }, '/attendance': { status: 401, code: 'unauthorized' }, '/leave-requests': { status: 401, code: 'unauthorized' }, '/activity-log': { status: 401, code: 'unauthorized' } } });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(120);
  ok('an ended session: one alert with Sign in again, every number "—"', el('sovAlert').hidden === false && /data-action="signin"/.test(el('sovAlert').innerHTML)
    && cards(el).every(v => v === '—'), el('sovAlert').innerHTML);
}
{
  const f = api({ staff: [], pending: [], activity: [] });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(120);
  ok('no data yet: zeros where zero is true, and an honest empty state in each section',
    cards(el).join() === '0,0,0,0,0,0' && /No staff yet/.test(el('sovStaffBody').innerHTML) && /No pending leave requests/.test(el('sovLeaveBody').innerHTML)
      && /No activity yet/.test(el('sovActBody').innerHTML) && /0 records/.test(el('sovAttBody').innerHTML), cards(el).join());
}
{
  const { h, el } = page({ origin: '' });
  h.fireReady();
  await tick(40);
  ok('no backend: every section says it needs the workshop database, and every number is "—"',
    ['sovAttBody', 'sovLeaveBody', 'sovStaffBody', 'sovActBody'].every(id => /Needs the workshop database/.test(el(id).innerHTML)) && cards(el).every(v => v === '—'), '');
}

/* ---------- 4. the script only reads ---------- */
console.log('\n-- 4. js/staff-overview.js --');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../js/staff-overview.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  check('no request of its own, browser storage, cookie or console logging', ['fetch(', 'XMLHttpRequest', 'Api.', 'localStorage', 'sessionStorage', 'cookie', 'console.'].filter(t => code.includes(t)), []);
  check('only Storage.loadPage reads, of the four collections', [...code.matchAll(/Storage\.(\w+)\('?(\w*)/g)].map(m => `${m[1]}${m[2] ? ` ${m[2]}` : ''}`).filter(x => x !== 'isApi' && x !== 'ready start').sort(),
    ['loadPage activityLog', 'loadPage attendance', 'loadPage leaveRequests', 'loadPage staff']);
  ok('no write of any kind', !/Storage\.(create|update|remove|action|saveData|addData|updateData|deleteData)\b|method:\s*'(POST|PUT|DELETE)'/.test(code), '');
  ok('no timer or polling', !/setInterval|setTimeout/.test(code), '');
}

summary('staff-overview');
})().catch(e => { console.error(e); process.exit(1); });
