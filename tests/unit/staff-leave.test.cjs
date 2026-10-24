/* staff-leave — Staff Management › Leave Management, connected to the database.

   Drives the REAL js/staff-leave.js (with the real api.js, storage.js,
   utils.js and app.js) through the shared harness, against a fake API that
   answers /api/leave-requests and /api/staff the way the Worker does.

     1. Helpers: days counted with both ends, the summary counted from real
        requests only, the filters, pending-first order, paging, the form
        rules, and rows that are escaped.
     2. The page in 'api' mode: the roster and the requests loaded on demand
        (nothing written), the cards and charts from the requests, the rows,
        the filters; no requests at all shows an empty state that offers one.
     3. Failures: a refused (403), failed (500) or ended (401) load each say so
        with no rows; no backend shows nothing and Storage refuses to write.
     4. Writes: New Leave Request lists only active staff and sends exactly
        { staffId, leaveType, startDate, endDate, reason }; invalid input sends
        nothing; an overlap (409) is shown on the form. Review approves or
        rejects through the action with expectedUpdatedAt; a rejection without a
        reason sends nothing; a refused decision (403) changes nothing; a
        request decided meanwhile (409) reloads instead of overwriting. */
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
const T0 = '2026-10-01T09:00:00.000Z';
const req = (id, staffId, leaveType, startDate, endDate, status = 'Pending', extra = {}) => {
  const s = STAFF.find(x => x.id === staffId) || {};
  return { id, staffId, isMechanic: staffId.startsWith('MEC'), staffName: s.name || staffId, department: s.department || '', designation: s.designation || '',
    leaveType, startDate, endDate, days: 0, reason: 'Family event', status, decidedAt: status === 'Pending' ? '' : T0, decidedBy: status === 'Pending' ? '' : 'Workshop passphrase',
    decisionNote: '', createdAt: T0, updatedAt: T0, ...extra };
};

function page({ origin = 'http://localhost:8787', fetch } = {}) {
  const h = boot({ origin, fetch, modules: ['js/staff-leave.js'] });
  vm.runInContext('globalThis.StaffLeave = StaffLeave;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, S: h.ctx.StaffLeave };
}

/** fakeApi for the hydrated collections; /leave-requests and /staff answered as the Worker would. */
function api({ requests = [], staff = STAFF, failList = null, failDecision = null } = {}) {
  const base = fakeApi({ rows: { mechanics: [] } });
  const calls = base.calls;
  const db = JSON.parse(JSON.stringify(requests));
  // A copy, as a real response is: the page never holds the fake database's own objects.
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(JSON.stringify(body)) });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (path === '/session' && method === 'GET') return res(200, { data: { authenticated: true, passphrase: true, accounts: true } });
    if (path.startsWith('/staff')) { calls.push({ method, path, body }); return res(200, { data: staff, total: staff.length }); }
    if (!path.startsWith('/leave-requests')) return base(url, init);
    calls.push({ method, path, body });
    const [p] = path.split('?');
    const [, , id, action] = p.split('/');
    if (method === 'GET' && !id) {
      if (failList) return res(failList.status, { error: failList.error });
      return res(200, { data: db, total: db.length });
    }
    if (method === 'POST' && !id) {
      const clash = db.find(r => r.staffId === body.staffId && r.status !== 'Rejected' && r.startDate <= body.endDate && r.endDate >= body.startDate);
      if (clash) {
        return res(409, { error: { code: 'conflict', reason: 'overlapping_request', conflictsWith: clash.id, message: 'Overlaps another request.',
          fields: { startDate: 'These dates overlap another pending or approved request.' } } });
      }
      const r = req(`LVR-000${db.length + 1}`, body.staffId, body.leaveType, body.startDate, body.endDate, 'Pending', { reason: body.reason, createdAt: '2026-10-03T09:00:00.000Z', updatedAt: '2026-10-03T09:00:00.000Z' });
      db.push(r);
      return res(201, { data: r });
    }
    const row = db.find(r => r.id === id);
    if (!row) return res(404, { error: { code: 'not_found', message: 'No leave request with that id.' } });
    if (method === 'POST' && (action === 'approve' || action === 'reject')) {
      if (failDecision) return res(failDecision.status, { error: failDecision.error });
      if (row.status !== 'Pending') return res(409, { error: { code: 'conflict', reason: 'already_decided', message: `Already ${row.status.toLowerCase()}.` } });
      if (body.expectedUpdatedAt !== row.updatedAt) return res(409, { error: { code: 'conflict', reason: 'concurrent_modification', message: 'Changed meanwhile.' } });
      Object.assign(row, { status: action === 'approve' ? 'Approved' : 'Rejected', decidedBy: 'Workshop passphrase', decidedAt: '2026-10-04T09:00:00.000Z',
        decisionNote: body.note || '', updatedAt: '2026-10-04T09:00:00.000Z' });
      return res(200, { data: row });
    }
    return res(405, { error: { code: 'method_not_allowed', message: 'x' } });
  };
  fn.calls = calls;
  fn.db = db;
  return fn;
}

const ids = html => [...html.matchAll(/<tr data-id="([^"]+)"/g)].map(m => m[1]);
const click = (el, action, id) => el('lvBody').dispatch('click', { target: { closest: () => ({ dataset: { action, id }, disabled: false }) } });

/** A stand-in for a dialog: inputs by selector, buttons by selector; values in, clicks out. */
function fakeModal(values, buttons) {
  const inputs = {};
  for (const [sel, value] of Object.entries(values)) { const e = makeElement(sel); e.value = value; inputs[sel] = e; }
  const btns = {};
  for (const sel of buttons) { btns[sel] = makeElement(sel); btns[sel]._on = {}; }
  const errs = {};
  const form = makeElement('form');
  form.querySelector = sel => {
    if (inputs[sel]) return inputs[sel];
    const m = /^\[data-err="([^"]+)"\]$/.exec(sel);
    if (!m) return null;
    if (!errs[m[1]]) { errs[m[1]] = makeElement(sel); errs[m[1]].closest = () => null; }
    return errs[m[1]];
  };
  form.querySelectorAll = () => [];
  const ov = { querySelector: sel => btns[sel] || (sel === '#lvForm' || sel === '#lvDecision' ? form : null) };
  const press = sel => Promise.all((btns[sel]._on.click || []).map(cb => cb({ currentTarget: btns[sel] })));
  return { ov, inputs, form, errs, press };
}

(async () => {
console.log('=== staff-leave: Leave Management ===\n');

/* ---------- 1. helpers ---------- */
console.log('-- 1. helpers --');
{
  const { S } = page({ origin: '' });
  check('days include both ends, across a month end and a leap day', [S.leaveDays('2026-10-13', '2026-10-15'), S.leaveDays('2026-10-27', '2026-10-27'),
    S.leaveDays('2026-10-31', '2026-11-02'), S.leaveDays('2028-02-28', '2028-03-01')], [3, 1, 3, 3]);
  const list = [req('LVR-0001', 'MEC-0001', 'Casual', '2026-10-13', '2026-10-15', 'Approved'), req('LVR-0002', 'STF-0001', 'Sick', '2026-10-05', '2026-10-05', 'Rejected'),
    req('LVR-0003', 'MEC-0002', 'Annual', '2026-11-02', '2026-11-06'), req('LVR-0004', 'MEC-0001', 'Unpaid', '2026-12-01', '2026-12-02', 'Pending', { createdAt: '2026-09-01T00:00:00.000Z' })];
  const s = S.summary(list);
  check('the summary counts real requests only: by status, by type, approved calendar days',
    JSON.parse(JSON.stringify([s.total, s.byStatus, s.byType, s.approvedDays])),
    [4, { Pending: 2, Approved: 1, Rejected: 1 }, { Casual: 1, Sick: 1, Annual: 1, Unpaid: 1 }, 3]);
  check('an empty list counts zero everywhere', S.summary([]).approvedDays + S.summary([]).total, 0);
  check('filters: type, status, search over name, staff ID, request ID, reason and department, combined',
    [S.filterRequests(list, { type: 'Sick' }).length, S.filterRequests(list, { status: 'Pending' }).length, S.filterRequests(list, { search: 'kamal' }).length,
      S.filterRequests(list, { search: 'mec-0001' }).length, S.filterRequests(list, { search: 'lvr-0002' }).length, S.filterRequests(list, { search: 'accounts' }).length,
      S.filterRequests(list, { type: 'Casual', status: 'Pending' }).length], [1, 2, 1, 2, 1, 1, 0]);
  check('order: pending first (oldest submission first), then decided ones', S.sortRequests(list).map(r => r.id), ['LVR-0004', 'LVR-0003', 'LVR-0002', 'LVR-0001']);
  const many = Array.from({ length: 23 }, (_, i) => i);
  check('paging by ten, clamped', [S.paginate(many, 1).rows.length, S.paginate(many, 3).rows.length, S.paginate(many, 9).page, S.paginate([], 1).pages], [10, 3, 3, 1]);
  const v = x => Object.keys(S.validateRequest({ staffId: 'MEC-0001', leaveType: 'Casual', startDate: '2026-11-02', endDate: '2026-11-03', reason: 'Wedding', ...x })).sort();
  check('form rules: a full request passes; staff, type, both dates, end not before start, at most 366 days, a reason of at most 500',
    [v({}), v({ staffId: '' }), v({ leaveType: 'Maternity' }), v({ startDate: '' }), v({ endDate: '' }), v({ endDate: '2026-11-01' }), v({ endDate: '2027-11-03' }),
      v({ reason: '   ' }), v({ reason: 'x'.repeat(501) }), v({ endDate: '2026-11-02' })],
    [[], ['staffId'], ['leaveType'], ['startDate'], ['endDate'], ['endDate'], ['endDate'], ['reason'], ['reason'], []]);
  const row = S.rowHtml(list[1]);
  ok('a row escapes every value', !row.includes('<img src=x') && row.includes('&lt;img src=x onerror=alert(1)&gt;'), row);
  ok('   ...a decided request names the decision and offers View, not Review', /Rejected by Workshop passphrase/.test(row) && /data-action="view" data-id="LVR-0002"/.test(row) && !/data-action="review"/.test(row), row);
  ok('   ...a pending request offers Review', /data-action="review" data-id="LVR-0003"/.test(S.rowHtml(list[2])), '');
  ok('   ...the staff ID, department, the start and end date, days and the submission date are shown',
    ['MEC-0002', 'Workshop', '>2 Nov 2026</span><span class="cell-sub">to 6 Nov 2026<', '>5<', 'Annual Leave', '>1 Oct 2026<', 'LVR-0003'].every(t => S.rowHtml(list[2]).includes(t)), S.rowHtml(list[2]));
}

/* ---------- 2. the page, connected ---------- */
console.log('\n-- 2. the page in api mode --');
{
  const f = api({ requests: [req('LVR-0001', 'MEC-0001', 'Casual', '2026-10-13', '2026-10-15', 'Approved'), req('LVR-0002', 'STF-0001', 'Sick', '2026-10-05', '2026-10-05', 'Rejected'),
    req('LVR-0003', 'MEC-0002', 'Annual', '2026-11-02', '2026-11-06')] });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  ok('the roster and the requests are loaded on demand', f.calls.some(c => c.path.startsWith('/staff')) && f.calls.some(c => c.path === '/leave-requests?limit=1000&offset=0'), JSON.stringify(f.calls.map(c => c.path)));
  ok('   ...and nothing is written by loading', !f.calls.some(c => c.method && c.method !== 'GET'), '');
  ok('the controls are enabled once loaded', ['lvNew', 'lvSearch', 'lvType', 'lvStatus', 'lvClear'].every(id => el(id).disabled === false), '');
  check('the cards count the requests', ['pending', 'approved', 'rejected', 'days'].map(s => el(`lv-${s}`).textContent), ['1', '1', '1', '3']);
  ok('both charts are drawn from the requests', /Leave requests by type: Casual 1, Sick 1, Annual 1, Unpaid 0\./.test(el('lvTypeChart').innerHTML)
    && /Leave requests by status: Pending 1, Approved 1, Rejected 1\./.test(el('lvStatusChart').innerHTML), el('lvTypeChart').innerHTML.slice(0, 200));
  check('every request is a row, pending first', ids(el('lvBody').innerHTML), ['LVR-0003', 'LVR-0002', 'LVR-0001']);
  check('   ...the count line', el('lvCount').textContent, '3 of 3 requests · 1 pending');
  el('lvStatus').dispatch('change', { target: { value: 'Approved' } });
  check('filtering by status', ids(el('lvBody').innerHTML), ['LVR-0001']);
  el('lvType').dispatch('change', { target: { value: 'Sick' } });
  ok('   ...combined with a type that matches nothing: says so and offers Clear filters', /No leave requests match/.test(el('lvBody').innerHTML) && /data-action="clear"/.test(el('lvBody').innerHTML), '');
  click(el, 'clear');
  check('Clear filters shows every request again', ids(el('lvBody').innerHTML).length, 3);
}
{
  const { h, el } = page({ fetch: api({ requests: [] }) });
  h.fireReady();
  await tick(80);
  ok('no requests yet: an empty state that offers New Leave Request; every card is 0',
    /No leave requests yet/.test(el('lvBody').innerHTML) && /data-action="new"/.test(el('lvBody').innerHTML) && el('lv-pending').textContent === '0' && el('lv-days').textContent === '0', el('lvBody').innerHTML.slice(0, 200));
}

/* ---------- 3. failures, no backend ---------- */
console.log('\n-- 3. failures, no backend --');
for (const [label, status, code, re] of [
  ['refused (403)', 403, 'forbidden', /cannot see leave requests/],
  ['failed (500)', 500, 'database_error', /could not be loaded[\s\S]*data-action="retry"/],
  ['ended session (401)', 401, 'unauthorized', /Your session has ended[\s\S]*data-action="signin"/]]) {
  const { h, el } = page({ fetch: api({ failList: { status, error: { code, message: 'x' } } }) });
  h.fireReady();
  await tick(80);
  const html = el('lvBody').innerHTML;
  ok(`a ${label} load says so and shows no rows`, re.test(html) && ids(html).length === 0, html.slice(0, 200));
  ok('   ...the cards show no numbers and the controls stay disabled', el('lv-pending').textContent === '—' && el('lvNew').disabled === true && el('lvSearch').disabled === true, '');
}
{
  const { h, el } = page({ origin: '' });
  h.fireReady();
  await tick(40);
  ok('no backend: the page says it needs the workshop database, and shows nothing', /needs the workshop database/.test(el('lvBody').innerHTML) && ids(el('lvBody').innerHTML).length === 0, '');
  const w = await h.ctx.Storage.create('leaveRequests', { staffId: 'MEC-0001' });
  check('   ...and Storage refuses to write leave requests to browser storage', [w.ok, w.code], [false, 'no_api']);
}

/* ---------- 4. writes ---------- */
console.log('\n-- 4. writes --');
{
  const f = api({ requests: [req('LVR-0001', 'MEC-0001', 'Casual', '2026-11-10', '2026-11-12')] });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  const toasts = [];
  h.ctx.Utils.toast = (msg, type) => toasts.push([msg, type]);
  h.ctx.Utils.Modal.close = () => {};
  let opened = null;
  const writes = () => f.calls.filter(c => c.method !== 'GET');

  // New Leave Request.
  const n = fakeModal({ '#lv-staff': 'MEC-0002', '#lv-type': 'Annual', '#lv-start': '2026-12-20', '#lv-end': '2026-12-24', '#lv-reason': '  Annual holiday  ' }, ['[data-save]']);
  h.ctx.Utils.Modal.open = (opts) => { opened = opts; return n.ov; };
  el('lvNew').dispatch('click');
  ok('New Leave Request lists only active staff', opened && ['MEC-0001', 'MEC-0002', 'STF-0001'].every(id => opened.body.includes(`value="${id}"`)) && !opened.body.includes('value="STF-0002"'), opened && opened.body.slice(0, 300));
  ok('   ...escapes their names, and offers exactly the four leave types', opened && !opened.body.includes('<img src=x') && ['Casual', 'Sick', 'Annual', 'Unpaid'].every(t => opened.body.includes(`<option value="${t}">${t} Leave</option>`))
    && (opened.body.match(/<option value="(Casual|Sick|Annual|Unpaid)">/g) || []).length === 4, '');
  await n.press('[data-save]');
  await tick(20);
  const post = f.calls.find(c => c.method === 'POST' && c.path === '/leave-requests');
  check('Submit sends exactly staffId, leaveType, startDate, endDate and the reason (trimmed)', post && post.body,
    { staffId: 'MEC-0002', leaveType: 'Annual', startDate: '2026-12-20', endDate: '2026-12-24', reason: 'Annual holiday' });
  ok('   ...the new request is shown, and the success says so', ids(el('lvBody').innerHTML).includes('LVR-0002') && toasts.some(([t, k]) => k === 'success' && /submitted/.test(t)), JSON.stringify(toasts));

  const before = writes().length;
  const bad = fakeModal({ '#lv-staff': 'MEC-0002', '#lv-type': 'Sick', '#lv-start': '2026-12-10', '#lv-end': '2026-12-09', '#lv-reason': 'Fever' }, ['[data-save]']);
  h.ctx.Utils.Modal.open = () => bad.ov;
  el('lvNew').dispatch('click');
  await bad.press('[data-save]');
  const noReason = fakeModal({ '#lv-staff': 'MEC-0002', '#lv-type': 'Sick', '#lv-start': '2026-12-10', '#lv-end': '2026-12-10', '#lv-reason': '   ' }, ['[data-save]']);
  h.ctx.Utils.Modal.open = () => noReason.ov;
  el('lvNew').dispatch('click');
  await noReason.press('[data-save]');
  await tick(20);
  check('an end before the start, or no reason, sends nothing', writes().length, before);

  let closed = 0;
  h.ctx.Utils.Modal.close = () => { closed++; };
  const clash = fakeModal({ '#lv-staff': 'MEC-0001', '#lv-type': 'Casual', '#lv-start': '2026-11-12', '#lv-end': '2026-11-13', '#lv-reason': 'Again' }, ['[data-save]']);
  h.ctx.Utils.Modal.open = () => clash.ov;
  el('lvNew').dispatch('click');
  await clash.press('[data-save]');
  await tick(20);
  ok('an overlapping request is refused by the Worker (409): the dates say so on the form, the dialog stays open, nothing new is listed',
    clash.errs.startDate && /overlap/.test(clash.errs.startDate.textContent) && closed === 0 && ids(el('lvBody').innerHTML).length === 2,
    JSON.stringify([clash.errs.startDate && clash.errs.startDate.textContent, closed]));

  // Review: reject needs a reason; approve sends expectedUpdatedAt.
  const r1 = fakeModal({ '#lv-note': '' }, ['[data-decide="approve"]', '[data-decide="reject"]']);
  h.ctx.Utils.Modal.open = (opts) => { opened = opts; return r1.ov; };
  click(el, 'review', 'LVR-0001');
  ok('Review shows the request and says approving changes nothing else', opened && /Review leave request LVR-0001/.test(opened.title) && /attendance is not marked/.test(opened.body) && /Family event/.test(opened.body), '');
  const w0 = writes().length;
  await r1.press('[data-decide="reject"]');
  await tick(20);
  check('Reject without a reason sends nothing', writes().length, w0);
  h.ctx.Utils.Modal.close = () => {};
  r1.inputs['#lv-note'].value = ' Enjoy ';
  await r1.press('[data-decide="approve"]');
  await tick(20);
  const approve = f.calls.find(c => c.method === 'POST' && c.path === '/leave-requests/LVR-0001/approve');
  check('Approve sends expectedUpdatedAt and the note to the approve action', approve && approve.body, { expectedUpdatedAt: T0, note: 'Enjoy' });
  ok('   ...the row now shows Approved with View, and the success says so', /Approved by Workshop passphrase/.test(el('lvBody').innerHTML) && /data-action="view" data-id="LVR-0001"/.test(el('lvBody').innerHTML)
    && toasts.some(([t, k]) => k === 'success' && /approved/.test(t)), '');

  const r2 = fakeModal({ '#lv-note': 'Short staffed' }, ['[data-decide="approve"]', '[data-decide="reject"]']);
  h.ctx.Utils.Modal.open = () => r2.ov;
  click(el, 'review', 'LVR-0002');
  await r2.press('[data-decide="reject"]');
  await tick(20);
  const reject = f.calls.find(c => c.method === 'POST' && c.path === '/leave-requests/LVR-0002/reject');
  check('Reject sends expectedUpdatedAt and the reason to the reject action', reject && reject.body, { expectedUpdatedAt: '2026-10-03T09:00:00.000Z', note: 'Short staffed' });

  // A request decided meanwhile: the page reloads instead of overwriting.
  f.db.push(req('LVR-0003', 'STF-0001', 'Unpaid', '2026-12-28', '2026-12-29'));
  await h.ctx.StaffLeave.load({ staffToo: false });
  f.db[2].status = 'Approved';
  const reads = f.calls.filter(c => c.method === 'GET' && c.path.startsWith('/leave-requests')).length;
  const r3 = fakeModal({ '#lv-note': 'No' }, ['[data-decide="approve"]', '[data-decide="reject"]']);
  h.ctx.Utils.Modal.open = () => r3.ov;
  click(el, 'review', 'LVR-0003');
  await r3.press('[data-decide="reject"]');
  await tick(60);
  ok('a request decided meanwhile is refused (409) and the page re-reads instead of overwriting',
    f.db[2].status === 'Approved' && f.calls.filter(c => c.method === 'GET' && c.path.startsWith('/leave-requests')).length === reads + 1 && toasts.some(([t, k]) => k === 'warning'), JSON.stringify(toasts.slice(-2)));
  ok('nothing about leave reached browser storage', h.ctx.localStorage.getItem('taqwa_leaveRequests') === null, '');
}
{
  const f = api({ requests: [req('LVR-0001', 'MEC-0001', 'Casual', '2026-11-10', '2026-11-12')], failDecision: { status: 403, error: { code: 'forbidden', message: 'Only an administrator can approve or reject leave requests.' } } });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  let closed = 0;
  h.ctx.Utils.Modal.close = () => { closed++; };
  const m = fakeModal({ '#lv-note': '' }, ['[data-decide="approve"]', '[data-decide="reject"]']);
  h.ctx.Utils.Modal.open = () => m.ov;
  click(el, 'review', 'LVR-0001');
  await m.press('[data-decide="approve"]');
  await tick(20);
  ok('a decision the Worker refuses (403) changes nothing: the dialog stays open, the request is still Pending with Review, no reload',
    f.calls.some(c => c.path === '/leave-requests/LVR-0001/approve') && closed === 0 && f.db[0].status === 'Pending'
      && /data-action="review" data-id="LVR-0001"/.test(el('lvBody').innerHTML) && f.calls.filter(c => c.method === 'GET' && c.path.startsWith('/leave-requests')).length === 1, String(closed));
}

summary('staff-leave');
})().catch(e => { console.error(e); process.exit(1); });
