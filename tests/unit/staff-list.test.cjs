/* staff-list — Staff Management › Staff List, connected to the database.

   Drives the REAL js/staff-list.js (with the real api.js, storage.js,
   utils.js and app.js) through the shared harness, against a fake API that
   answers /api/staff the way the Worker does.

     1. Helpers: dates, search (name, staff ID, code, email, phone digits),
        the three filters, the five sorts, paging, filter options, the
        browser's copy of the Worker's validation, and a request body that
        never carries pay.
     2. The page in 'api' mode: loads on demand, renders escaped rows with
        no pay, the right actions per status, filters / search / sort /
        page size / paging / Clear filters.
     3. Empty roster and no search results: honest, distinct states.
     4. Status changes: Deactivate (after confirming) and Activate send the
        Worker's PUT and the row follows its answer; a refusal changes nothing.
     5. View reads the full record fresh, and shows no pay.
     6. A failing staff endpoint: unavailable + Retry, never demo data, the
        rest of the app untouched; Retry loads again; an ended session says so.
     7. No backend, a failed hydration, signed out: nothing read, nothing
        shown -- even with demo staff and demo mechanics in browser storage. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

const MECHANICS = [
  { id: 'MEC-0001', name: 'Karim Mia', phone: '01811-111111', specialization: 'Engine', salary: 25000, commissionRate: 5, status: 'Active' },
];
const st = (id, extra) => ({ id, isMechanic: false, employeeCode: '', name: 'Staff', designation: 'Helper', department: 'Workshop',
  phone: '01700000000', email: '', joiningDate: '', status: 'Active', createdAt: '2026-10-01T00:00:00.000Z', ...extra });
const STAFF = [
  st('MEC-0001', { isMechanic: true, name: 'Karim Mia', designation: 'Senior Mechanic', department: 'Workshop', employeeCode: 'TQ-001',
    phone: '01811-111111', joiningDate: '2023-02-06' }),
  st('STF-0001', { name: 'Nadia Akter', designation: 'Accountant', department: 'Accounts', employeeCode: 'TQ-101',
    phone: '01911-000101', email: 'nadia@example.com', joiningDate: '2024-03-01' }),
  st('STF-0002', { name: '<img src=x onerror=alert(1)>', designation: 'Service Advisor', department: 'Front Desk', phone: '01922-000202', status: 'Inactive' }),
  st('STF-0003', { name: 'Bashir', designation: 'Helper', department: 'Workshop', phone: '01933-000303', joiningDate: '2025-07-21' }),
];

/** fakeApi for the hydrated collections; /staff answered as the Worker would. */
function api({ staff = STAFF, failStaff = null, failTimes = Infinity, failPut = null, mechanicsFail = false } = {}) {
  const base = fakeApi({
    rows: { mechanics: MECHANICS },
    fail: mechanicsFail ? ({ path }) => (path.startsWith('/mechanics') ? { status: 500, error: { code: 'database_error', message: 'x' } } : null) : null,
  });
  const calls = base.calls;
  const db = JSON.parse(JSON.stringify(staff));
  let failures = 0;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (!path.startsWith('/staff')) return base(url, init);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (failStaff && failures < failTimes) { failures++; return res(failStaff.status, { error: failStaff.error }); }
    const [, , id] = path.split('?')[0].split('/');
    if (method === 'GET' && !id) return res(200, { data: db, count: db.length, total: db.length, limit: 1000, offset: 0 });
    const row = db.find(s => s.id === id);
    if (!row) return res(404, { error: { code: 'not_found', message: 'No staff member with that id.' } });
    if (method === 'GET') return res(200, { data: { ...row, address: 'Mirpur <b>10</b>', notes: '', ...(row.isMechanic ? { specialization: 'Engine', altPhone: '', employmentType: 'Full-time' } : {}) } });
    if (method === 'PUT') {
      if (failPut) return res(failPut.status, { error: failPut.error });
      Object.assign(row, body, { updatedAt: '2026-10-22T00:00:00.000Z' });
      return res(200, { data: row });
    }
    return res(405, { error: { code: 'method_not_allowed', message: 'Allowed: GET, PUT' } });
  };
  fn.calls = calls;
  return fn;
}

function page({ origin = 'http://localhost:8787', fetch, plantDemo = false } = {}) {
  const h = boot({ origin, fetch, modules: ['js/staff-form.js', 'js/staff-list.js'] });
  vm.runInContext('globalThis.StaffList = StaffList;', h.ctx);
  if (plantDemo) {
    // Rows planted in browser storage under the staff collection's own name must never show.
    h.ctx.localStorage.setItem('taqwa_staff', JSON.stringify([st('STF-9999', { name: 'DEMO ROW' })]));
  }
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, S: h.ctx.StaffList };
}
const countRows = html => (html.match(/<tr data-id=/g) || []).length;
const rowIds = html => [...html.matchAll(/<tr data-id="([^"]+)"/g)].map(m => m[1]);
const CONTROLS = ['stlSearch', 'stlDesignation', 'stlDepartment', 'stlStatus', 'stlSort', 'stlClear'];
const click = (el, action, id) => el('stlBody').dispatch('click', { target: { closest: () => ({ dataset: { action, id }, disabled: false }) } });

(async () => {
console.log('=== staff-list: Staff List ===\n');

/* ---------- 1. helpers ---------- */
console.log('-- 1. helpers --');
{
  const { S } = page({ origin: '' });
  check('dates: split, never parsed', [S.fmtDay('2024-03-01'), S.fmtDay(''), S.fmtDay('2024-3-1')], ['01 Mar 2024', '', '']);
  const m = q => STAFF.filter(s => S.matchesSearch(s, q)).map(s => s.id);
  check('search: name, any case', m('NADIA'), ['STF-0001']);
  check('search: staff ID', m('stf-0003'), ['STF-0003']);
  check('search: employee code', m('tq-001'), ['MEC-0001']);
  check('search: email', m('nadia@'), ['STF-0001']);
  check('search: phone digits, separators ignored', m('0191 1000 101'), ['STF-0001']);
  check('search: a code is not matched against phone numbers', m('TQ-101'), ['STF-0001']);
  check('search: blank matches everyone', m('  ').length, 4);
  check('filter: designation', S.filterRows(STAFF, { designation: 'Helper' }).map(s => s.id), ['STF-0003']);
  check('filter: department', S.filterRows(STAFF, { department: 'Workshop' }).map(s => s.id), ['MEC-0001', 'STF-0003']);
  check('filter: status', S.filterRows(STAFF, { status: 'Inactive' }).map(s => s.id), ['STF-0002']);
  check('filters and search combine', S.filterRows(STAFF, { department: 'Workshop', search: 'bash' }).map(s => s.id), ['STF-0003']);
  const names = sort => S.sortRows(STAFF, sort).map(s => s.id);
  check('sort: name A–Z', names('name-asc'), ['STF-0002', 'STF-0003', 'MEC-0001', 'STF-0001']);
  check('sort: name Z–A', names('name-desc'), ['STF-0001', 'MEC-0001', 'STF-0003', 'STF-0002']);
  check('sort: joining date newest first, unrecorded last', names('joined-desc'), ['STF-0003', 'STF-0001', 'MEC-0001', 'STF-0002']);
  check('sort: joining date oldest first, unrecorded still last', names('joined-asc'), ['MEC-0001', 'STF-0001', 'STF-0003', 'STF-0002']);
  check('sort: status, Active first', names('status').slice(-1), ['STF-0002']);
  check('sorting never changes the list it was given', STAFF.map(s => s.id), ['MEC-0001', 'STF-0001', 'STF-0002', 'STF-0003']);
  const many = Array.from({ length: 26 }, (_, i) => st(`STF-${String(i + 1).padStart(4, '0')}`));
  check('paging: 0 rows', (({ items, from, to, pages }) => [items.length, from, to, pages])(S.paginate([], 1, 25)), [0, 0, 0, 1]);
  check('paging: 25 rows is one page', S.paginate(many.slice(0, 25), 1, 25).pages, 1);
  check('paging: 26 rows, page 2 holds one', (({ items, from, to, pages }) => [items.length, from, to, pages])(S.paginate(many, 2, 25)), [1, 26, 26, 2]);
  check('paging: a page past the end is clamped', S.paginate(many, 9, 25).page, 2);
  check('paging: page size 10', S.paginate(many, 3, 10).items.length, 6);
  check('filter options: only values in use, sorted', JSON.parse(JSON.stringify(S.facets(STAFF))),
    { designations: ['Accountant', 'Helper', 'Senior Mechanic', 'Service Advisor'], departments: ['Accounts', 'Front Desk', 'Workshop'] });

  const v = (x, opt) => Object.keys(S.validateStaff({ name: 'A', phone: '01700000000', status: 'Active', designation: 'Clerk', department: 'Front', ...x },
    { today: '2026-10-22', ...opt })).sort();
  check('validation: a complete record passes', v({}), []);
  check('validation: name, phone, designation and department are required', v({ name: ' ', phone: '', designation: '', department: '' }),
    ['department', 'designation', 'name', 'phone']);
  check('validation: a mechanic needs a specialization, not a designation or department', v({ designation: '', department: '' }, { isMechanic: true }), ['specialization']);
  check('validation: phone, email and employee-code formats', v({ phone: 'call me', email: 'x@', employeeCode: 'TQ 1' }), ['email', 'employeeCode', 'phone']);
  check('validation: joining date not in the future, not before 1980', [v({ joiningDate: '2026-10-23' }), v({ joiningDate: '1979-12-31' }), v({ joiningDate: '2026-10-22' })],
    [['joiningDate'], ['joiningDate'], []]);
  check('validation: the Worker\'s length limits', v({ name: 'n'.repeat(121), employeeCode: 'C'.repeat(21), notes: 'x'.repeat(1001) }), ['employeeCode', 'name', 'notes']);
  check('validation: status must be Active or Inactive', v({ status: 'Retired' }), ['status']);
  const p = S.payload({ name: 'A', phone: '1', email: '', address: '', joiningDate: '', status: 'Active', notes: '', employeeCode: 'TQ-9', designation: 'Clerk', department: 'Front', specialization: 'Engine', salary: 9 });
  ok('payload: never carries pay, even if offered', !/salary|commission/i.test(JSON.stringify(p)), JSON.stringify(p));
  check('payload: a create says whether the person is a mechanic; an edit does not',
    [p.isMechanic, 'isMechanic' in S.payload({}, { mode: 'edit' }), S.payload({}, { isMechanic: true }).isMechanic], [false, false, true]);
  check('payload: specialization only for a mechanic', ['specialization' in p, S.payload({ specialization: 'Engine' }, { isMechanic: true }).specialization], [false, 'Engine']);
}

/* ---------- 2. the page, connected ---------- */
console.log('\n-- 2. the page in api mode --');
{
  const f = api();
  const { h, el, S } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  ok('staff are loaded on demand, as a paged GET', f.calls.some(c => c.path === '/staff?limit=1000&offset=0'), JSON.stringify(f.calls.map(c => c.path)));
  ok('   ...and nothing is written by loading', !f.calls.some(c => c.method && c.method !== 'GET'), '');
  ok('the controls are enabled once loaded', CONTROLS.every(id => el(id).disabled === false), '');
  const html = el('stlBody').innerHTML;
  check('every staff member is a row, sorted by name', rowIds(html), ['STF-0002', 'STF-0003', 'MEC-0001', 'STF-0001']);
  ok('   ...with every value escaped', !html.includes('<img src=x') && html.includes('&lt;img src=x onerror=alert(1)&gt;'), '');
  ok('   ...and no pay, though the mechanic has a salary', !/salary|commission|25000/i.test(html), '');
  ok('   ...code, designation, department, phone, email, status and joining date shown',
    html.includes('TQ-101') && html.includes('Accountant') && html.includes('Accounts') && html.includes('01911-000101')
      && html.includes('nadia@example.com') && html.includes('01 Mar 2024') && /badge--good">Active/.test(html) && /badge--bad">Inactive/.test(html), '');
  ok('   ...a missing value reads "Not set" / "Not recorded" / "No code", never blank', /Not recorded/.test(html) && /No code/.test(html), '');
  ok('   ...View and Edit on every row; Deactivate on Active, Activate on Inactive',
    countRows(html) === (html.match(/data-action="view"/g) || []).length && countRows(html) === (html.match(/data-action="edit"/g) || []).length
      && /data-action="deactivate" data-id="STF-0001"/.test(html) && /data-action="activate" data-id="STF-0002"/.test(html)
      && !/data-action="(delete|remove)"/.test(html), '');
  ok('   ...every action button is labelled for assistive technology', (html.match(/<button type="button" class="icon-btn[^"]*" data-action="[a-z]+" data-id="[^"]+"\s+title="[^"]+" aria-label="[^"]+"/g) || []).length === countRows(html) * 3, '');
  ok('the designation and department filters list the values in use',
    /<option value="Service Advisor">/.test(el('stlDesignation').innerHTML) && /<option value="Front Desk">/.test(el('stlDepartment').innerHTML), el('stlDesignation').innerHTML);
  check('the count says how many are shown of how many', el('stlCount').textContent, '4 of 4 staff');
  check('   ...and the pager says which rows', [el('stlFoot').hidden, el('stlRange').textContent], [false, 'Showing 1–4 of 4']);

  el('stlSearch').dispatch('input', { target: { value: 'nadia' } });
  await tick(260);
  check('search (debounced) narrows the rows', rowIds(el('stlBody').innerHTML), ['STF-0001']);
  el('stlSearch').dispatch('input', { target: { value: '' } });
  await tick(260);
  el('stlDepartment').dispatch('change', { target: { value: 'Workshop' } });
  check('the department filter', rowIds(el('stlBody').innerHTML), ['STF-0003', 'MEC-0001']);
  el('stlStatus').dispatch('change', { target: { value: 'Inactive' } });
  ok('filters combine; none match -> a clear message with Clear filters',
    /No staff match your search or filters/.test(el('stlBody').innerHTML) && /data-action="clear"/.test(el('stlBody').innerHTML) && el('stlFoot').hidden === true, '');
  check('   ...and the count says so', el('stlCount').textContent, 'No matches among 4 staff');
  click(el, 'clear');
  check('Clear filters brings everyone back', countRows(el('stlBody').innerHTML), 4);
  check('   ...and resets the controls', ['stlDesignation', 'stlDepartment', 'stlStatus'].map(id => el(id).value), ['all', 'all', 'all']);
  el('stlStatus').dispatch('change', { target: { value: 'Retired' } });
  check('an unknown status value is ignored, not trusted', [S.state.status, countRows(el('stlBody').innerHTML)], ['all', 4]);
  el('stlSort').dispatch('change', { target: { value: 'joined-desc' } });
  check('sort: joining date, newest first', rowIds(el('stlBody').innerHTML), ['STF-0003', 'STF-0001', 'MEC-0001', 'STF-0002']);
  el('stlSort').dispatch('change', { target: { value: 'name-asc' } });
}
{
  const many = Array.from({ length: 30 }, (_, i) => st(`STF-${String(i + 1).padStart(4, '0')}`, { name: `Person ${String(i + 1).padStart(2, '0')}`, phone: `0170000${String(i).padStart(4, '0')}` }));
  const { h, el, S } = page({ fetch: api({ staff: many }) });
  h.fireReady();
  await tick(80);
  check('25 rows per page by default', [countRows(el('stlBody').innerHTML), el('stlRange').textContent, el('stlPrev').disabled, el('stlNext').disabled],
    [25, 'Showing 1–25 of 30', true, false]);
  el('stlNext').dispatch('click');
  check('Next shows the rest', [countRows(el('stlBody').innerHTML), el('stlRange').textContent, el('stlNext').disabled], [5, 'Showing 26–30 of 30', true]);
  el('stlPageSize').dispatch('change', { target: { value: '10' } });
  check('a page size of 10 starts again at page 1', [countRows(el('stlBody').innerHTML), el('stlRange').textContent], [10, 'Showing 1–10 of 30']);
  el('stlPageSize').dispatch('change', { target: { value: '7' } });
  check('an unknown page size falls back to 25', S.state.pageSize, 25);
  el('stlNext').dispatch('click');
  el('stlSearch').dispatch('input', { target: { value: 'Person 0' } });
  await tick(260);
  check('a new search goes back to page 1', [S.state.page, countRows(el('stlBody').innerHTML)], [1, 9]);
}

/* ---------- 3. empty roster ---------- */
console.log('\n-- 3. an empty roster --');
{
  const { h, el } = page({ fetch: api({ staff: [] }) });
  h.fireReady();
  await tick(80);
  const html = el('stlBody').innerHTML;
  ok('an empty database: "No staff yet", with Add Staff', /No staff yet/.test(html) && /data-action="add"/.test(html) && !/No staff match/.test(html), html.slice(0, 200));
  ok('   ...Add Staff is a link to the Add Staff page, not a dialog', /<a class="btn btn--primary btn--sm" href="staff-add.html" data-action="add">Add Staff<\/a>/.test(html), html);
  ok('   ...and no pager', el('stlFoot').hidden === true, '');
}

/* ---------- 3b. back from Add Staff ---------- */
console.log('\n-- 3b. back from Add Staff (?added=) --');
{
  const { h, el } = page({ fetch: api() });
  h.ctx.location.search = '?added=STF-0003';
  h.ctx.location.pathname = '/pages/staff-list.html';
  const toasts = [], replaced = [];
  h.ctx.Utils.toast = (msg, type) => toasts.push([msg, type]);
  h.ctx.history = { replaceState: (s, t, url) => replaced.push(url) };
  h.fireReady();
  await tick(80);
  check('the new record is confirmed once, named as the database returned it', JSON.stringify(toasts), JSON.stringify([['Bashir was added (STF-0003).', 'success']]));
  check('   ...and the marker leaves the address, so a refresh does not say it again', replaced, ['/pages/staff-list.html']);
  ok('   ...the new record is in the list, read fresh from the database', rowIds(el('stlBody').innerHTML).includes('STF-0003'), '');
}
{
  const { h } = page({ fetch: api() });
  h.ctx.location.search = '?added=STF-9999';
  const toasts = [];
  h.ctx.Utils.toast = (msg, type) => toasts.push([msg, type]);
  h.fireReady();
  await tick(80);
  check('an id that is not in the list confirms nothing', toasts.length, 0);
}
{
  const { h } = page({ fetch: api({ failStaff: { status: 500, error: { code: 'database_error', message: 'x' } } }) });
  h.ctx.location.search = '?added=STF-0003';
  const toasts = [];
  h.ctx.Utils.toast = (msg, type) => toasts.push([msg, type]);
  h.fireReady();
  await tick(80);
  check('a list that could not load confirms nothing', toasts.length, 0);
}

/* ---------- 4. status changes ---------- */
console.log('\n-- 4. status changes --');
{
  const f = api();
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  let confirmed = null;
  h.ctx.Utils.Modal.confirm = (opts) => { confirmed = opts; };
  click(el, 'deactivate', 'STF-0001');
  ok('Deactivate asks first, and says nothing is deleted', confirmed && /Deactivate/.test(confirmed.confirmText) && /Nothing is deleted/.test(confirmed.message), '');
  ok('   ...and the question escapes the name', !/<img/.test(confirmed.message), '');
  check('   ...nothing is sent before confirming', f.calls.filter(c => c.method === 'PUT').length, 0);
  await confirmed.onConfirm();
  await tick(20);
  const put = f.calls.find(c => c.method === 'PUT');
  check('confirming sends PUT /staff/:id with only the status', [put && put.path, put && JSON.stringify(put.body)], ['/staff/STF-0001', '{"status":"Inactive"}']);
  ok('   ...and the row follows the answer', /data-action="activate" data-id="STF-0001"/.test(el('stlBody').innerHTML), '');
  click(el, 'activate', 'STF-0002');
  await tick(40);
  check('Activate needs no confirmation and sends Active', JSON.stringify(f.calls.filter(c => c.method === 'PUT').map(c => [c.path, c.body.status])),
    JSON.stringify([['/staff/STF-0001', 'Inactive'], ['/staff/STF-0002', 'Active']]));
}
{
  const f = api({ failPut: { status: 409, error: { code: 'conflict', message: 'A staff member with this phone number already exists.' } } });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  click(el, 'activate', 'STF-0002');
  await tick(40);
  ok('a refused status change leaves the row as it was', /data-action="activate" data-id="STF-0002"/.test(el('stlBody').innerHTML), '');
}

/* ---------- 5. view ---------- */
console.log('\n-- 5. view --');
{
  const f = api();
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  let opened = null;
  h.ctx.Utils.Modal.open = (opts) => { opened = opts; return { querySelector: () => ({ addEventListener() {} }) }; };
  click(el, 'view', 'MEC-0001');
  await tick(40);
  ok('View reads the full record fresh (GET /staff/:id)', f.calls.some(c => c.method === 'GET' && c.path === '/staff/MEC-0001'), '');
  ok('   ...and shows designation, address (escaped) and the mechanic\'s specialization',
    opened && /Senior Mechanic/.test(opened.body) && opened.body.includes('Mirpur &lt;b&gt;10&lt;/b&gt;') && /Engine/.test(opened.body), opened && opened.body.slice(0, 300));
  ok('   ...but never pay; it points to the Mechanics page for that', !/salary|commission|25000/i.test(opened.body) && /mechanics\.html/.test(opened.body), '');
  opened = null;
  click(el, 'view', 'STF-0404');
  await tick(60);
  ok('viewing someone who no longer exists opens nothing and reloads the list', opened === null
    && f.calls.filter(c => c.path === '/staff?limit=1000&offset=0').length === 2, '');
}

/* ---------- 6. failures ---------- */
console.log('\n-- 6. a failing staff endpoint --');
{
  const f = api({ failStaff: { status: 500, error: { code: 'database_error', message: 'Could not read staff.' } }, failTimes: 1 });
  const { h, el, S } = page({ fetch: f, plantDemo: true });
  h.fireReady();
  await tick(80);
  const html = el('stlBody').innerHTML;
  ok('the page says the staff list could not be loaded, with Retry', /could not be loaded/.test(html) && /data-action="retry"/.test(html), html.slice(0, 300));
  ok('   ...shows no row at all, demo or otherwise', countRows(html) === 0 && !/DEMO ROW|Demo Staff/.test(html), '');
  ok('   ...says nothing from the browser is used instead', /Nothing stored in this browser is used/.test(html), '');
  ok('   ...every control disabled', CONTROLS.every(id => el(id).disabled === true), '');
  check('   ...while the app itself stays in api mode with its other data', [h.ctx.Storage.mode, h.ctx.Storage.getData('mechanics').length], ['api', 1]);
  await S.load();                   // what the Retry button runs
  await tick(40);
  ok('Retry loads again and now succeeds', countRows(el('stlBody').innerHTML) === 4 && el('stlSearch').disabled === false, '');
}
{
  const { h, el } = page({ fetch: api({ failStaff: { status: 0, error: { code: 'timeout', message: 'slow' } } }), plantDemo: true });
  h.fireReady();
  await tick(80);
  ok('a timeout is treated the same way: unavailable, no rows', /could not be loaded/.test(el('stlBody').innerHTML) && countRows(el('stlBody').innerHTML) === 0, '');
}
{
  const { h, el } = page({ fetch: api({ failStaff: { status: 401, error: { code: 'unauthorized', message: 'Authentication required.' } } }) });
  h.fireReady();
  await tick(80);
  const html = el('stlBody').innerHTML;
  ok('a session that ended says so and offers to sign in again, showing no one', /Your session has ended/.test(html) && /data-action="signin"/.test(html) && countRows(html) === 0, html.slice(0, 200));
}

/* ---------- 7. no backend, failed hydration, signed out ---------- */
console.log('\n-- 7. no backend, a failed hydration, signed out --');
{
  const { h, el } = page({ origin: '', plantDemo: true });
  h.ctx.Storage.seedIfEmpty();
  h.fireReady();
  await tick(40);
  const html = el('stlBody').innerHTML;
  ok('no backend: the page says it needs the workshop database', /needs the workshop database/.test(html), html.slice(0, 200));
  ok('   ...offers no Retry', !/data-action="retry"/.test(html), '');
  ok('   ...and shows no one: not the planted staff row, not the demo mechanics', countRows(html) === 0 && !/DEMO ROW/.test(html)
    && h.ctx.Storage.getData('mechanics').length > 0, '');
  ok('   ...and no longer claims nothing can be added here (Add Staff explains that for itself)', !/none can be added/.test(html), '');
  const w = await h.ctx.Storage.create('staff', { name: 'x' });
  check('   ...and Storage refuses to write staff to browser storage', [w.ok, w.code], [false, 'no_api']);
}
{
  const f = api({ mechanicsFail: true });
  const { h, el } = page({ fetch: f, plantDemo: true });
  h.fireReady();
  await tick(80);
  const html = el('stlBody').innerHTML;
  ok('a failed hydration (the app fell back to browser storage): the Staff List still shows no one',
    h.ctx.Storage.mode === 'local' && /needs the workshop database/.test(html) && countRows(html) === 0, html.slice(0, 200));
  ok('   ...and never asked for /staff', !f.calls.some(c => c.path.startsWith('/staff')), '');
}
{
  const f = fakeApi({ authenticated: false });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  ok('signed out: nothing is requested from /staff', !f.calls.some(c => c.path.startsWith('/staff')), JSON.stringify(f.calls.map(c => c.path)));
  check('   ...and no row is shown', countRows(el('stlBody').innerHTML), 0);
}

process.exit(summary('staff-list') === 0 ? 0 : 1);
})();
