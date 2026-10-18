/* crm-tasks — Customer CRM › Follow-up Tasks, connected to the database.

   Drives the REAL js/crm-tasks.js (with the real api.js, storage.js and
   utils.js) through the shared harness, against a fake API that answers the
   follow-up-task routes the way the Worker does.

     1. Dates: today is the Asia/Dhaka day; Due Today / Overdue for open
        tasks only.
     2. KPIs: Total (all but Cancelled), Due Today, Overdue, Completed;
        filters and pages never change them.
     3. Rows: names from customers / vehicles / job cards / staff, safe
        fallbacks when missing, deterministic order, duplicates dropped.
     4. Search (task, customer, phone, registration, job card, staff) and
        the status / priority / staff / due-by filters.
     5. Pagination: 0, 25 and 26 rows; the page is clamped.
     6. Validation mirrors the Worker: limits, references need a customer,
        priorities, real calendar dates.
     7. Idempotent submissions: a secure key per dialog, frozen after an
        ambiguous answer, never a Math.random key.
     8. The page in 'api' mode: loads on demand, cards, escaped rows, actions
        only where they apply, filters reset the page, Clear filters, Start.
     9. An empty database: an honest empty state.
    10. A failing task endpoint: unavailable + Retry, never demo data, every
        other collection untouched; Retry loads again.
    11. No backend / signed out: nothing read, nothing shown. */
const vm = require('vm');
const { webcrypto } = require('crypto');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

const CUSTOMERS = [
  { id: 'CUS-0001', name: 'Rahim Uddin', phone: '+880 1712-345678', status: 'Active' },
  { id: 'CUS-0002', name: '<img src=x onerror=alert(1)>', phone: '017', status: 'Active' },
];
const VEHICLES = [
  { id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHAKA-GA-1234', brand: 'Toyota', model: 'Corolla', status: 'Active' },
  { id: 'VEH-0002', customerId: 'CUS-0002', regNo: 'CTG-KHA-5678', brand: 'Honda', model: 'Civic', status: 'Active' },
];
const JOB_CARDS = [
  { id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', date: '2026-10-01', status: 'Completed' },
];
const MECHANICS = [
  { id: 'MEC-0001', name: 'Karim Mia', status: 'Active' },
  { id: 'MEC-0002', name: 'Old Hand', status: 'Inactive' },
];
const TODAY = '2026-10-14';
const tk = (id, extra) => ({ id, title: 'Call back', description: '', customerId: 'CUS-0001', vehicleId: 'VEH-0001', jobCardId: null,
  assignedTo: null, priority: 'medium', dueDate: TODAY, status: 'Pending', startedAt: null, completedAt: null, completionNote: '',
  cancelledAt: null, cancelReason: '', createdBy: '', updatedBy: '',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra });
const TASKS = [
  tk('TSK-0001', { dueDate: '2026-10-13', assignedTo: 'MEC-0001', jobCardId: 'JOB-0001' }),                       // Overdue
  tk('TSK-0002', { dueDate: TODAY, priority: 'urgent', title: 'Order <b>pads</b>', status: 'In Progress', startedAt: '2026-10-13T05:00:00.000Z' }), // Due Today
  tk('TSK-0003', { dueDate: TODAY, priority: 'low' }),                                                               // Due Today
  tk('TSK-0004', { dueDate: '2026-10-20', customerId: null, vehicleId: null, title: 'Restock oil', assignedTo: 'MEC-0002' }),
  tk('TSK-0005', { dueDate: '2026-10-01', status: 'Completed', completedAt: '2026-10-05T00:00:00.000Z' }),         // never overdue
  tk('TSK-0006', { dueDate: '2026-10-01', status: 'Cancelled', cancelledAt: '2026-10-06T00:00:00.000Z', cancelReason: 'Sold' }),
  tk('TSK-0007', { customerId: 'CUS-0999', vehicleId: 'VEH-0999', jobCardId: 'JOB-0999', assignedTo: 'MEC-0999', dueDate: '2026-10-21', title: 'Orphan' }),
  tk('TSK-0008', { customerId: 'CUS-0002', vehicleId: 'VEH-0002', dueDate: '2026-10-22', priority: 'high', title: 'Estimate' }),
];

/** fakeApi for the hydrated collections; task paths answered as the Worker would. */
function api({ tasks = TASKS, failTasks = null, failTimes = Infinity } = {}) {
  const base = fakeApi({ rows: { customers: CUSTOMERS, vehicles: VEHICLES, 'job-cards': JOB_CARDS, mechanics: MECHANICS } });
  const calls = base.calls;
  const db = JSON.parse(JSON.stringify(tasks));
  let failures = 0;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (!path.startsWith('/follow-up-tasks')) return base(url, init);
    const method = init.method || 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    if (failTasks && failures < failTimes) { failures++; return res(failTasks.status, { error: failTasks.error }); }
    const [, , id, action] = path.split('?')[0].split('/');
    if (method === 'POST' && id && action === 'start') {
      const t = db.find(x => x.id === id);
      if (!t) return res(404, { error: { code: 'not_found', message: 'No such task.' } });
      if (t.status !== 'Pending') return res(409, { error: { code: 'conflict', reason: 'invalid_transition', currentStatus: t.status, message: 'Not pending.' } });
      Object.assign(t, { status: 'In Progress', startedAt: '2026-10-14T06:00:00.000Z', updatedAt: '2026-10-14T06:00:00.000Z' });
      return res(200, { data: t });
    }
    return res(200, { data: db, count: db.length, total: db.length, limit: 1000, offset: 0 });
  };
  fn.calls = calls;
  return fn;
}

function page({ origin = 'http://localhost:8787', fetch, cryptoObj = webcrypto, seedDemo = false } = {}) {
  const h = boot({
    origin, fetch, modules: ['js/crm-tasks.js'],
    beforeModules(doc, ctx) { ctx.crypto = cryptoObj; ctx.Uint8Array = Uint8Array; },
  });
  vm.runInContext('globalThis.CrmTasks = CrmTasks;', h.ctx);
  if (seedDemo) {
    // A row planted in browser storage under the tasks' own name must never show.
    h.ctx.localStorage.setItem('taqwa_followUpTasks', JSON.stringify([tk('TSK-9999', { title: 'DEMO ROW' })]));
  }
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, T: h.ctx.CrmTasks };
}
const rowsOf = T => T.sortRows(T.buildRows({ tasks: TASKS, customers: CUSTOMERS, vehicles: VEHICLES, jobCards: JOB_CARDS, mechanics: MECHANICS, today: TODAY }));
const countRows = html => (html.match(/<tr data-id=/g) || []).length;

(async () => {
console.log('=== crm-tasks: Follow-up Tasks ===\n');

/* ---------- 1. dates ---------- */
console.log('-- 1. Dhaka dates and due state --');
{
  const { T } = page({ origin: '' });
  check('17:59:59Z is still the same Dhaka day', T.dhakaToday(new Date('2026-10-13T17:59:59Z')), '2026-10-13');
  check('18:00:00Z is already the next Dhaka day', T.dhakaToday(new Date('2026-10-13T18:00:00Z')), '2026-10-14');
  check('open: before / on / after today -> overdue / today / none',
    ['2026-10-13', TODAY, '2026-10-15'].map(d => T.dueState(tk('X', { dueDate: d }), TODAY)), ['overdue', 'today', '']);
  check('In Progress counts as open', T.dueState(tk('X', { status: 'In Progress', dueDate: '2026-10-01' }), TODAY), 'overdue');
  check('a Completed or Cancelled task is never overdue or due',
    [T.dueState(tk('X', { status: 'Completed', dueDate: '2000-01-01' }), TODAY), T.dueState(tk('X', { status: 'Cancelled', dueDate: TODAY }), TODAY)], ['', '']);
  check('an unreadable due date gives no due state', T.dueState(tk('X', { dueDate: '2026-02-30' }), TODAY), '');
}

/* ---------- 2. KPIs ---------- */
console.log('\n-- 2. KPIs --');
{
  const { T } = page({ origin: '' });
  check('Total = every task except Cancelled (7 of 8); Due Today 2; Overdue 1; Completed 1',
    T.kpis(TASKS, TODAY), { total: 7, dueToday: 2, overdue: 1, completed: 1 });
  check('a Cancelled task due today is not Due Today', T.kpis([tk('X', { status: 'Cancelled', cancelledAt: 'x' })], TODAY), { total: 0, dueToday: 0, overdue: 0, completed: 0 });
  check('nothing at all', T.kpis([], TODAY), { total: 0, dueToday: 0, overdue: 0, completed: 0 });
}

/* ---------- 3. rows ---------- */
console.log('\n-- 3. rows --');
{
  const { T } = page({ origin: '' });
  const rows = T.buildRows({ tasks: [...TASKS, TASKS[0]], customers: CUSTOMERS, vehicles: VEHICLES, jobCards: JOB_CARDS, mechanics: MECHANICS, today: TODAY });
  check('a duplicated id is listed once', rows.length, 8);
  const first = rows.find(r => r.id === 'TSK-0001');
  check('names come from the loaded collections', [first.customerName, first.regNo, first.vehicleLabel, first.staffName, first.jobKnown],
    ['Rahim Uddin', 'DHAKA-GA-1234', 'Toyota Corolla', 'Karim Mia', true]);
  const orphan = rows.find(r => r.id === 'TSK-0007');
  check('missing references invent nothing', [orphan.customerName, orphan.vehicleKnown, orphan.jobKnown, orphan.staffName], ['', false, false, '']);
  const free = rows.find(r => r.id === 'TSK-0004');
  check('a task with no customer is fine', [free.customerId, free.vehicleKnown, free.jobKnown], ['', true, true]);
  check('an unknown priority reads as medium', T.buildRows({ tasks: [tk('X', { priority: 'nope' })], today: TODAY })[0].priority, 'medium');
  const sorted = rowsOf(T).map(r => r.id);
  check('order: open by due date (urgent first on the same day), then closed by most recent close',
    sorted, ['TSK-0001', 'TSK-0002', 'TSK-0003', 'TSK-0004', 'TSK-0007', 'TSK-0008', 'TSK-0006', 'TSK-0005']);
  check('   ...and the same input always gives the same order', T.sortRows(rowsOf(T).reverse()).map(r => r.id), sorted);
}

/* ---------- 4. search and filters ---------- */
console.log('\n-- 4. search and filters --');
{
  const { T } = page({ origin: '' });
  const rows = rowsOf(T);
  const ids = o => T.filterRows(rows, o).map(r => r.id);
  check('the default hides Cancelled only', ids({}), ['TSK-0001', 'TSK-0002', 'TSK-0003', 'TSK-0004', 'TSK-0007', 'TSK-0008', 'TSK-0005']);
  check('exact statuses', [ids({ status: 'Pending' }).length, ids({ status: 'In Progress' }), ids({ status: 'Completed' }), ids({ status: 'Cancelled' })],
    [5, ['TSK-0002'], ['TSK-0005'], ['TSK-0006']]);
  check('Overdue: open and past due only', ids({ status: 'overdue' }), ['TSK-0001']);
  check('priority', [ids({ priority: 'urgent' }), ids({ priority: 'high' })], [['TSK-0002'], ['TSK-0008']]);
  check('staff: one person / unassigned', [ids({ staff: 'MEC-0001' }), ids({ staff: 'none' }).includes('TSK-0001')], [['TSK-0001'], false]);
  check('due by: on or before the date', ids({ dueBy: TODAY }), ['TSK-0001', 'TSK-0002', 'TSK-0003', 'TSK-0005']);
  check('   ...an unreadable date is ignored', ids({ dueBy: '2026-13-40' }).length, 7);
  check('search by title', ids({ search: 'restock' }), ['TSK-0004']);
  check('search by customer name', ids({ search: 'rahim' }), ['TSK-0001', 'TSK-0002', 'TSK-0003', 'TSK-0005']);
  check('search by phone, however written', [ids({ search: '1712 345' }).length, ids({ search: '01712-345678' }).length], [4, 4]);
  check('search by registration with or without dashes', [ids({ search: 'ctg-kha' }), ids({ search: 'ctgkha5678' })], [['TSK-0008'], ['TSK-0008']]);
  check('search by job card', ids({ search: 'job-0001' }), ['TSK-0001']);
  check('search by staff name and task id', [ids({ search: 'karim' }), ids({ search: 'tsk-0007' })], [['TSK-0001'], ['TSK-0007']]);
  check('filters combine', ids({ search: 'rahim', priority: 'low' }), ['TSK-0003']);
}

/* ---------- 5. pagination ---------- */
console.log('\n-- 5. pagination --');
{
  const { T } = page({ origin: '' });
  const list = n => Array.from({ length: n }, (_, i) => i);
  const p0 = T.paginate([], 1);
  check('0 rows: one empty page', [p0.page, p0.pages, p0.from, p0.to, p0.items.length], [1, 1, 0, 0, 0]);
  const p25 = T.paginate(list(25), 1);
  check('25 rows: one full page', [p25.pages, p25.from, p25.to], [1, 1, 25]);
  const p26 = T.paginate(list(26), 2);
  check('26 rows: the second page holds one', [p26.pages, p26.from, p26.to, p26.items], [2, 26, 26, [25]]);
  check('a page past the end is clamped to the last', T.paginate(list(26), 9).page, 2);
  check('a nonsense page is page 1', [T.paginate(list(26), 0).page, T.paginate(list(26), 'x').page], [1, 1]);
  check('PAGE_SIZE is 25', T.PAGE_SIZE, 25);
}

/* ---------- 6. validation ---------- */
console.log('\n-- 6. validation --');
{
  const { T } = page({ origin: '' });
  const good = { title: 'x', description: '', customerId: '', vehicleId: '', jobCardId: '', priority: 'medium', dueDate: '2026-10-20', by: '' };
  check('a valid task (no customer needed) has no errors', T.validateTask(good), {});
  check('a title and a due date are required', Object.keys(T.validateTask({ ...good, title: '  ', dueDate: '' })).sort(), ['dueDate', 'title']);
  check('a vehicle or job card needs a customer', Object.keys(T.validateTask({ ...good, vehicleId: 'VEH-0001', jobCardId: 'JOB-0001' })).sort(), ['jobCardId', 'vehicleId']);
  check('limits: title 150, description 2000, name 100 (the same as the Worker)',
    [Object.keys(T.validateTask({ ...good, title: 't'.repeat(151), description: 'd'.repeat(2001), by: 'b'.repeat(101) })).sort(),
      T.validateTask({ ...good, title: 't'.repeat(150), description: 'd'.repeat(2000), by: 'b'.repeat(100) })], [['by', 'description', 'title'], {}]);
  check('priority must be one of the four', [Object.keys(T.validateTask({ ...good, priority: 'normal' })), T.PRIORITIES], [['priority'], ['low', 'medium', 'high', 'urgent']]);
  check('a past date is fine; an impossible one is refused', [T.validateTask({ ...good, dueDate: '2020-01-01' }), Object.keys(T.validateTask({ ...good, dueDate: '2026-02-30' }))], [{}, ['dueDate']]);
  check('LIMITS match the Worker', T.LIMITS, { title: 150, description: 2000, note: 500, reason: 500, name: 100 });
}

/* ---------- 7. idempotent submissions ---------- */
console.log('\n-- 7. idempotent submissions --');
{
  const { T } = page({ origin: '' });
  const k1 = T.newKey(webcrypto), k2 = T.newKey(webcrypto);
  ok('a key comes from crypto.randomUUID and is new each time', /^[0-9a-f-]{36}$/.test(k1) && k1 !== k2, `${k1} ${k2}`);
  const viaRandom = T.newKey({ getRandomValues: a => webcrypto.getRandomValues(a) });
  ok('   ...or from crypto.getRandomValues (32 hex characters)', /^[0-9a-f]{32}$/.test(viaRandom), viaRandom);
  check('   ...and with no secure source there is no key at all (no Math.random fallback)', T.newKey(null), null);
  const sub = T.createSubmission(webcrypto);
  sub.body({ title: 'a' });
  sub.settle({ ok: false, status: 422, code: 'unprocessable' });
  check('a definitive refusal (422) does not freeze', sub.frozen, false);
  const b2 = sub.body({ title: 'b' });
  sub.settle({ ok: false, status: 503 });
  check('a 5xx freezes the submission', sub.frozen, true);
  check('   ...and a retry resends exactly the frozen payload and key', sub.body({ title: 'changed' }), { title: 'b', idempotencyKey: sub.key });
  check('   ...which is the payload sent before', b2, { title: 'b', idempotencyKey: sub.key });
  check('ambiguous: timeout, network, malformed, 0, 5xx; definitive: ok, 4xx',
    [{ ok: false, code: 'timeout' }, { ok: false, code: 'network_error' }, { ok: false, code: 'malformed_response' }, { ok: false, status: 0 }, { ok: false, status: 500 },
      { ok: true }, { ok: false, status: 400 }, { ok: false, status: 409 }, { ok: false, status: 422 }].map(r => T.isAmbiguous(r)),
    [true, true, true, true, true, false, false, false, false]);
  check('without a secure key the submission refuses to produce a body', T.createSubmission(null).body({ title: 'a' }), null);
}

/* ---------- 8. the page, connected ---------- */
console.log('\n-- 8. the page in api mode --');
{
  const f = api();
  const { h, el, T } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  ok('tasks are loaded on demand, as a paged GET', f.calls.some(c => c.path === '/follow-up-tasks?limit=1000&offset=0'),
    JSON.stringify(f.calls.map(c => c.path)));
  ok('   ...and nothing is written by loading', !f.calls.some(c => c.method && c.method !== 'GET'), JSON.stringify(f.calls.filter(c => c.method !== 'GET')));
  ok('controls and the New button are enabled', ['ctkSearch', 'ctkStatus', 'ctkPriority', 'ctkStaff', 'ctkDue', 'ctkClear', 'ctkNew'].every(id => el(id).disabled === false), '');
  const k = T.kpis(TASKS, T.dhakaToday());
  const cards = () => ['ctkTotal', 'ctkDueToday', 'ctkOverdue', 'ctkCompleted'].map(id => el(id).innerHTML);
  check('the cards show the whole-list counts', cards(), [k.total, k.dueToday, k.overdue, k.completed].map(String));
  const html = el('ctkBody').innerHTML;
  check('the rows are rendered (Cancelled hidden by default)', countRows(html), 7);
  ok('   ...with every value escaped (no live HTML from a customer name or title)',
    !html.includes('<img src=x') && html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('Order &lt;b&gt;pads&lt;/b&gt;'), '');
  ok('   ...unknown customer / vehicle / staff shown as such, with their ids',
    /Unknown customer/.test(html) && html.includes('Unknown vehicle (VEH-0999)') && html.includes('Unknown staff (MEC-0999)') && html.includes('JOB-0999 (not found)'), '');
  ok('   ...a known job card links to it', html.includes('href="job-cards.html?view=JOB-0001"'), '');
  ok('   ...Start only on a Pending task; Edit / Complete on open ones',
    /data-action="start" data-id="TSK-0001"/.test(html) && !/data-action="start" data-id="TSK-0002"/.test(html) &&
    /data-action="edit" data-id="TSK-0002"/.test(html) && /data-action="complete" data-id="TSK-0002"/.test(html), '');
  ok('   ...a Completed task offers View only', /data-action="view" data-id="TSK-0005"/.test(html) && !/data-action="(edit|start|complete)" data-id="TSK-0005"/.test(html), '');
  ok('the staff filter lists active staff and anyone still assigned', /MEC-0001/.test(el('ctkStaff').innerHTML) && /Old Hand \(Inactive\)/.test(el('ctkStaff').innerHTML), el('ctkStaff').innerHTML);
  check('"Showing" counts the filtered rows against all loaded', el('ctkToolbarNote').textContent, 'Showing 1–7 of 7 tasks · filtered from 8');

  T.state.status = 'Cancelled'; T.renderList();
  ok('the Cancelled filter shows the cancelled task, without row actions',
    countRows(el('ctkBody').innerHTML) === 1 && /ctk-row--cancelled/.test(el('ctkBody').innerHTML) && !/data-action="edit"/.test(el('ctkBody').innerHTML), '');
  check('   ...while the cards do not change', cards(), [k.total, k.dueToday, k.overdue, k.completed].map(String));

  T.state.status = 'all'; T.state.search = 'zzzz-no-match'; T.renderList();
  ok('no matches: a clear message with Clear filters', /No tasks match your search or filters/.test(el('ctkBody').innerHTML) && /data-action="clear"/.test(el('ctkBody').innerHTML), '');
  ok('   ...and no pager', el('ctkPager').hidden === true, '');
  T.state.search = ''; T.renderList();

  // Start: the Worker's action, then the row and cards follow its answer.
  await T.startTask('TSK-0001');
  await tick(40);
  const post = f.calls.find(c => c.method === 'POST');
  check('Start posts the start action for that task only', post && post.path, '/follow-up-tasks/TSK-0001/start');
  ok('   ...and the row shows In Progress without Start', !/data-action="start" data-id="TSK-0001"/.test(el('ctkBody').innerHTML), '');
  const posts = f.calls.filter(c => c.method === 'POST').length;
  await T.startTask('TSK-0001');
  check('   ...a second Start on a task no longer pending sends nothing', f.calls.filter(c => c.method === 'POST').length, posts);
}
{
  // 30 open tasks: two pages, filters go back to page 1.
  const many = Array.from({ length: 30 }, (_, i) => tk(`TSK-${String(i + 1).padStart(4, '0')}`, { dueDate: '2026-11-01', title: i < 5 ? `Brake ${i}` : `Oil ${i}` }));
  const { h, el, T } = page({ fetch: api({ tasks: many }) });
  h.fireReady();
  await tick(80);
  check('25 rows on the first page, with the pager', [countRows(el('ctkBody').innerHTML), el('ctkPager').hidden, el('ctkRange').textContent, el('ctkPrev').disabled, el('ctkNext').disabled],
    [25, false, '1–25 of 30', true, false]);
  T.state.page = 2; T.renderList();
  check('page 2 holds the rest', [countRows(el('ctkBody').innerHTML), el('ctkRange').textContent, el('ctkNext').disabled], [5, '26–30 of 30', true]);
  check('   ...and the cards still count all 30', el('ctkTotal').innerHTML, '30');
  el('ctkStatus').value = 'Pending';
  el('ctkStatus').dispatch('change');
  check('changing a filter goes back to page 1', [T.state.status, T.state.page], ['Pending', 1]);
  el('ctkStatus').value = '<script>';
  el('ctkStatus').dispatch('change');
  check('   ...an unknown status value falls back to all', T.state.status, 'all');
  el('ctkSearch').dispatch('input', { target: { value: 'brake' } });
  await tick(260);   // the search waits 200 ms for typing to pause
  check('a narrower search: one page, "filtered from 30"', [countRows(el('ctkBody').innerHTML), el('ctkToolbarNote').textContent], [5, 'Showing 1–5 of 5 tasks · filtered from 30']);
  el('ctkPriority').value = 'urgent';
  el('ctkPriority').dispatch('change');
  ok('   ...no matches once urgent is added', /No tasks match/.test(el('ctkBody').innerHTML), '');
  el('ctkClear').dispatch('click');
  check('Clear filters resets every filter and the list', [T.state.search, T.state.status, T.state.priority, T.state.staff, T.state.dueBy, T.state.page, el('ctkSearch').value, countRows(el('ctkBody').innerHTML)],
    ['', 'all', 'all', 'all', '', 1, '', 25]);
}

/* ---------- 9. empty ---------- */
console.log('\n-- 9. an empty database --');
{
  const { h, el } = page({ fetch: api({ tasks: [] }) });
  h.fireReady();
  await tick(80);
  ok('an honest empty state', /No tasks yet/.test(el('ctkBody').innerHTML), el('ctkBody').innerHTML.slice(0, 200));
  check('   ...with zeros on the cards, not dashes', ['ctkTotal', 'ctkDueToday', 'ctkOverdue', 'ctkCompleted'].map(id => el(id).innerHTML), ['0', '0', '0', '0']);
  check('   ...and the New button enabled', el('ctkNew').disabled, false);
}

/* ---------- 10. failures ---------- */
console.log('\n-- 10. a failing task endpoint --');
{
  const f = api({ failTasks: { status: 500, error: { code: 'database_error', message: 'Could not read tasks.' } }, failTimes: 1 });
  const { h, el, T } = page({ fetch: f, seedDemo: true });
  h.fireReady();
  await tick(80);
  const html = el('ctkBody').innerHTML;
  ok('the page says the tasks could not be loaded, with Retry', /could not be loaded/.test(html) && /data-action="retry"/.test(html), html.slice(0, 300));
  ok('   ...shows no row at all, demo or otherwise', !/<tr data-id=/.test(html) && !/DEMO ROW/.test(html), '');
  check('   ...dashes on the cards', el('ctkTotal').innerHTML, '<span aria-hidden="true">&#8212;</span>');
  ok('   ...every control disabled', ['ctkSearch', 'ctkStatus', 'ctkPriority', 'ctkStaff', 'ctkDue', 'ctkClear', 'ctkNew'].every(id => el(id).disabled === true), '');
  check('   ...while the app itself stays in api mode with its other data', [h.ctx.Storage.mode, h.ctx.Storage.getData('customers').length], ['api', 2]);
  const before = f.calls.filter(c => c.path.startsWith('/follow-up-tasks')).length;
  await T.load();                 // what the Retry button runs
  await tick(40);
  ok('Retry loads again and now succeeds',
    f.calls.filter(c => c.path.startsWith('/follow-up-tasks')).length > before && /<tr data-id=/.test(el('ctkBody').innerHTML), '');
}
{
  const { h, el } = page({ fetch: api({ failTasks: { status: 0, error: { code: 'timeout', message: 'slow' } } }), seedDemo: true });
  h.fireReady();
  await tick(80);
  ok('a timeout is treated the same way: unavailable, no rows', /could not be loaded/.test(el('ctkBody').innerHTML) && !/<tr data-id=/.test(el('ctkBody').innerHTML), '');
}

/* ---------- 11. no backend / signed out ---------- */
console.log('\n-- 11. no backend, and signed out --');
{
  const { h, el } = page({ origin: '', seedDemo: true });
  h.ctx.Storage.seedIfEmpty();
  h.fireReady();
  await tick(40);
  const html = el('ctkBody').innerHTML;
  ok('no backend: the page says it needs the workshop database', /need the workshop database/.test(html), html.slice(0, 200));
  ok('   ...offers no Retry', !/data-action="retry"/.test(html), '');
  ok('   ...and shows none of the demo data, even with a planted task row', !/<tr data-id=/.test(html) && !/DEMO ROW/.test(html), '');
  check('   ...the New button stays disabled', el('ctkNew').disabled, true);
  const w = await h.ctx.Storage.create('followUpTasks', { title: 'x', dueDate: TODAY });
  check('   ...and Storage refuses to write a task to browser storage', [w.ok, w.code, h.ctx.localStorage.getItem('taqwa_followUpTasks').includes('"title":"x"')],
    [false, 'no_api', false]);
}
{
  const f = fakeApi({ authenticated: false });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(60);
  ok('signed out: nothing is read', !f.calls.some(c => c.path.startsWith('/follow-up-tasks')), JSON.stringify(f.calls.map(c => c.path)));
  ok('   ...and the loading row is left for the sign-in screen to cover', !/<tr data-id=/.test(el('ctkBody').innerHTML), '');
}

process.exit(summary('CRM tasks unit') === 0 ? 0 : 1);
})();
