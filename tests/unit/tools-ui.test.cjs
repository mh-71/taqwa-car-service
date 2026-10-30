/* tools-ui — Workshop Assets › Tools & Equipment, connected to the database.

   Drives the REAL js/workshop-tools-ui.js (with the real api.js, storage.js
   and utils.js) through the shared harness, against a fake API that answers
   /api/tools in the Worker's envelope. The Worker's own rules are tested
   against the real Worker in api-tools.test.mjs; here it is the page.

     1. Helpers: the browser's copy of the Worker's validation, the request
        body (create sends what was filled in; an edit only what changed,
        with expectedUpdatedAt), the list query, the warranty state, who
        may retire, and CSV (every column, quoted, formula-safe).
     2. Export reads EVERY matching tool, page by page, not just the page shown.
     3. The page in 'api' mode: reads /api/tools on demand with the list's
        query, fills the summary cards from the server's summary, renders
        escaped rows and cards, and the filters / sort / paging re-query.
     4. The retire button follows the signed-in account's role.
     5. Empty register and no matches: honest, distinct states.
     6. A failing tools endpoint: an error state with Retry, never sample or
        browser-stored tools; Retry reads again. No backend: says so, and
        never asks for /api/tools. */
const vm = require('vm');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
const AT = '2026-10-01T00:00:00.000Z';
const tool = (id, extra = {}) => ({ id, name: 'Tool', category: 'Other', brand: '', model: '', serialNo: '', purchaseDate: '',
  purchasePrice: null, supplier: '', warrantyExpiry: '', location: '', condition: 'Good', status: 'Available', description: '',
  notes: '', retiredAt: null, retiredReason: '', createdBy: 'API token', updatedBy: 'API token', createdAt: AT, updatedAt: AT, ...extra });
const TOOLS = [
  tool('TOL-0001', { name: 'OBD-II Scanner', category: 'Diagnostic Equipment', brand: 'Launch', model: 'X431', location: 'Bay 2', purchaseDate: '2026-03-14' }),
  tool('TOL-0002', { name: '<img src=x onerror=alert(1)>', category: 'Lifting Equipment', status: 'In Use' }),
  tool('TOL-0003', { name: 'Old Gauge', status: 'Retired', retiredAt: AT, retiredReason: 'Cracked' }),
];
const SUMMARY = { total: 7, available: 3, inUse: 2, underMaintenance: 1, damaged: 1, retired: 1 };

/** fakeApi for hydration; /tools answered as the Worker would (paging honoured, filters recorded). */
function api({ tools = TOOLS, failTools = null, failTimes = Infinity, account = null } = {}) {
  const base = fakeApi({ rows: {} });
  const calls = base.calls;
  let failures = 0;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (path === '/session' && (init.method || 'GET') === 'GET' && account) {
      return res(200, { data: { authenticated: true, passphrase: true, accounts: true, account } });
    }
    if (!path.startsWith('/tools')) return base(url, init);
    const method = init.method || 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    if (failTools && failures < failTimes) { failures++; return res(failTools.status, { error: failTools.error }); }
    const [p, qs] = path.split('?');
    const q = new URLSearchParams(qs || '');
    if (method === 'GET' && p === '/tools') {
      let rows = tools.filter(t => (q.get('status') ? t.status === q.get('status') : t.status !== 'Retired'));
      const limit = Number(q.get('limit') || 50), offset = Number(q.get('offset') || 0);
      return res(200, { data: rows.slice(offset, offset + limit), count: Math.min(limit, rows.length - offset), total: rows.length, limit, offset, summary: SUMMARY });
    }
    return res(405, { error: { code: 'method_not_allowed', message: 'no' } });
  };
  fn.calls = calls;
  return fn;
}

const IDS = ['wtAdd', 'wtSearch', 'wtCategory', 'wtStatus', 'wtCondition', 'wtSort', 'wtClear', 'wtExport', 'wtState', 'wtTableWrap',
  'wtBody', 'wtCards', 'wtFoot', 'wtCount', 'wtPageSize', 'wtPrev', 'wtPageLabel', 'wtNext', 'wtTotal', 'wtAvailable', 'wtInUse', 'wtMaint', 'wtDamaged'];

function page({ origin = 'http://localhost:8787', fetch, plantDemo = false } = {}) {
  const h = boot({
    origin, fetch, modules: ['js/workshop-tools-ui.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = 'workshop-tools';
      doc.getElementById = (() => { const els = new Map(); return id => {
        if (!els.has(id)) { const e = makeElement(id); e.hidden = false; e.disabled = false;
          e.insertAdjacentHTML = function (_, html) { this._html += html; }; els.set(id, e); }
        return els.get(id); }; })();
      if (plantDemo) ctx.localStorage.setItem('taqwa_tools', JSON.stringify([tool('TOL-9999', { name: 'DEMO ROW' })]));
    },
  });
  vm.runInContext('globalThis.WorkshopToolsUI = WorkshopToolsUI;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, T: h.ctx.WorkshopToolsUI };
}
const toolCalls = calls => calls.filter(c => c.path.startsWith('/tools'));
const lastQuery = calls => new URLSearchParams(toolCalls(calls).slice(-1)[0].path.split('?')[1] || '');

(async () => {
console.log('=== tools-ui: Tools & Equipment ===\n');

/* ---------- 1. helpers ---------- */
console.log('-- 1. helpers --');
{
  const { T } = page({ origin: '' });
  const good = { name: 'Jack', category: 'Lifting Equipment', condition: 'Good', status: 'Available' };
  const errs = (extra, today = '2026-10-30') => Object.keys(T.validate({ ...good, ...extra }, today)).sort();
  check('a complete minimal tool is valid', errs({}), []);
  check('the four required fields are named', Object.keys(T.validate({}, '2026-10-30')).sort(), ['category', 'condition', 'name', 'status']);
  check('a blank name is refused', errs({ name: '   ' }), ['name']);
  check('a name over 120 characters is refused', errs({ name: 'x'.repeat(121) }), ['name']);
  check('a negative price is refused', errs({ purchasePrice: '-1' }), ['purchasePrice']);
  check('a price that is not a number is refused', errs({ purchasePrice: 'abc' }), ['purchasePrice']);
  check('a zero price is fine', errs({ purchasePrice: '0' }), []);
  check('an impossible date is refused', errs({ purchaseDate: '2026-02-31' }), ['purchaseDate']);
  check('a future purchase date is refused', errs({ purchaseDate: '2026-10-31' }), ['purchaseDate']);
  check('a purchase before 1980 is refused', errs({ purchaseDate: '1979-12-31' }), ['purchaseDate']);
  check('a warranty before purchase is refused', errs({ purchaseDate: '2026-05-01', warrantyExpiry: '2026-04-30' }), ['warrantyExpiry']);
  check('a damaged tool cannot be Available', errs({ condition: 'Damaged' }), ['status']);
  check('a Poor tool cannot be In Use', errs({ condition: 'Poor', status: 'In Use' }), ['status']);
  check('a Poor tool Under Maintenance is fine', errs({ condition: 'Poor', status: 'Under Maintenance' }), []);
  check('Retired cannot be chosen in the form', errs({ status: 'Retired' }), ['status']);
  check('an over-long serial is refused', errs({ serialNo: 'x'.repeat(81) }), ['serialNo']);

  check('create sends only what was filled in, trimmed, with a numeric price',
    T.payload({ ...good, brand: ' Bosch ', purchasePrice: '1500.5', notes: '' }),
    { name: 'Jack', category: 'Lifting Equipment', brand: 'Bosch', purchasePrice: 1500.5, condition: 'Good', status: 'Available' });
  const orig = TOOLS[0];
  check('an edit sends only the changed fields plus expectedUpdatedAt',
    T.payload({ ...orig, location: 'Store', purchasePrice: '' }, orig), { location: 'Store', expectedUpdatedAt: AT });
  check('clearing a field sends it blank', T.payload({ ...orig, brand: '' }, orig), { brand: '', expectedUpdatedAt: AT });
  check('an edit that changes nothing sends nothing', T.payload({ ...orig }, orig), null);

  check('the list query carries search, filters, sort and paging; empty ones are left out',
    T.buildQuery({ q: 'jack', category: 'Lifting Equipment', status: '', condition: 'Good', sort: 'name:asc', limit: 25, offset: 50 }),
    { q: 'jack', category: 'Lifting Equipment', condition: 'Good', sort: 'name', order: 'asc', limit: '25', offset: '50' });

  const w = (exp) => T.warrantyState({ warrantyExpiry: exp }, '2026-10-30').tone;
  check('warranty: none, expired, today, within 30 days, active', [T.warrantyState({}, '2026-10-30').tone, w('2026-10-29'), w('2026-10-30'), w('2026-11-29'), w('2026-12-30')],
    ['none', 'expired', 'soon', 'soon', 'active']);
  check('who may retire: the passphrase (no account) and an Administrator, nobody else',
    [T.canRetire(null), T.canRetire({ role: 'Administrator' }), T.canRetire({ role: 'Viewer' })], [true, true, false]);

  const csv = T.toCsv([tool('TOL-0009', { name: 'Say "hi", ok', notes: '=HYPERLINK("x")', purchasePrice: 1200 })]);
  const lines = csv.trim().split('\r\n');
  check('CSV: a header and one line per tool', lines.length, 2);
  ok('CSV: the header names every column', lines[0].startsWith('"Tool ID","Tool Name","Category","Brand","Model","Serial Number"') && lines[0].includes('"Retired Reason"'), lines[0]);
  ok('CSV: quotes are doubled', lines[1].includes('"Say ""hi"", ok"'), lines[1]);
  ok('CSV: a formula is kept as text', lines[1].includes(`"'=HYPERLINK(""x"")"`), lines[1]);
  ok('CSV: numbers are written as they are', lines[1].includes('"1200"'), lines[1]);
}

/* ---------- 2. export reads every matching tool ---------- */
console.log('\n-- 2. export: every matching tool --');
{
  const { T } = page({ origin: '' });
  const all = Array.from({ length: 2345 }, (_, i) => tool(`TOL-${String(i + 1).padStart(4, '0')}`));
  const asked = [];
  const getPage = async (q) => { asked.push(q); const o = Number(q.offset), l = Number(q.limit);
    return { ok: true, rows: all.slice(o, o + l), meta: { total: all.length } }; };
  const res = await T.fetchAllMatching({ q: 'x', status: 'Damaged', sort: 'name:asc', limit: 25, offset: 75 }, getPage);
  check('all 2345 matching tools are read, in three pages of up to 1000', [res.ok, res.rows.length, asked.map(q => q.offset)], [true, 2345, ['0', '1000', '2000']]);
  ok('   ...with the same search, filters and sort as the list', asked.every(q => q.q === 'x' && q.status === 'Damaged' && q.sort === 'name' && q.limit === '1000'), JSON.stringify(asked[0]));
  const failed = await T.fetchAllMatching({}, async () => ({ ok: false, code: 'database_error', message: 'nope' }));
  check('a failed page fails the export (nothing partial is offered)', [failed.ok, failed.code], [false, 'database_error']);
}

/* ---------- 3. the page in api mode ---------- */
console.log('\n-- 3. the page --');
{
  const fetch = api();
  const { h, el, T } = page({ fetch });
  h.fireReady();
  await tick(80);
  const q = lastQuery(fetch.calls);
  check('reads /api/tools on demand, newest first, 25 a page', [q.get('sort'), q.get('order'), q.get('limit'), q.get('offset')], ['createdAt', 'desc', '25', '0']);
  check('the summary cards show the server\'s summary', ['wtTotal', 'wtAvailable', 'wtInUse', 'wtMaint', 'wtDamaged'].map(id => el(id).textContent), ['7', '3', '2', '1', '1']);
  const html = el('wtBody').innerHTML;
  check('one row per tool in service', (html.match(/<tr/g) || []).length, 2);
  ok('names are escaped, never parsed', !html.includes('<img src=x') && html.includes('&lt;img src=x'), '');
  ok('a row shows ID, category, brand · model, location, badges and the purchase date', html.includes('TOL-0001') && html.includes('Diagnostic Equipment')
    && html.includes('Launch · X431') && html.includes('Bay 2') && html.includes('wt-status--available') && html.includes('wt-cond--good') && html.includes('14 Mar 2026'), '');
  ok('each row has View, Edit and Retire', ['data-act="view"', 'data-act="edit"', 'data-act="retire"'].every(s => html.includes(s)), '');
  ok('the mobile cards carry the same tools', (el('wtCards').innerHTML.match(/<li/g) || []).length === 2 && el('wtCards').innerHTML.includes('&lt;img'), '');
  check('the list is shown, the state cleared, Add and Export enabled', [el('wtTableWrap').hidden, el('wtState').innerHTML, el('wtAdd').disabled, el('wtExport').disabled], [false, '', false, false]);
  check('the footer counts the whole match', el('wtCount').textContent, 'Showing 1–2 of 2 tools');
  ok('no demo or sample tool appears', !/DEMO|TL-00/.test(html), '');

  const n = toolCalls(fetch.calls).length;
  el('wtStatus').value = 'Retired'; el('wtStatus').dispatch('change');
  await tick(60);
  check('a status filter re-queries the server', [toolCalls(fetch.calls).length, lastQuery(fetch.calls).get('status')], [n + 1, 'Retired']);
  ok('   ...and the retired tool shows, without Edit or Retire', el('wtBody').innerHTML.includes('Old Gauge') && !el('wtBody').innerHTML.includes('data-act="edit"') && !el('wtBody').innerHTML.includes('data-act="retire"'), '');
  check('   ...and Clear filters is offered', el('wtClear').hidden, false);
  el('wtSort').value = 'purchasePrice:asc'; el('wtSort').dispatch('change');
  await tick(60);
  check('sorting re-queries with sort and order', [lastQuery(fetch.calls).get('sort'), lastQuery(fetch.calls).get('order')], ['purchasePrice', 'asc']);
  el('wtCategory').value = 'Other'; el('wtCategory').dispatch('change');
  el('wtCondition').value = 'Fair'; el('wtCondition').dispatch('change');
  await tick(60);
  check('category and condition are sent', [lastQuery(fetch.calls).get('category'), lastQuery(fetch.calls).get('condition')], ['Other', 'Fair']);
  el('wtSearch').value = '  scanner '; el('wtSearch').dispatch('input');
  await tick(20);
  const before = toolCalls(fetch.calls).length;
  await tick(400);
  check('search waits for typing to pause, then sends the trimmed text', [toolCalls(fetch.calls).length - before, lastQuery(fetch.calls).get('q')], [1, 'scanner']);
  el('wtClear').dispatch('click');
  await tick(60);
  const cleared = lastQuery(fetch.calls);
  check('Clear filters drops search and filters', ['q', 'category', 'status', 'condition'].map(k => cleared.get(k)), [null, null, null, null]);
}
{
  const many = Array.from({ length: 30 }, (_, i) => tool(`TOL-${String(i + 1).padStart(4, '0')}`, { name: `Tool ${i + 1}` }));
  const fetch = api({ tools: many });
  const { h, el } = page({ fetch });
  h.fireReady();
  await tick(80);
  check('paging: page 1 of 2, Previous disabled', [el('wtPageLabel').textContent, el('wtPrev').disabled, el('wtNext').disabled], ['Page 1 of 2', true, false]);
  el('wtNext').dispatch('click');
  await tick(60);
  check('Next asks for the next offset', [lastQuery(fetch.calls).get('offset'), el('wtPageLabel').textContent, el('wtCount').textContent, el('wtNext').disabled], ['25', 'Page 2 of 2', 'Showing 26–30 of 30 tools', true]);
  el('wtPageSize').value = '10'; el('wtPageSize').dispatch('change');
  await tick(60);
  check('a page size change starts again at the first page', [lastQuery(fetch.calls).get('limit'), lastQuery(fetch.calls).get('offset'), el('wtPageLabel').textContent], ['10', '0', 'Page 1 of 3']);
}

/* ---------- 4. retire follows the account ---------- */
console.log('\n-- 4. who sees Retire --');
{
  const fetch = api({ account: { id: 'USR-0002', username: 'nadia', role: 'Viewer' } });
  const { h, el } = page({ fetch });
  h.fireReady();
  await tick(80);
  ok('an account that is not an Administrator sees View and Edit, not Retire', el('wtBody').innerHTML.includes('data-act="edit"') && !el('wtBody').innerHTML.includes('data-act="retire"'), '');
}

/* ---------- 5. empty and no match ---------- */
console.log('\n-- 5. empty states --');
{
  const fetch = api({ tools: [] });
  const { h, el } = page({ fetch });
  h.fireReady();
  await tick(80);
  ok('an empty register says so and offers Add New Tool', /No tools registered yet/.test(el('wtState').innerHTML) && /data-state-action="add"/.test(el('wtState').innerHTML), el('wtState').innerHTML);
  check('   ...the list is hidden and Export disabled', [el('wtTableWrap').hidden, el('wtExport').disabled], [true, true]);
  el('wtCondition').value = 'Poor'; el('wtCondition').dispatch('change');
  await tick(60);
  ok('no matches is a different message, offering Clear filters', /No tools match/.test(el('wtState').innerHTML) && /data-state-action="clear"/.test(el('wtState').innerHTML), el('wtState').innerHTML);
}

/* ---------- 6. failures ---------- */
console.log('\n-- 6. failures --');
{
  const fetch = api({ failTools: { status: 500, error: { code: 'database_error', message: 'Could not read tools.' } }, failTimes: 1 });
  const { h, el } = page({ fetch, plantDemo: true });
  h.fireReady();
  await tick(80);
  ok('a failed read shows an error with Retry', /could not be loaded/.test(el('wtState').innerHTML) && /data-state-action="retry"/.test(el('wtState').innerHTML), el('wtState').innerHTML);
  check('   ...no tools are shown, demo or otherwise; Export is off', [el('wtTableWrap').hidden, /DEMO/.test(el('wtBody').innerHTML), el('wtExport').disabled], [true, false, true]);
  el('wtState').dispatch('click', { target: { closest: () => ({ dataset: { stateAction: 'retry' } }) } });
  await tick(80);
  check('Retry reads again and shows the tools', [toolCalls(fetch.calls).length, (el('wtBody').innerHTML.match(/<tr/g) || []).length, el('wtState').innerHTML], [2, 2, '']);
}
{
  const fetch = api({ failTools: { status: 401, error: { code: 'unauthorized', message: 'Authentication required.' } } });
  const { h, el } = page({ fetch });
  h.fireReady();
  await tick(80);
  ok('an ended session says so, and offers to sign in again', /session has ended/.test(el('wtState').innerHTML), el('wtState').innerHTML);
}
{
  const { h, el } = page({ origin: '', plantDemo: true });
  h.fireReady();
  await tick(40);
  ok('no backend: the page says it needs the workshop database', /not connected/.test(el('wtState').innerHTML), el('wtState').innerHTML);
  check('   ...and shows nothing from browser storage', [el('wtTableWrap').hidden, el('wtBody').innerHTML], [true, '']);
}

process.exit(summary('tools-ui') === 0 ? 0 : 1);
})();
