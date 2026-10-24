/* staff-attendance — Staff Management › Attendance, connected to the database.

   Drives the REAL js/staff-attendance.js (with the real api.js, storage.js,
   utils.js and app.js) through the shared harness, against a fake API that
   answers /api/attendance and /api/staff the way the Worker does.

     1. Helpers: the month a day falls in, hours between check-in and
        check-out, one row per active person (plus anyone with a record), the
        filters (incl. Not recorded), the day and month summaries counted from
        records only, the form rules, and rows that are escaped.
     2. The page in 'api' mode: the roster and the chosen month's records
        loaded on demand (a from/to query, nothing written), the six cards from
        the records, unrecorded days shown as such, the monthly summary, filters.
     3. Failures: a refused (403), failed (500) or ended (401) load each say so
        with no rows; no backend shows nothing and Storage refuses to write.
     4. Writes: Record sends exactly { staffId, date, status, checkIn, checkOut,
        notes }; times are dropped for a day not worked; invalid input sends
        nothing; Edit sends the changes plus expectedUpdatedAt; a 409 (already
        recorded, or changed meanwhile) reloads instead of overwriting. */
const vm = require('vm');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

const STAFF = [
  { id: 'MEC-0001', isMechanic: true, name: 'Jamal Uddin', designation: 'Mechanic', department: 'Workshop', status: 'Active' },
  { id: 'MEC-0002', isMechanic: true, name: 'Kamal', designation: 'Senior Mechanic', department: 'Workshop', status: 'Active' },
  { id: 'STF-0001', isMechanic: false, name: '<img src=x onerror=alert(1)>', designation: 'Accountant', department: 'Accounts', status: 'Active' },
  { id: 'STF-0002', isMechanic: false, name: 'Gone Staff', designation: 'Helper', department: 'Workshop', status: 'Inactive' },
];
const rec = (id, staffId, date, status, extra = {}) => ({ id, staffId, isMechanic: staffId.startsWith('MEC'), staffName: (STAFF.find(s => s.id === staffId) || {}).name || staffId,
  department: (STAFF.find(s => s.id === staffId) || {}).department || '', designation: '', date, status, checkIn: '', checkOut: '', notes: '',
  createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z', ...extra });

function page({ origin = 'http://localhost:8787', fetch } = {}) {
  const h = boot({ origin, fetch, modules: ['js/staff-attendance.js'] });
  vm.runInContext('globalThis.StaffAttendance = StaffAttendance;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, S: h.ctx.StaffAttendance };
}

/** fakeApi for the hydrated collections; /attendance and /staff answered as the Worker would. */
function api({ records = [], staff = STAFF, failAttendance = null, failWrite = null } = {}) {
  const base = fakeApi({ rows: { mechanics: [] } });
  const calls = base.calls;
  const db = JSON.parse(JSON.stringify(records));
  // A copy, as a real response is: the page never holds the fake database's own objects.
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(JSON.stringify(body)) });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (path === '/session' && method === 'GET') return res(200, { data: { authenticated: true, passphrase: true, accounts: true } });
    if (path.startsWith('/staff')) { calls.push({ method, path, body }); return res(200, { data: staff, total: staff.length }); }
    if (!path.startsWith('/attendance')) return base(url, init);
    calls.push({ method, path, body });
    if (failAttendance) return res(failAttendance.status, { error: failAttendance.error });
    const [p, qs] = path.split('?');
    const id = p.split('/')[2];
    if (method === 'GET' && !id) {
      const q = new URLSearchParams(qs || '');
      const rows = db.filter(r => (!q.get('from') || r.date >= q.get('from')) && (!q.get('to') || r.date <= q.get('to')));
      return res(200, { data: rows, total: rows.length });
    }
    if (failWrite) return res(failWrite.status, { error: failWrite.error });
    if (method === 'POST' && !id) {
      const r = rec(`ATT-000${db.length + 1}`, body.staffId, body.date, body.status, { checkIn: body.checkIn || '', checkOut: body.checkOut || '', notes: body.notes || '' });
      db.push(r);
      return res(201, { data: r });
    }
    const row = db.find(r => r.id === id);
    if (!row) return res(404, { error: { code: 'not_found', message: 'No attendance record with that id.' } });
    if (method === 'PUT') {
      const { expectedUpdatedAt, ...changes } = body;
      if (expectedUpdatedAt !== row.updatedAt) return res(409, { error: { code: 'conflict', reason: 'concurrent_modification', message: 'Changed by someone else.' } });
      Object.assign(row, changes, { updatedAt: '2026-10-02T09:00:00.000Z' });
      return res(200, { data: row });
    }
    return res(405, { error: { code: 'method_not_allowed', message: 'x' } });
  };
  fn.calls = calls;
  fn.db = db;
  return fn;
}

const persons = html => [...html.matchAll(/<tr data-person="([^"]+)"/g)].map(m => m[1]);
const click = (el, action, id) => el('attBody').dispatch('click', { target: { closest: () => ({ dataset: { action, id }, disabled: false }) } });

/** A stand-in for the dialog's form, so the real dialog code can be driven: values in, clicks out. */
function fakeModal(values) {
  const inputs = {};
  for (const [sel, value] of Object.entries(values)) { const e = makeElement(sel); e.value = value; inputs[sel] = e; }
  const save = makeElement('save'); save._on = {};
  const form = makeElement('form');
  form.querySelector = sel => inputs[sel] || null;
  form.querySelectorAll = () => [];
  const ov = { querySelector: sel => (sel === '[data-save]' ? save : sel === '#attForm' ? form : null) };
  return { ov, save, inputs, press: () => Promise.all((save._on.click || []).map(cb => cb({ currentTarget: save }))) };
}

(async () => {
console.log('=== staff-attendance: Attendance ===\n');

/* ---------- 1. helpers ---------- */
console.log('-- 1. helpers --');
{
  const { S } = page({ origin: '' });
  check('the month a day falls in (incl. February of a leap year)', [S.monthRange('2026-10-24'), S.monthRange('2028-02-10'), S.monthRange('2026-12-31')].map(r => JSON.parse(JSON.stringify(r))),
    [{ from: '2026-10-01', to: '2026-10-31' }, { from: '2028-02-01', to: '2028-02-29' }, { from: '2026-12-01', to: '2026-12-31' }]);
  check('hours between check-in and check-out (display only), none without both', [S.minutesWorked({ checkIn: '09:00', checkOut: '18:10' }), S.minutesWorked({ checkIn: '09:00', checkOut: '' }), S.minutesWorked(null), S.fmtHours(550)],
    [550, null, null, '9h 10m']);
  const D = '2026-10-20';
  const records = [rec('ATT-0001', 'MEC-0001', D, 'Present'), rec('ATT-0002', 'STF-0002', D, 'Absent'), rec('ATT-0003', 'MEC-0002', '2026-10-21', 'Late')];
  const rows = S.dayRows(STAFF, records, D);
  check('one row per active person, plus an inactive person who has a record that day, sorted by name',
    rows.map(r => [r.person.id, r.record && r.record.id]), [['STF-0001', null], ['STF-0002', 'ATT-0002'], ['MEC-0001', 'ATT-0001'], ['MEC-0002', null]]);
  check('filters: status, Not recorded, department, search (name or id)',
    [S.filterRows(rows, { status: 'Present' }).length, S.filterRows(rows, { status: 'none' }).map(r => r.person.id), S.filterRows(rows, { department: 'Accounts' }).length,
      S.filterRows(rows, { search: 'kamal' }).length, S.filterRows(rows, { search: 'stf-000' }).length], [1, ['STF-0001', 'MEC-0002'], 1, 1, 2]);
  check('the day\'s cards count records only (an unrecorded day is not absent)', JSON.parse(JSON.stringify(S.daySummary(records, D))),
    { Present: 1, Late: 0, 'Half-day': 0, Absent: 1, 'On Leave': 0, Holiday: 0 });
  const month = S.monthSummary(STAFF, records);
  check('the monthly summary: every active person, and anyone with a record; recorded days per status',
    month.map(m => [m.person.id, m.counts.Present, m.counts.Late, m.counts.Absent, m.counts.total]),
    [['STF-0001', 0, 0, 0, 0], ['STF-0002', 0, 0, 1, 1], ['MEC-0001', 1, 0, 0, 1], ['MEC-0002', 0, 1, 0, 1]]);
  const v = x => Object.keys(S.validateDay({ status: 'Present', checkIn: '09:00', checkOut: '18:00', notes: '', ...x })).sort();
  check('form rules: a full day passes; status, time shape, times only for a worked day, check-out after check-in, notes length',
    [v({}), v({ status: 'Sick' }), v({ checkIn: '9:00' }), v({ status: 'Absent' }), v({ checkIn: '', checkOut: '17:00' }), v({ checkOut: '08:00' }), v({ notes: 'x'.repeat(501) }), v({ status: 'Holiday', checkIn: '', checkOut: '' })],
    [[], ['status'], ['checkIn'], ['checkIn', 'checkOut'], ['checkOut'], ['checkOut'], ['notes'], []]);
  const row = S.rowHtml(rows[0], true);
  ok('a row escapes every value', !row.includes('<img src=x') && row.includes('&lt;img src=x onerror=alert(1)&gt;'), row);
  ok('   ...an unrecorded day says Not recorded and offers Record', /Not recorded/.test(row) && /data-action="record" data-id="STF-0001"/.test(row), row);
  ok('   ...a recorded day offers Edit', /data-action="edit" data-id="ATT-0001"/.test(S.rowHtml(rows[2], true)), '');
  ok('   ...an inactive person with no record offers nothing to record', !/data-action="record"/.test(S.rowHtml({ person: STAFF[3], record: null }, true)), '');
}

/* ---------- 2. the page, connected ---------- */
console.log('\n-- 2. the page in api mode --');
let TODAY;
{
  const probe = page({ origin: '' });
  TODAY = probe.h.ctx.Utils.todayStr();
}
{
  const f = api({ records: [rec('ATT-0001', 'MEC-0001', TODAY, 'Present', { checkIn: '09:00', checkOut: '18:00' }), rec('ATT-0002', 'STF-0001', TODAY, 'On Leave')] });
  const { h, el, S } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  const { from, to } = S.monthRange(TODAY);
  ok('the roster and the month\'s records are loaded on demand', f.calls.some(c => c.path.startsWith('/staff')) && f.calls.some(c => c.path === `/attendance?from=${from}&to=${to}&limit=1000&offset=0`), JSON.stringify(f.calls.map(c => c.path)));
  ok('   ...and nothing is written by loading', !f.calls.some(c => c.method && c.method !== 'GET'), '');
  ok('the controls are enabled once loaded; the day is today and no later day can be chosen',
    ['attDay', 'attSearch', 'attStatus', 'attDept', 'attClear', 'attRecord'].every(id => el(id).disabled === false) && el('attDay').value === TODAY && el('attDay').max === TODAY, '');
  check('the six cards count today\'s records', ['present', 'late', 'half-day', 'absent', 'on-leave', 'holiday'].map(s => el(`att-${s}`).textContent), ['1', '0', '0', '0', '1', '0']);
  check('every active person is a row (the inactive one without a record is not)', persons(el('attBody').innerHTML), ['STF-0001', 'MEC-0001', 'MEC-0002']);
  ok('   ...unrecorded people say so, recorded ones show status, times and hours',
    /Not recorded/.test(el('attBody').innerHTML) && /9h 00m/.test(el('attBody').innerHTML) && /On Leave/.test(el('attBody').innerHTML), '');
  check('   ...the count line', el('attCount').textContent, '3 of 3 staff · 2 recorded, 1 not recorded');
  ok('the monthly summary lists everyone with their recorded days', (el('attMonthBody').innerHTML.match(/<tr>/g) || []).length === 3, el('attMonthBody').innerHTML.slice(0, 200));
  el('attStatus').dispatch('change', { target: { value: 'none' } });
  check('filtering by Not recorded', persons(el('attBody').innerHTML), ['MEC-0002']);
  el('attStatus').dispatch('change', { target: { value: 'Present' } });
  check('filtering by a status', persons(el('attBody').innerHTML), ['MEC-0001']);
  S.clearFilters();
  el('attDept').dispatch('change', { target: { value: 'Accounts' } });
  check('filtering by department', persons(el('attBody').innerHTML), ['STF-0001']);
  S.clearFilters();
  const before = f.calls.length;
  const prevMonth = S.monthRange(TODAY).from.slice(0, 8) === TODAY.slice(0, 8) ? `${String(Number(TODAY.slice(0, 4)) - 1)}-${TODAY.slice(5, 7)}-01` : TODAY;
  el('attDay').dispatch('change', { target: { value: prevMonth } });
  await tick(60);
  ok('choosing a day in another month reads that month (and only attendance)', f.calls.slice(before).some(c => c.path.startsWith(`/attendance?from=${prevMonth.slice(0, 7)}-01`)) && !f.calls.slice(before).some(c => c.path.startsWith('/staff')), JSON.stringify(f.calls.slice(before).map(c => c.path)));
  check('   ...where nothing is recorded: zero in every card, everyone Not recorded', [el('att-present').textContent, persons(el('attBody').innerHTML).length, /Not recorded/.test(el('attBody').innerHTML)], ['0', 3, true]);
}

/* ---------- 3. failures, no backend ---------- */
console.log('\n-- 3. failures, no backend --');
for (const [label, status, code, re] of [
  ['refused (403)', 403, 'forbidden', /cannot see attendance/],
  ['failed (500)', 500, 'database_error', /could not be loaded[\s\S]*data-action="retry"/],
  ['ended session (401)', 401, 'unauthorized', /Your session has ended[\s\S]*data-action="signin"/]]) {
  const { h, el } = page({ fetch: api({ failAttendance: { status, error: { code, message: 'x' } } }) });
  h.fireReady();
  await tick(80);
  const html = el('attBody').innerHTML;
  ok(`a ${label} load says so and shows no rows`, re.test(html) && persons(html).length === 0, html.slice(0, 200));
  ok('   ...the cards show no numbers and the controls stay disabled', el('att-present').textContent === '—' && el('attRecord').disabled === true && el('attDay').disabled === true, '');
}
{
  const { h, el } = page({ origin: '' });
  h.fireReady();
  await tick(40);
  ok('no backend: the page says it needs the workshop database, and shows no one', /needs the workshop database/.test(el('attBody').innerHTML) && persons(el('attBody').innerHTML).length === 0, '');
  const w = await h.ctx.Storage.create('attendance', { staffId: 'MEC-0001' });
  check('   ...and Storage refuses to write attendance to browser storage', [w.ok, w.code], [false, 'no_api']);
}

/* ---------- 4. writes ---------- */
console.log('\n-- 4. writes --');
{
  const f = api({ records: [rec('ATT-0001', 'MEC-0001', TODAY, 'Present', { checkIn: '09:00', checkOut: '18:00' })] });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  const toasts = [];
  h.ctx.Utils.toast = (msg, type) => toasts.push([msg, type]);
  let opened = null;
  const m = fakeModal({ '#att-staff': 'MEC-0002', '#att-status': 'Late', '#att-in': '10:05', '#att-out': '18:00', '#att-notes': ' traffic ' });
  h.ctx.Utils.Modal.open = (opts) => { opened = opts; return m.ov; };
  h.ctx.Utils.Modal.close = () => {};
  el('attRecord').dispatch('click');
  ok('Record Attendance lists only active staff with no record for the day', opened && /value="MEC-0002"/.test(opened.body) && /value="STF-0001"/.test(opened.body)
    && !/value="MEC-0001"|value="STF-0002"/.test(opened.body), opened && opened.body.slice(0, 300));
  ok('   ...and offers exactly the six statuses', opened && ['Present', 'Late', 'Half-day', 'Absent', 'On Leave', 'Holiday'].every(s => opened.body.includes(`<option value="${s}"`)) && (opened.body.match(/<option value="(Present|Late|Half-day|Absent|On Leave|Holiday)"/g) || []).length === 6, '');
  await m.press();
  await tick(20);
  const post = f.calls.find(c => c.method === 'POST' && c.path === '/attendance');
  check('Record sends exactly staffId, date, status, times and notes (trimmed)', post && post.body,
    { staffId: 'MEC-0002', date: TODAY, status: 'Late', checkIn: '10:05', checkOut: '18:00', notes: 'traffic' });
  ok('   ...the new record is shown, and the success says so', /data-action="edit" data-id="ATT-0002"/.test(el('attBody').innerHTML) && toasts.some(([t, k]) => k === 'success' && /Late recorded/.test(t)), JSON.stringify(toasts));

  // A day not worked: the times are switched off and cleared before sending.
  const a = fakeModal({ '#att-status': 'Absent', '#att-in': '09:00', '#att-out': '', '#att-notes': '' });
  h.ctx.Utils.Modal.open = () => a.ov;
  click(el, 'record', 'STF-0001');
  a.inputs['#att-status'].dispatch('change');
  await a.press();
  await tick(20);
  const post2 = f.calls.filter(c => c.method === 'POST' && c.path === '/attendance')[1];
  check('Absent sends no times (they are cleared)', post2 && post2.body, { staffId: 'STF-0001', date: TODAY, status: 'Absent', checkIn: '', checkOut: '', notes: '' });

  // Invalid input sends nothing.
  const writes = f.calls.filter(c => c.method !== 'GET').length;
  const bad = fakeModal({ '#att-staff': 'MEC-0002', '#att-status': 'Present', '#att-in': '18:00', '#att-out': '09:00', '#att-notes': '' });
  h.ctx.Utils.Modal.open = () => bad.ov;
  click(el, 'edit', 'ATT-0001');
  await bad.press();
  await tick(20);
  check('a check-out before the check-in sends nothing', f.calls.filter(c => c.method !== 'GET').length, writes);

  // Edit: the changes plus the updatedAt the edit was made from.
  const e = fakeModal({ '#att-status': 'Half-day', '#att-in': '09:00', '#att-out': '13:00', '#att-notes': 'left at one' });
  h.ctx.Utils.Modal.open = (opts) => { opened = opts; return e.ov; };
  click(el, 'edit', 'ATT-0001');
  ok('Edit says the person and day cannot be changed (no staff choice)', opened && /cannot be changed/.test(opened.body) && !/id="att-staff"/.test(opened.body), '');
  await e.press();
  await tick(20);
  const put = f.calls.find(c => c.method === 'PUT');
  check('Edit sends status, times, notes and expectedUpdatedAt to PUT /attendance/:id', put && [put.path, put.body],
    ['/attendance/ATT-0001', { status: 'Half-day', checkIn: '09:00', checkOut: '13:00', notes: 'left at one', expectedUpdatedAt: '2026-10-01T09:00:00.000Z' }]);

  // A stale edit (someone changed it meanwhile): refused by the Worker, the page reloads instead of overwriting.
  f.db[0].updatedAt = '2026-10-05T09:00:00.000Z';
  const reads = f.calls.filter(c => c.method === 'GET' && c.path.startsWith('/attendance')).length;
  const s2 = fakeModal({ '#att-status': 'Absent', '#att-in': '', '#att-out': '', '#att-notes': '' });
  h.ctx.Utils.Modal.open = () => s2.ov;
  click(el, 'edit', 'ATT-0001');
  await s2.press();
  await tick(60);
  ok('a stale edit is refused (409) and the page re-reads the month instead of overwriting',
    f.db[0].status === 'Half-day' && f.calls.filter(c => c.method === 'GET' && c.path.startsWith('/attendance')).length === reads + 1 && toasts.some(([t, k]) => k === 'warning'), JSON.stringify(toasts.slice(-2)));
  ok('nothing about attendance reached browser storage', h.ctx.localStorage.getItem('taqwa_attendance') === null, '');
}

summary('staff-attendance');
})().catch(e => { console.error(e); process.exit(1); });
