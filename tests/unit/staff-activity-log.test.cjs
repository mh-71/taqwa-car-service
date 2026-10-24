/* staff-activity-log — Staff Management › Activity Log, connected to the database.

   Drives the REAL js/staff-activity-log.js (with the real api.js, storage.js,
   utils.js and app.js) through the shared harness, against a fake API that
   answers /api/activity-log the way the Worker does (filtered, paged).

     1. Helpers: the query holds only the filters that are set plus the page,
        an inverted date range asks nothing, page ranges, workshop time
        (Asia/Dhaka), rows that are escaped.
     2. The page in 'api' mode: ONE page read on demand (limit / offset -- the
        whole history is never downloaded), the four cards from the server's
        counts, the rows, filters / search / paging sent to the server, an
        inverted range asks nothing, Clear filters, the details panel.
     3. States: no entries yet, no matches, refused (403), failed (500), ended
        (401); no backend shows nothing and Storage refuses the read.
     4. It only reads: no request but GET is ever made, nothing in browser storage. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

const E = (id, at, module, action, summary, extra = {}) => ({ id: String(id), occurredAt: at, actorKind: 'passphrase', actorAccountId: '',
  actorName: 'Workshop passphrase', action, module, recordId: `REC-${id}`, summary, ...extra });
const MANY = Array.from({ length: 30 }, (_, i) => E(30 - i, `2026-10-2${i < 10 ? 4 : 3}T0${i % 10}:00:00.000Z`, i % 2 ? 'staff' : 'attendance', i % 3 ? 'create' : 'update', `Entry ${30 - i}`));

function page({ origin = 'http://localhost:8787', fetch } = {}) {
  const h = boot({ origin, fetch, modules: ['js/staff-activity-log.js'] });
  vm.runInContext('globalThis.StaffActivityLog = StaffActivityLog;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, S: h.ctx.StaffActivityLog };
}

/** fakeApi for the hydrated collections; /activity-log answered as the Worker would (filters + paging). */
function api({ entries = MANY, fail = null } = {}) {
  const base = fakeApi({ rows: { mechanics: [] } });
  const calls = base.calls;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(JSON.stringify(body)) });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    const method = init.method || 'GET';
    if (path === '/session' && method === 'GET') return res(200, { data: { authenticated: true, passphrase: true, accounts: true } });
    if (!path.startsWith('/activity-log')) return base(url, init);
    calls.push({ method, path });
    if (fail) return res(fail.status, { error: fail.error });
    const q = new URLSearchParams(path.split('?')[1] || '');
    let rows = entries.filter(e => (!q.get('module') || e.module === q.get('module')) && (!q.get('action') || e.action === q.get('action'))
      && (!q.get('q') || `${e.actorName} ${e.recordId} ${e.summary}`.toLowerCase().includes(q.get('q').toLowerCase())));
    const total = rows.length;
    const counts = { today: 2, staffAccounts: rows.filter(e => e.module === 'staff').length, attendanceLeave: rows.filter(e => e.module === 'attendance').length };
    rows = rows.slice(Number(q.get('offset') || 0), Number(q.get('offset') || 0) + Number(q.get('limit') || 50));
    return res(200, { data: rows, count: rows.length, total, counts, today: '2026-10-24' });
  };
  fn.calls = calls;
  return fn;
}

const ids = html => [...html.matchAll(/<tr data-id="([^"]+)"/g)].map(m => m[1]);
const reads = f => f.calls.filter(c => c.path.startsWith('/activity-log')).map(c => c.path);

(async () => {
console.log('=== staff-activity-log: Activity Log ===\n');

/* ---------- 1. helpers ---------- */
console.log('-- 1. helpers --');
{
  const { S } = page({ origin: '' });
  check('the query: only the filters that are set, plus the page', [S.buildQuery({}), S.buildQuery({ q: '  nadia ', from: '2026-10-01', to: 'x', module: 'leave', action: 'nope', page: 3 })].map(o => JSON.parse(JSON.stringify(o))),
    [{ limit: '25', offset: '0' }, { q: 'nadia', from: '2026-10-01', module: 'leave', limit: '25', offset: '50' }]);
  check('an inverted date range is invalid; an open one is not', [S.rangeInvalid('2026-10-05', '2026-10-01'), S.rangeInvalid('2026-10-01', ''), S.rangeInvalid('2026-10-01', '2026-10-01')], [true, false, false]);
  check('page ranges, clamped', [S.pageInfo(30, 1), S.pageInfo(30, 2), S.pageInfo(30, 9), S.pageInfo(0, 1)].map(o => JSON.parse(JSON.stringify(o))),
    [{ page: 1, pages: 2, from: 1, to: 25 }, { page: 2, pages: 2, from: 26, to: 30 }, { page: 2, pages: 2, from: 26, to: 30 }, { page: 1, pages: 1, from: 0, to: 0 }]);
  check('times are workshop time (Asia/Dhaka, UTC+6)', S.fmtWhen('2026-10-23T20:30:00.000Z'), '24 Oct 2026, 02:30');
  const row = S.rowHtml(E(7, '2026-10-24T05:00:00.000Z', 'accounts', 'password', 'Set a new password for account <img src=x onerror=alert(1)>',
    { actorKind: 'account', actorAccountId: 'USR-0001', actorName: '<b>nadia</b>' }));
  ok('a row escapes every value', !row.includes('<img src=x') && !row.includes('<b>nadia') && row.includes('&lt;img src=x') && row.includes('&lt;b&gt;nadia'), row);
  ok('   ...and shows who (with the account), the action, the module and record, and a View button',
    /Account USR-0001/.test(row) && />Password</.test(row) && />User Accounts</.test(row) && /REC-7/.test(row) && /data-action="view" data-id="7"/.test(row), row);
}

/* ---------- 2. the page, connected ---------- */
console.log('\n-- 2. the page in api mode --');
{
  const f = api();
  const { h, el, S } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  check('ONE page is read on demand (limit / offset), not the whole history', reads(f), ['/activity-log?limit=25&offset=0']);
  ok('the controls are enabled once loaded', ['algSearch', 'algFrom', 'algTo', 'algModule', 'algAction', 'algClear'].every(id => el(id).disabled === false), '');
  check('the four cards come from the server\'s counts', ['total', 'today', 'people', 'days'].map(k => el(`alg-${k}`).textContent), ['30', '2', '15', '15']);
  check('the rows are that page, newest first', ids(el('algBody').innerHTML).slice(0, 3), ['30', '29', '28']);
  check('   ...25 of them, with the range and the count', [ids(el('algBody').innerHTML).length, el('algRange').textContent, el('algCount').textContent], [25, 'Showing 1–25 of 30', '30 entries']);
  el('algNext').dispatch('click');
  await tick(60);
  check('Next asks the server for the next page', reads(f).at(-1), '/activity-log?limit=25&offset=25');
  check('   ...and shows it', [ids(el('algBody').innerHTML).length, el('algRange').textContent, el('algNext').disabled], [5, 'Showing 26–30 of 30', true]);
  el('algModule').dispatch('change', { target: { value: 'staff' } });
  await tick(60);
  check('a module filter is sent to the server, from the first page', reads(f).at(-1), '/activity-log?module=staff&limit=25&offset=0');
  el('algAction').dispatch('change', { target: { value: 'update' } });
  await tick(60);
  check('   ...an action filter too', reads(f).at(-1), '/activity-log?module=staff&action=update&limit=25&offset=0');
  el('algAction').dispatch('change', { target: { value: 'delete' } });
  await tick(60);
  check('   ...an unknown action is ignored (all actions)', reads(f).at(-1), '/activity-log?module=staff&limit=25&offset=0');
  el('algSearch').dispatch('input', { target: { value: 'Entry 3' } });
  await tick(400);
  check('the search is sent to the server after a pause', reads(f).at(-1), '/activity-log?q=Entry+3&module=staff&limit=25&offset=0');
  const before = reads(f).length;
  el('algFrom').dispatch('change', { target: { value: '2026-10-20' } });
  await tick(60);
  el('algTo').dispatch('change', { target: { value: '2026-10-10' } });
  await tick(60);
  check('an inverted date range asks nothing more of the server and says why', [reads(f).length, el('algRangeError').hidden, /date range is not valid/.test(el('algBody').innerHTML)], [before + 1, false, true]);
  await S.clearFilters();
  await tick(20);
  check('Clear filters asks for everything again, page one', [reads(f).at(-1), el('algRangeError').hidden, ids(el('algBody').innerHTML).length], ['/activity-log?limit=25&offset=0', true, 25]);
  el('algBody').dispatch('click', { target: { closest: () => ({ dataset: { action: 'view', id: '29' }, disabled: false }) } });
  ok('View shows the entry\'s details, its outcome included', el('algDetails').hidden === false && /Entry 29/.test(el('algDetailsList').innerHTML)
    && /Succeeded \(only successful changes are recorded\)/.test(el('algDetailsList').innerHTML), el('algDetailsList').innerHTML.slice(0, 200));
  el('algDetailsClose').dispatch('click');
  ok('   ...and closes', el('algDetails').hidden === true, '');
  check('it only reads: every request was a GET', f.calls.filter(c => c.path.startsWith('/activity-log') && c.method !== 'GET').length, 0);
  ok('nothing about the activity log reached browser storage', h.ctx.localStorage.getItem('taqwa_activityLog') === null, '');
}

/* ---------- 3. states ---------- */
console.log('\n-- 3. states --');
{
  const { h, el } = page({ fetch: api({ entries: [] }) });
  h.fireReady();
  await tick(80);
  ok('no entries yet: says what will appear here; the cards are 0', /No activity yet/.test(el('algBody').innerHTML) && el('alg-total').textContent === '0' && el('algCount').textContent === '0 entries', el('algBody').innerHTML.slice(0, 200));
  el('algModule').dispatch('change', { target: { value: 'leave' } });
  await tick(60);
  ok('no matches for a filter: says so and offers Clear filters', /No activity matches these filters/.test(el('algBody').innerHTML) && /data-action="clear"/.test(el('algBody').innerHTML), '');
}
for (const [label, status, code, re] of [
  ['refused (403)', 403, 'forbidden', /Only an administrator can read the activity log/],
  ['failed (500)', 500, 'database_error', /could not be loaded[\s\S]*data-action="retry"/],
  ['ended session (401)', 401, 'unauthorized', /Your session has ended[\s\S]*data-action="signin"/]]) {
  const { h, el } = page({ fetch: api({ fail: { status, error: { code, message: 'x' } } }) });
  h.fireReady();
  await tick(80);
  const html = el('algBody').innerHTML;
  ok(`a ${label} read says so and shows no entries`, re.test(html) && ids(html).length === 0 && el('alg-total').textContent === '—', html.slice(0, 200));
}
{
  const { h, el } = page({ origin: '' });
  h.fireReady();
  await tick(40);
  ok('no backend: the page says it needs the workshop database, and shows nothing', /needs the workshop database/.test(el('algBody').innerHTML) && ids(el('algBody').innerHTML).length === 0, '');
  const r = await h.ctx.Storage.loadPage('activityLog', {});
  check('   ...and Storage refuses the read outside the database', [r.ok, r.code], [false, 'no_api']);
}

summary('staff-activity-log');
})().catch(e => { console.error(e); process.exit(1); });
