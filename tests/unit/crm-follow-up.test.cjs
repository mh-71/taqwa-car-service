/* crm-follow-up — Customer CRM › Customer Follow-up, connected to the database.

   Drives the REAL js/crm-follow-up.js (with the real api.js, storage.js and
   utils.js) through the shared harness, against a fake API that answers the
   follow-up routes the way the Worker does.

     1. Dates: today is the Asia/Dhaka day; Pending / Due Today / Overdue for
        Open follow-ups only.
     2. KPIs: Open only; Completed and Cancelled never count; Contacted is the
        latest valid outcome being reached; filters never change them.
     3. Rows: names from customers / vehicles, safe fallbacks when missing,
        deterministic order.
     4. Search and filters, and "Showing N of M".
     5. Validation mirrors the Worker: limits, conditional fields, any real
        calendar date (past included), impossible dates refused.
     6. Idempotent submissions: a secure key per dialog, the same key and
        payload on every retry, frozen after an ambiguous answer, never a
        Math.random key.
     7. The page in 'api' mode: loads on demand, cards, escaped rows, actions
        only where they apply.
     8. An empty database: an honest empty state.
     9. A failing follow-up endpoint: unavailable + Retry, never demo data,
        every other collection untouched; Retry loads again.
    10. No backend / signed out: nothing read, nothing shown. */
const vm = require('vm');
const { webcrypto } = require('crypto');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

const CUSTOMERS = [
  { id: 'CUS-0001', name: 'Rahim Uddin', phone: '+880 1712-345678', status: 'Active' },
  { id: 'CUS-0002', name: '<img src=x onerror=alert(1)>', phone: '017', status: 'Active' },
  { id: 'CUS-0003', name: 'Old Client', phone: '01800000000', status: 'Inactive' },
];
const VEHICLES = [
  { id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHAKA-GA-1234', brand: 'Toyota', model: 'Corolla', status: 'Active' },
  { id: 'VEH-0002', customerId: 'CUS-0002', regNo: 'CTG-KHA-5678', brand: 'Honda', model: 'Civic', status: 'Active' },
];
const TODAY = '2026-10-14';
const fu = (id, extra) => ({ id, customerId: 'CUS-0001', vehicleId: 'VEH-0001', reason: 'Call back', notes: '', priority: 'normal',
  dueDate: TODAY, status: 'Open', lastContactAt: null, lastOutcome: null, closedAt: null, closeNote: '',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra });
const FOLLOW_UPS = [
  fu('FUP-0001', { dueDate: '2026-10-13', lastOutcome: 'reached', lastContactAt: '2026-10-12T05:00:00.000Z' }),          // Overdue, contacted
  fu('FUP-0002', { dueDate: TODAY, priority: 'high', reason: 'Brake squeal <b>check</b>' }),                               // Due Today
  fu('FUP-0003', { dueDate: '2026-10-20', lastOutcome: 'unreachable', lastContactAt: '2026-10-13T05:00:00.000Z' }),      // Pending
  fu('FUP-0004', { dueDate: '2026-10-01', status: 'Completed', closedAt: '2026-10-05T00:00:00.000Z', lastOutcome: 'reached' }), // never counted
  fu('FUP-0005', { dueDate: TODAY, status: 'Cancelled', closedAt: '2026-10-06T00:00:00.000Z', closeNote: 'Sold the car' }),     // never counted
  fu('FUP-0006', { customerId: 'CUS-0002', vehicleId: 'VEH-0002', dueDate: '2026-10-20', reason: 'Estimate follow-up' }),
  fu('FUP-0007', { customerId: 'CUS-0999', vehicleId: 'VEH-0999', dueDate: '2026-10-21', reason: 'Orphan' }),
];

/** fakeApi for the hydrated collections; follow-up paths answered as the Worker would. */
function api({ followUps = FOLLOW_UPS, contacts = [], failFollowUps = null, failTimes = Infinity } = {}) {
  const base = fakeApi({ rows: { customers: CUSTOMERS, vehicles: VEHICLES } });
  const calls = base.calls;
  let failures = 0;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (!path.startsWith('/follow-up')) return base(url, init);
    calls.push({ method: init.method || 'GET', path });
    if (failFollowUps && failures < failTimes) { failures++; return res(failFollowUps.status, { error: failFollowUps.error }); }
    const list = path.startsWith('/follow-up-contacts') ? contacts : followUps;
    return res(200, { data: list, count: list.length, total: list.length, limit: 1000, offset: 0 });
  };
  fn.calls = calls;
  return fn;
}

function page({ origin = 'http://localhost:8787', fetch, cryptoObj = webcrypto, seedDemo = false } = {}) {
  const h = boot({
    origin, fetch, modules: ['js/crm-follow-up.js'],
    beforeModules(doc, ctx) { ctx.crypto = cryptoObj; ctx.Uint8Array = Uint8Array; },
  });
  vm.runInContext('globalThis.CrmFollowUp = CrmFollowUp;', h.ctx);
  if (seedDemo) {
    // The app seeds demo data into browser storage in local mode, and a
    // planted row sits under the follow-ups' own name.
    h.ctx.localStorage.setItem('taqwa_followUps', JSON.stringify([fu('FUP-9999', { reason: 'DEMO ROW' })]));
  }
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, F: h.ctx.CrmFollowUp };
}

(async () => {
console.log('=== crm-follow-up: Customer Follow-up ===\n');

/* ---------- 1. dates ---------- */
console.log('-- 1. Dhaka dates and displayed status --');
{
  const { F } = page({ origin: '' });
  check('17:59:59Z is still the same Dhaka day', F.dhakaToday(new Date('2026-10-13T17:59:59Z')), '2026-10-13');
  check('18:00:00Z is already the next Dhaka day', F.dhakaToday(new Date('2026-10-13T18:00:00Z')), '2026-10-14');
  check('Open: before / on / after today -> Overdue / Due Today / Pending',
    ['2026-10-13', TODAY, '2026-10-15'].map(d => F.displayStatus(fu('X', { dueDate: d }), TODAY)), ['Overdue', 'Due Today', 'Pending']);
  check('a closed follow-up shows its status, never Overdue',
    [F.displayStatus(fu('X', { dueDate: '2000-01-01', status: 'Completed' }), TODAY),
      F.displayStatus(fu('X', { dueDate: '2000-01-01', status: 'Cancelled' }), TODAY)], ['Completed', 'Cancelled']);
  check('the same follow-up flips from Due Today to Overdue across the Dhaka midnight',
    [F.displayStatus(fu('X', { dueDate: '2026-10-13' }), F.dhakaToday(new Date('2026-10-13T17:59:59Z'))),
      F.displayStatus(fu('X', { dueDate: '2026-10-13' }), F.dhakaToday(new Date('2026-10-13T18:00:00Z')))], ['Due Today', 'Overdue']);
}

/* ---------- 2. KPIs ---------- */
console.log('\n-- 2. KPIs --');
{
  const { F } = page({ origin: '' });
  const k = F.kpis(FOLLOW_UPS, TODAY);
  check('Total counts Open only (5 of 7)', k.total, 5);
  check('Due Today: Open and due today (the Cancelled one due today is not counted)', k.dueToday, 1);
  check('Overdue: Open and past due (the Completed one long past is not counted)', k.overdue, 1);
  check('Contacted: Open whose latest valid outcome is reached (Completed+reached not counted; unreachable not counted)', k.contacted, 1);
  check('nothing counts when everything is closed',
    F.kpis(FOLLOW_UPS.map(x => ({ ...x, status: 'Completed' })), TODAY), { total: 0, dueToday: 0, overdue: 0, contacted: 0 });
  check('a reached contact later voided (server cache back to null) is not counted', F.kpis([fu('X', { lastOutcome: null })], TODAY).contacted, 0);
  check('callback_requested and other are not "contacted"',
    F.kpis([fu('A', { lastOutcome: 'callback_requested' }), fu('B', { lastOutcome: 'other' })], TODAY).contacted, 0);
}

/* ---------- 3. rows ---------- */
console.log('\n-- 3. rows --');
{
  const { F } = page({ origin: '' });
  const rows = F.buildRows({ followUps: FOLLOW_UPS, customers: CUSTOMERS, vehicles: VEHICLES, today: TODAY });
  const orphan = rows.find(r => r.id === 'FUP-0007');
  check('a follow-up whose customer and vehicle are missing invents nothing',
    [orphan.customerName, orphan.phone, orphan.vehicleKnown, orphan.vehicleLabel], ['', '', false, '']);
  check('names and a dialable phone come from the loaded customers', [rows[0].customerName, rows[0].phone], ['Rahim Uddin', '+8801712345678']);
  check('a phone that is not dialable gives no tel number', rows.find(r => r.id === 'FUP-0006').phone, '');
  const sorted = F.sortRows(rows).map(r => r.id);
  check('order: Open by due date (high first on the same day), then closed by most recent close',
    sorted, ['FUP-0001', 'FUP-0002', 'FUP-0003', 'FUP-0006', 'FUP-0007', 'FUP-0005', 'FUP-0004']);
  check('   ...and the same input always gives the same order', F.sortRows(rows.slice().reverse()).map(r => r.id), sorted);
}

/* ---------- 4. search and filters ---------- */
console.log('\n-- 4. search and filters --');
{
  const { F } = page({ origin: '' });
  const rows = F.sortRows(F.buildRows({ followUps: FOLLOW_UPS, customers: CUSTOMERS, vehicles: VEHICLES, today: TODAY }));
  const ids = o => F.filterRows(rows, o).map(r => r.id);
  check('the default shows Open follow-ups only', ids({}), ['FUP-0001', 'FUP-0002', 'FUP-0003', 'FUP-0006', 'FUP-0007']);
  check('All statuses shows every one', ids({ status: 'all' }).length, 7);
  check('Completed / Cancelled', [ids({ status: 'Completed' }), ids({ status: 'Cancelled' })], [['FUP-0004'], ['FUP-0005']]);
  check('Due today / Overdue (Open only, even with All statuses)',
    [ids({ status: 'all', due: 'today' }), ids({ status: 'all', due: 'overdue' })], [['FUP-0002'], ['FUP-0001']]);
  check('priority High', ids({ priority: 'high' }), ['FUP-0002']);
  check('search by customer name', ids({ search: 'rahim' }), ['FUP-0001', 'FUP-0002', 'FUP-0003']);
  check('search by phone digits, however written', [ids({ search: '1712 345' }), ids({ search: '01712-345678' })],
    [['FUP-0001', 'FUP-0002', 'FUP-0003'], ['FUP-0001', 'FUP-0002', 'FUP-0003']]);
  check('search by reason', ids({ search: 'estimate' }), ['FUP-0006']);
  check('filters combine', ids({ search: 'rahim', priority: 'high' }), ['FUP-0002']);
}

/* ---------- 5. validation ---------- */
console.log('\n-- 5. validation --');
{
  const { F } = page({ origin: '' });
  const good = { customerId: 'CUS-0001', reason: 'x', notes: '', priority: 'normal', dueDate: '2026-10-20' };
  check('a valid follow-up has no errors', F.validateFollowUp(good), {});
  check('missing customer, reason and date', Object.keys(F.validateFollowUp({ priority: 'normal' })).sort(), ['customerId', 'dueDate', 'reason']);
  check('a past date and a far-future date are both fine', [F.validateFollowUp({ ...good, dueDate: '1990-01-01' }), F.validateFollowUp({ ...good, dueDate: '2099-12-31' })], [{}, {}]);
  check('an impossible date is refused', Object.keys(F.validateFollowUp({ ...good, dueDate: '2026-02-30' })), ['dueDate']);
  check('limits: reason 200, notes 1000 (the same as the Worker)',
    [Object.keys(F.validateFollowUp({ ...good, reason: 'r'.repeat(201), notes: 'n'.repeat(1001) })).sort(),
      F.validateFollowUp({ ...good, reason: 'r'.repeat(200), notes: 'n'.repeat(1000) })], [['notes', 'reason'], {}]);
  check('priority must be normal or high', Object.keys(F.validateFollowUp({ ...good, priority: 'urgent' })), ['priority']);
  check('editing needs no customer', F.validateFollowUp({ ...good, customerId: '' }, { creating: false }), {});
  check('LIMITS match the Worker', F.LIMITS, { reason: 200, notes: 1000, note: 1000, closeNote: 500, voidReason: 500, name: 100 });
  const c = o => Object.keys(F.validateContact({ outcome: 'reached', note: '', nextContactDate: '', recordedBy: '', ...o })).sort();
  check('contact: an outcome is required', c({ outcome: '' }), ['outcome']);
  check('contact: callback_requested needs a next contact date', c({ outcome: 'callback_requested' }), ['nextContactDate']);
  check('contact: other needs a note', c({ outcome: 'other', note: '  ' }), ['note']);
  check('contact: a PAST next contact date is fine', c({ outcome: 'callback_requested', nextContactDate: '2020-01-01' }), []);
  check('contact: an impossible next contact date is refused', c({ nextContactDate: '2026-13-01' }), ['nextContactDate']);
  check('contact: note 1000, recorded-by 100', c({ note: 'n'.repeat(1001), recordedBy: 'b'.repeat(101) }), ['note', 'recordedBy']);
}

/* ---------- 6. idempotent submissions ---------- */
console.log('\n-- 6. idempotent submissions --');
{
  const { F } = page({ origin: '' });
  const k1 = F.newKey(webcrypto), k2 = F.newKey(webcrypto);
  ok('a key comes from crypto.randomUUID and is new each time', /^[0-9a-f-]{36}$/.test(k1) && k1 !== k2, `${k1} ${k2}`);
  const viaRandom = F.newKey({ getRandomValues: a => webcrypto.getRandomValues(a) });
  ok('   ...or from crypto.getRandomValues (32 hex characters)', /^[0-9a-f]{32}$/.test(viaRandom), viaRandom);
  check('   ...and with no secure source there is no key at all (no Math.random fallback)', F.newKey(null), null);

  const sub = F.createSubmission(webcrypto);
  const b1 = sub.body({ outcome: 'reached' });
  check('the key rides in the JSON body', b1.idempotencyKey, sub.key);
  sub.settle({ ok: false, status: 422, code: 'unprocessable' });
  check('a definitive refusal (422) does not freeze: the form can be corrected', sub.frozen, false);
  const b2 = sub.body({ outcome: 'unreachable' });
  check('   ...the corrected payload is sent with the SAME key (nothing was stored under it)', [b2.outcome, b2.idempotencyKey], ['unreachable', sub.key]);
  sub.settle({ ok: false, status: 0, code: 'timeout' });
  check('a timeout freezes the submission', sub.frozen, true);
  const b3 = sub.body({ outcome: 'other', note: 'edited after the timeout' });
  check('   ...and a retry resends exactly the frozen payload and key', b3, { outcome: 'unreachable', idempotencyKey: sub.key });

  check('ambiguous answers: timeout, network, malformed, 0, 5xx',
    [{ code: 'timeout' }, { code: 'network_error' }, { code: 'malformed_response' }, { status: 0 }, { status: 500 }, { status: 503 }]
      .map(r => F.isAmbiguous({ ok: false, ...r })), [true, true, true, true, true, true]);
  check('definitive answers: success, 400, 404, 409, 422',
    [{ ok: true }, { ok: false, status: 400 }, { ok: false, status: 404 }, { ok: false, status: 409 }, { ok: false, status: 422 }]
      .map(r => F.isAmbiguous(r)), [false, false, false, false, false]);
  const none = F.createSubmission(null);
  check('without a secure key the submission refuses to produce a body', none.body({ outcome: 'reached' }), null);
  const s2 = F.createSubmission(webcrypto);
  ok('a new dialog (a new submission) gets a new key', s2.key !== sub.key, '');
}

/* ---------- 7. the page, connected ---------- */
console.log('\n-- 7. the page in api mode --');
{
  const f = api();
  const { h, el, F } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  ok('follow-ups and contacts are loaded on demand, as paged GETs',
    f.calls.some(c => c.path === '/follow-ups?limit=1000&offset=0') && f.calls.some(c => c.path === '/follow-up-contacts?limit=1000&offset=0'),
    JSON.stringify(f.calls.map(c => c.path)));
  ok('controls and the New button are enabled', ['crfSearch', 'crfStatus', 'crfDue', 'crfPriority', 'crfNew'].every(id => el(id).disabled === false), '');
  const today = F.dhakaToday();
  const k = F.kpis(FOLLOW_UPS, today);
  check('the cards show the Open-only counts', ['crfTotal', 'crfDueToday', 'crfContacted', 'crfOverdue'].map(id => el(id).innerHTML),
    [k.total, k.dueToday, k.contacted, k.overdue].map(String));
  const html = el('crfBody').innerHTML;
  ok('the rows are rendered', (html.match(/<tr data-id=/g) || []).length === 5, String((html.match(/<tr data-id=/g) || []).length));
  ok('   ...with every value escaped (no live HTML from a customer name or reason)',
    !html.includes('<img src=x') && html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('Brake squeal &lt;b&gt;check&lt;/b&gt;'), '');
  ok('   ...unknown customer / vehicle shown as such, with their ids', /Unknown customer/.test(html) && /Unknown vehicle/.test(html) && html.includes('VEH-0999'), '');
  ok('   ...a tel: link only for a valid number', html.includes('href="tel:+8801712345678"') && !html.includes('href="tel:017"'), '');
  ok('   ...Open rows offer Record contact and Complete', /data-action="contact" data-id="FUP-0001"/.test(html) && /data-action="complete" data-id="FUP-0001"/.test(html), '');
  check('"Showing N of M" counts the filtered rows against all loaded', el('crfToolbarNote').textContent, 'Showing 5 of 7 follow-ups');
  F.state.status = 'all'; F.renderList();
  const all = el('crfBody').innerHTML;
  ok('closed rows offer no contact or complete action',
    !/data-action="(contact|complete)" data-id="FUP-000(4|5)"/.test(all) && /data-action="view" data-id="FUP-0004"/.test(all), '');
  check('   ...and the count follows the filter', el('crfToolbarNote').textContent, 'Showing 7 of 7 follow-ups');
  check('   ...while the cards do not change', el('crfTotal').innerHTML, String(k.total));
  F.state.status = 'open'; F.state.search = 'zzzz-no-match'; F.renderList();
  ok('no matches: a clear message, not an empty table', /No follow-ups match your search or filters/.test(el('crfBody').innerHTML), '');
  F.state.search = '';
}

/* ---------- 8. empty ---------- */
console.log('\n-- 8. an empty database --');
{
  const { h, el } = page({ fetch: api({ followUps: [] }) });
  h.fireReady();
  await tick(80);
  ok('an honest empty state', /No follow-ups yet/.test(el('crfBody').innerHTML), el('crfBody').innerHTML.slice(0, 200));
  check('   ...with zeros on the cards, not dashes', ['crfTotal', 'crfDueToday', 'crfContacted', 'crfOverdue'].map(id => el(id).innerHTML), ['0', '0', '0', '0']);
  check('   ...and the New button enabled', el('crfNew').disabled, false);
}

/* ---------- 9. failures ---------- */
console.log('\n-- 9. a failing follow-up endpoint --');
{
  const f = api({ failFollowUps: { status: 500, error: { code: 'database_error', message: 'Could not read follow-ups.' } }, failTimes: 2 });
  const { h, el, F } = page({ fetch: f, seedDemo: true });
  h.fireReady();
  await tick(80);
  const html = el('crfBody').innerHTML;
  ok('the page says the follow-ups could not be loaded, with Retry', /could not be loaded/.test(html) && /data-action="retry"/.test(html), html.slice(0, 300));
  ok('   ...shows no row at all, demo or otherwise', !/<tr data-id=/.test(html) && !/DEMO ROW/.test(html), '');
  check('   ...dashes on the cards', el('crfTotal').innerHTML, '<span aria-hidden="true">&#8212;</span>');
  ok('   ...every control disabled', ['crfSearch', 'crfStatus', 'crfDue', 'crfPriority', 'crfNew'].every(id => el(id).disabled === true), '');
  check('   ...while the app itself stays in api mode with its other data', [h.ctx.Storage.mode, h.ctx.Storage.getData('customers').length], ['api', 3]);
  const before = f.calls.filter(c => c.path.startsWith('/follow-ups')).length;
  await F.load();                 // what the Retry button runs
  await tick(40);
  ok('Retry loads again (no full page reload needed) and now succeeds',
    f.calls.filter(c => c.path.startsWith('/follow-ups')).length > before && /<tr data-id=/.test(el('crfBody').innerHTML), '');
}
{
  const { h, el } = page({ fetch: api({ failFollowUps: { status: 0, error: { code: 'timeout', message: 'slow' } } }), seedDemo: true });
  h.fireReady();
  await tick(80);
  ok('a timeout is treated the same way: unavailable, no rows', /could not be loaded/.test(el('crfBody').innerHTML) && !/<tr data-id=/.test(el('crfBody').innerHTML), '');
}

/* ---------- 10. no backend / signed out ---------- */
console.log('\n-- 10. no backend, and signed out --');
{
  const { h, el } = page({ origin: '', seedDemo: true });
  h.ctx.Storage.seedIfEmpty();
  h.fireReady();
  await tick(40);
  const html = el('crfBody').innerHTML;
  ok('no backend: the page says it needs the workshop database', /need the workshop database/.test(html), html.slice(0, 200));
  ok('   ...offers no Retry (there is nothing to retry against)', !/data-action="retry"/.test(html), '');
  ok('   ...and shows none of the demo data, even with a planted follow-up row', !/<tr data-id=/.test(html) && !/DEMO ROW/.test(html), '');
  check('   ...the New button stays disabled', el('crfNew').disabled, true);
}
{
  const f = fakeApi({ authenticated: false });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(60);
  ok('signed out: nothing is read', !f.calls.some(c => c.path.startsWith('/follow-up')), JSON.stringify(f.calls.map(c => c.path)));
  ok('   ...and the loading row is left for the sign-in screen to cover', !/<tr data-id=/.test(el('crfBody').innerHTML), '');
}

process.exit(summary('CRM follow-up unit') === 0 ? 0 : 1);
})();
