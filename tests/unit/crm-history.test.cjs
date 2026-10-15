/* crm-history — Customer CRM › Service History, connected to real data.

   Drives the REAL js/crm-history.js (with the real api.js, storage.js and
   utils.js) through the shared harness, against the in-memory fake API.

     1. Dates: completion day in Asia/Dhaka, actualDelivery fallback,
        impossible dates rejected.
     2. Status groups: every job card status lands in exactly one group.
     3. Counting: one job card is one visit -- service lines, payments and
        a voided-and-replaced invoice never multiply it; Cancelled is never
        a visit.
     4. Money: Utils.liveJobBalance() for paid/due (live invoice, advance
        only, legacy snapshot, cancelled with payment, write-off, voided
        invoice with released advances); cost from the Completed group only.
     5. Search, status and the inclusive date range; range validation.
     6. Pagination: 0, 25, 26 and larger; filters return to page one.
     7. The page in 'api' mode: cards, rows, links, escaping, debounce,
        invalid range, no matches, Clear filters.
     8. The vehicle timeline: owner change, unknown and malformed ids.
     9. Empty database, failures, no backend, signed out: never demo data. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
const ROWS = /<tr data-id="([^"]+)"/g;
const rowIds = html => [...String(html).matchAll(ROWS)].map(m => m[1]);

function page({ origin = 'http://localhost:8787', api, search = '' } = {}) {
  let reloads = 0;
  const h = boot({
    origin, fetch: api, modules: ['js/crm-history.js'],
    beforeModules(doc, ctx) {
      ctx.location.reload = () => { reloads++; };
      ctx.location.search = search;
    },
  });
  vm.runInContext('globalThis.CrmHistory = CrmHistory;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, R: h.ctx.CrmHistory, reloads: () => reloads };
}

/* ---- the workshop data used by most sections ----
   VEH-0001 changed owner: Rahim brought it in for JOB-0001, Karim owns it now.
   JOB-0001  Delivered, three service lines, voided invoice INV-0001 replaced
             by INV-0002 (paid 3,000 of 5,000 in cash, 500 written off).
   JOB-0002  Completed, legacy card: money only typed on the card (1,000 / 2,000).
   JOB-0003  In Progress, an advance of 1,500 and no invoice yet.
   JOB-0004  Cancelled after an advance of 700 was taken.
   JOB-0005  Completed; its invoice INV-0003 was voided, releasing 1,200 back
             to an advance on the job card (the card's invoiceId was cleared).
   JOB-0006  Received today, nothing billed. */
const customers = [
  { id: 'CUS-0001', name: 'Rahim Uddin', phone: '+880 1712-345678' },
  { id: 'CUS-0002', name: 'Karim Mia', phone: '01812-000111' },
  { id: 'CUS-0003', name: '<img src=x onerror=alert(1)>', phone: '019' },
];
const vehicles = [
  { id: 'VEH-0001', customerId: 'CUS-0002', regNo: 'DHAKA-METRO-GA-1234', brand: 'Toyota', model: 'Corolla', status: 'Active' },
  { id: 'VEH-0002', customerId: 'CUS-0002', regNo: 'DHAKA METRO KHA 5678', brand: 'Honda', model: 'Civic', status: 'Active' },
  { id: 'VEH-0003', customerId: 'CUS-0003', regNo: '<b>REG</b>', brand: 'Kia', model: 'Rio', status: 'Active' },
  { id: 'VEH-0004', customerId: 'CUS-0002', regNo: 'NEVER-SERVICED', brand: 'Suzuki', model: 'Swift', status: 'Active' },
];
const line = name => ({ serviceId: null, name, qty: 1, unitPrice: 100, total: 100 });
const job = (o) => ({ completedAt: '', actualDelivery: '', invoiceId: null, mileage: null, mileageOut: null,
  services: [], partsUsed: [], paid: 0, due: 0, total: 0, ...o });
const jobCards = [
  job({ id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', status: 'Delivered', date: '2026-09-01',
    completedAt: '2026-09-02T18:30:00.000Z', actualDelivery: '2026-09-04', invoiceId: 'INV-0002',
    total: 5000, paid: 0, due: 5000, mileage: 12000, mileageOut: 12010,
    services: [line('Oil change'), line('Brake pads'), line('Wheel alignment')] }),
  job({ id: 'JOB-0002', customerId: 'CUS-0002', vehicleId: 'VEH-0001', status: 'Completed', date: '2026-10-01',
    total: 3000, paid: 1000, due: 2000, mileage: 15500, services: [line('Full service')] }),
  job({ id: 'JOB-0003', customerId: 'CUS-0002', vehicleId: 'VEH-0002', status: 'In Progress', date: '2026-10-10',
    total: 4000, paid: 0, due: 4000, mileage: 40000, services: [line('Engine tune-up')] }),
  job({ id: 'JOB-0004', customerId: 'CUS-0002', vehicleId: 'VEH-0002', status: 'Cancelled', date: '2026-10-05',
    total: 2500, paid: 0, due: 2500, services: [line('AC repair')] }),
  job({ id: 'JOB-0005', customerId: 'CUS-0003', vehicleId: 'VEH-0003', status: 'Completed', date: '2026-10-12',
    completedAt: '2026-10-12T05:00:00.000Z', total: 1200, paid: 0, due: 1200,
    services: [line('<script>alert(1)</script>')] }),
  job({ id: 'JOB-0006', customerId: 'CUS-0002', vehicleId: 'VEH-0002', status: 'Received', date: '2026-10-14',
    total: 0, services: [line('Inspection')] }),
];
const invoices = [
  { id: 'INV-0001', jobCardId: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', total: 5000, paid: 0, due: 5000, writtenOff: 0, status: 'Void' },
  { id: 'INV-0002', jobCardId: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', total: 5000, paid: 3000, due: 1500, writtenOff: 500, status: 'Partial' },
  { id: 'INV-0003', jobCardId: 'JOB-0005', customerId: 'CUS-0003', vehicleId: 'VEH-0003', total: 1200, paid: 1200, due: 0, writtenOff: 0, status: 'Void' },
];
const payments = [
  { id: 'PAY-0001', invoiceId: 'INV-0002', customerId: 'CUS-0001', jobCardId: 'JOB-0001', amount: 2000, status: 'Active', date: '2026-09-04' },
  { id: 'PAY-0002', invoiceId: 'INV-0002', customerId: 'CUS-0001', jobCardId: 'JOB-0001', amount: 1000, status: 'Active', date: '2026-09-10' },
  { id: 'PAY-0003', invoiceId: 'INV-0002', customerId: 'CUS-0001', jobCardId: 'JOB-0001', amount: 500, status: 'Void', date: '2026-09-11' },
  { id: 'PAY-0004', invoiceId: null, customerId: 'CUS-0002', jobCardId: 'JOB-0003', amount: 1500, status: 'Active', date: '2026-10-10' },
  { id: 'PAY-0005', invoiceId: null, customerId: 'CUS-0002', jobCardId: 'JOB-0004', amount: 700, status: 'Active', date: '2026-10-05' },
  { id: 'PAY-0006', invoiceId: null, customerId: 'CUS-0003', jobCardId: 'JOB-0005', amount: 1200, status: 'Active', date: '2026-10-12' },
];
const DATA = { customers, vehicles, 'job-cards': jobCards, invoices, payments };

(async () => {
console.log('=== crm-history: Service History ===\n');

/* ---------- 1. dates ---------- */
console.log('-- 1. dates --');
{
  const { R } = page({ origin: '' });
  check('a job completed at 00:30 Dhaka time is completed on that Dhaka day', R.dhakaDateOf('2026-09-02T18:30:00.000Z'), '2026-09-03');
  check('17:59:59Z is still the same Dhaka day', R.dhakaDateOf('2026-10-13T17:59:59Z'), '2026-10-13');
  check('completion date: completedAt (in Dhaka time) wins over actualDelivery',
    R.completionDate({ completedAt: '2026-09-02T18:30:00.000Z', actualDelivery: '2026-09-04' }), '2026-09-03');
  check('   ...actualDelivery is the fallback', R.completionDate({ completedAt: '', actualDelivery: '2026-09-04' }), '2026-09-04');
  check('   ...and nothing readable gives no completion date',
    [R.completionDate({ completedAt: 'soon', actualDelivery: '04/09/2026' }), R.completionDate({})], ['', '']);
  check('isDateOnly rejects impossible or differently written dates',
    ['2026-10-14', '2026-02-30', '2026-13-01', '2026-2-3', '14/10/2026', '2026-10-14T00:00:00Z', null].map(R.isDateOnly),
    [true, false, false, false, false, false, false]);
  check('a service date is shown as that calendar day, never shifted', R.formatDay('2026-10-01'), '1 Oct 2026');
  check('   ...and anything else is a dash, not echoed', R.formatDay('<b>x</b>'), '—');
}

/* ---------- 2. status groups ---------- */
console.log('\n-- 2. status groups --');
{
  const { R } = page({ origin: '' });
  check('every job card status lands in exactly one group',
    ['Completed', 'Delivered', 'Received', 'Inspection', 'Waiting for Approval', 'In Progress', 'Waiting for Parts', 'Cancelled'].map(R.groupOf),
    ['completed', 'completed', 'pending', 'pending', 'pending', 'pending', 'pending', 'cancelled']);
  check('an unknown status belongs to no group (so it is never counted)', [R.groupOf('Archived'), R.groupOf(undefined)], ['', '']);
}

/* The connected page for sections 3-7. */
const api = fakeApi({ rows: DATA });
const P = page({ api });
P.h.fireReady();
await tick();
const { R, el, h } = P;
const money = n => h.ctx.Utils.money(n);
const rec = id => R.state.records.find(r => r.id === id);

/* ---------- 3. counting ---------- */
console.log('\n-- 3. one job card = one visit --');
{
  check('the page is reading the database', h.ctx.Storage.isApi(), true);
  check('one record per job card, newest service date first',
    R.state.records.map(r => r.id), ['JOB-0006', 'JOB-0005', 'JOB-0003', 'JOB-0004', 'JOB-0002', 'JOB-0001']);
  check('three service lines are still one visit', [R.state.records.filter(r => r.id === 'JOB-0001').length, rec('JOB-0001').services.length], [1, 3]);
  check('a voided invoice and its replacement are still one visit, billed by the live one',
    [R.state.records.filter(r => r.id === 'JOB-0001').length, rec('JOB-0001').invoiceId], [1, 'INV-0002']);
  const s = R.summarize(R.state.records);
  check('visits = Completed + Pending; Cancelled is counted apart and never as a visit',
    [s.visits, s.completed, s.pending, s.cancelled], [5, 3, 2, 1]);
  const dup = R.buildRecords({ jobCards: [jobCards[1], { ...jobCards[1] }], customers, vehicles, invoices: [] });
  check('a job card listed twice is still one record', dup.length, 1);
}

/* ---------- 4. money ---------- */
console.log('\n-- 4. money: Utils.liveJobBalance() --');
{
  const money3 = id => { const r = rec(id); return [r.total, r.paid, r.due, r.waived]; };
  check('live invoice: paid and due from the invoice (Active payments only), write-off shown as waived',
    money3('JOB-0001'), [5000, 3000, 1500, 500]);
  check('legacy card: its own typed snapshot', money3('JOB-0002'), [3000, 1000, 2000, 0]);
  check('advance only, no invoice yet: paid = the advance, due = total minus it', money3('JOB-0003'), [4000, 1500, 2500, 0]);
  check('cancelled after a payment: the money taken still shows as paid, nothing is due', money3('JOB-0004'), [2500, 700, 0, 0]);
  check('voided invoice: its frozen figures are ignored, the released advance counts, nothing waived',
    [...money3('JOB-0005'), rec('JOB-0005').invoiceId], [1200, 1200, 0, 0, '']);
  // The wiring itself: every row's paid/due is exactly what the shared rule says.
  const idx = new Map(invoices.map(i => [i.id, i]));
  ok('every row agrees with Utils.liveJobBalance() for the same job card',
    jobCards.every(j => { const b = h.ctx.Utils.liveJobBalance(j, idx); const r = rec(j.id); return r.paid === b.paid && r.due === b.due; }), '');
  const s = R.summarize(R.state.records);
  check('Total Service Cost = Completed + Delivered job card totals only', s.cost, 5000 + 3000 + 1200);
  check('   ...with Paid / Due / Waived for the same cards', [s.paid, s.due, s.waived], [5200, 3500, 500]);
  ok('   ...which add up to the cost (no money counted twice or lost)', s.paid + s.due + s.waived === s.cost, JSON.stringify(s));
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'crm-history.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the module takes paid/due from Utils.liveJobBalance and never sums payments itself',
    /Utils\.liveJobBalance\(/.test(src) && !/getData\('payments'\)|\.amount\b/.test(src), '');
  ok('   ...and never reads invoice lines (the job card\'s own service snapshots only)', !/invoice_services|inv\.services|invoice\.services/.test(src), '');
}

/* ---------- 5. search and filters ---------- */
console.log('\n-- 5. search, status and date range --');
{
  const ids = opts => R.filterRecords(R.state.records, opts).map(r => r.id);
  check('customer name -- the customer the visit was recorded for', ids({ search: 'rahim' }), ['JOB-0001']);
  check('phone by digits only, with or without +880 and separators',
    [ids({ search: '01712345678' }), ids({ search: '+880 1712-345678' }), ids({ search: '1712 345' })],
    [['JOB-0001'], ['JOB-0001'], ['JOB-0001']]);
  check('   ...another customer\'s phone finds all of their visits', ids({ search: '01812000111' }), ['JOB-0006', 'JOB-0003', 'JOB-0004', 'JOB-0002']);
  check('registration with spaces and hyphens ignored',
    [ids({ search: 'ga1234' }), ids({ search: 'dhaka metro ga 1234' }), ids({ search: 'kha-5678' })],
    [['JOB-0002', 'JOB-0001'], ['JOB-0002', 'JOB-0001'], ['JOB-0006', 'JOB-0003', 'JOB-0004']]);
  check('brand and model', [ids({ search: 'HONDA civic' }), ids({ search: 'corolla' })],
    [['JOB-0006', 'JOB-0003', 'JOB-0004'], ['JOB-0002', 'JOB-0001']]);
  check('job card id, and a job card id never matches a phone number', [ids({ search: 'JOB-0005' }), ids({ search: 'job-0003' })], [['JOB-0005'], ['JOB-0003']]);
  check('status groups', [ids({ status: 'completed' }), ids({ status: 'pending' }), ids({ status: 'cancelled' })],
    [['JOB-0005', 'JOB-0002', 'JOB-0001'], ['JOB-0006', 'JOB-0003'], ['JOB-0004']]);
  check('the date range is inclusive at both ends, on the job card\'s own date',
    ids({ from: '2026-10-01', to: '2026-10-10' }), ['JOB-0003', 'JOB-0004', 'JOB-0002']);
  check('   ...the completion date is not what is filtered (JOB-0001 came in on 1 Sep, finished 3 Sep)',
    [ids({ from: '2026-09-02', to: '2026-09-30' }), ids({ from: '2026-09-01', to: '2026-09-01' })], [[], ['JOB-0001']]);
  check('range validation', [R.rangeError('', ''), R.rangeError('2026-10-01', '2026-10-01'), R.rangeError('2026-02-30', ''),
    R.rangeError('', '14/10/2026'), R.rangeError('2026-10-10', '2026-10-01')],
    ['', '', 'The From date is not a valid date.', 'The To date is not a valid date.', 'The From date is after the To date.']);
  check('filters combine', ids({ search: 'karim', status: 'pending', from: '2026-10-11' }), ['JOB-0006']);
  check('a search that matches nothing returns nothing', ids({ search: 'zzz-nothing' }), []);
}

/* ---------- 6. pagination ---------- */
console.log('\n-- 6. pagination --');
{
  const list = n => Array.from({ length: n }, (_, i) => i);
  const p = (n, pg) => { const x = R.paginate(list(n), pg); return [x.page, x.pages, x.from, x.to, x.items.length]; };
  check('0 records: one empty page, "0 of 0"', p(0, 1), [1, 1, 0, 0, 0]);
  check('25 records: exactly one full page', p(25, 1), [1, 1, 1, 25, 25]);
  check('26 records: a second page with one record', [p(26, 1), p(26, 2)], [[1, 2, 1, 25, 25], [2, 2, 26, 26, 1]]);
  check('a page past the end is clamped to the last page', p(60, 9), [3, 3, 51, 60, 10]);
  check('the page size is 25', R.PAGE_SIZE, 25);
}

/* ---------- 7. the page, connected ---------- */
console.log('\n-- 7. the page, connected --');
{
  check('the cards count visits, completed and pending from the database',
    [el('crhVisits').innerHTML, el('crhCompleted').innerHTML, el('crhPending').innerHTML], ['5', '3', '2']);
  check('   ...and the cost, with its breakdown underneath', [el('crhCost').innerHTML, el('crhCostSub').textContent],
    [money(9200), `Paid ${money(5200)} · Due ${money(3500)} · Waived ${money(500)}`]);
  check('   ...saying a cancelled card was not counted', el('crhVisitsSub').textContent, 'Completed + pending · 1 cancelled not counted');
  check('the controls are enabled once the data has loaded',
    ['crhSearch', 'crhStatus', 'crhFrom', 'crhTo', 'crhClear'].map(id => el(id).disabled), [false, false, false, false, false]);
  const body = el('crhBody').innerHTML;
  check('one row per job card', rowIds(body), ['JOB-0006', 'JOB-0005', 'JOB-0003', 'JOB-0004', 'JOB-0002', 'JOB-0001']);
  ok('customer, registration and service text is escaped, never markup',
    body.includes('&lt;img src=x onerror=alert(1)&gt;') && body.includes('&lt;b&gt;REG&lt;/b&gt;')
      && body.includes('&lt;script&gt;alert(1)&lt;/script&gt;')
      && !/<img src=x|<b>REG<\/b>|<script>/.test(body), body.slice(0, 200));
  const row1 = body.slice(body.indexOf('<tr data-id="JOB-0001"'));
  ok('the visit keeps the customer it was recorded for, not the vehicle\'s new owner',
    /data-label="Customer" class="cell-main">Rahim Uddin</.test(row1), row1.slice(0, 400));
  ok('the service date is the arrival day; the completion day is shown apart',
    row1.includes(`${R.formatDay('2026-09-01')}<span class="cell-sub">Completed ${R.formatDay('2026-09-03')}</span>`), '');
  ok('two service names, then "+1 more"', row1.includes('Oil change, Brake pads</span> <span class="crh-more">+1 more</span>'), '');
  ok('mileage in km', row1.includes('12,000 km'), '');
  ok('the cost cell shows the total, paid, due and waived',
    row1.includes(`${money(5000)}<span class="cell-sub">Paid ${money(3000)} · Due ${money(1500)}</span><span class="cell-sub">Waived ${money(500)}</span>`), '');
  ok('the status badge shows the real status in its group\'s tone', row1.includes('<span class="badge badge--good" title="Completed">Delivered</span>'), '');
  ok('links: the job card, the live invoice (never the void one), and the vehicle timeline',
    row1.includes('href="job-cards.html?view=JOB-0001"') && row1.includes('href="invoices.html?view=INV-0002"')
      && !body.includes('INV-0001') && row1.includes('href="crm-history.html?vehicle=VEH-0001"'), '');
  const row5 = body.slice(body.indexOf('<tr data-id="JOB-0005"'), body.indexOf('<tr data-id="JOB-0003"'));
  ok('a job card whose invoice was voided offers no invoice link', !row5.includes('invoices.html'), row5);
  const row4 = body.slice(body.indexOf('<tr data-id="JOB-0004"'), body.indexOf('<tr data-id="JOB-0002"'));
  ok('a cancelled card says it is not counted, and what was paid', row4.includes(`Cancelled · not counted · Paid ${money(700)}`)
    && row4.includes('badge badge--bad'), row4);
  const row2 = body.slice(body.indexOf('<tr data-id="JOB-0002"'), body.indexOf('<tr data-id="JOB-0001"'));
  ok('a finished card with no completion stamp says so', row2.includes('Completion date not recorded'), '');
  const row6 = body.slice(body.indexOf('<tr data-id="JOB-0006"'), body.indexOf('<tr data-id="JOB-0005"'));
  ok('a missing mileage is a dash; a pending card shows "In progress"', row6.includes('data-label="Mileage"><span class="crh-muted">—</span>')
    && row6.includes('In progress · Paid') && row6.includes('badge badge--neutral'), row6);
  check('the note says what is shown', el('crhToolbarNote').textContent, 'Showing 1–6 of 6 service records');
  check('   ...and the pager', [el('crhPager').hidden, el('crhRange').textContent, el('crhPrev').disabled, el('crhNext').disabled], [false, '1–6 of 6', true, true]);

  // Search is debounced: nothing changes until the typing pauses.
  el('crhSearch').dispatch('input', { target: { value: 'corolla' } });
  check('search waits for a pause in typing (debounced)', rowIds(el('crhBody').innerHTML).length, 6);
  await tick(260);
  check('   ...then narrows the table', rowIds(el('crhBody').innerHTML), ['JOB-0002', 'JOB-0001']);
  check('   ...and the cards follow the filtered set', [el('crhVisits').innerHTML, el('crhCompleted').innerHTML, el('crhCost').innerHTML], ['2', '2', money(8000)]);
  check('   ...and the note', el('crhToolbarNote').textContent, 'Showing 1–2 of 2 service records · filtered from 6');

  el('crhSearch').dispatch('input', { target: { value: 'nothing-matches-this' } });
  await tick(260);
  ok('no matches shows a message with Clear filters, not an empty table',
    /No service records match your search or filters/.test(el('crhBody').innerHTML) && /data-action="clear"/.test(el('crhBody').innerHTML), '');
  check('   ...cards read zero for the empty filtered set', [el('crhVisits').innerHTML, el('crhCost').innerHTML], ['0', money(0)]);
  check('   ...and the pager is hidden', el('crhPager').hidden, true);
  el('crhBody').dispatch('click', { target: { closest: sel => (sel === '[data-action]' ? { getAttribute: () => 'clear' } : null) } });
  check('Clear filters (from the message) brings every record back', rowIds(el('crhBody').innerHTML).length, 6);
  check('   ...and empties the inputs', [el('crhSearch').value, el('crhStatus').value, el('crhFrom').value, el('crhTo').value], ['', 'all', '', '']);

  el('crhStatus').dispatch('change', { target: { value: 'cancelled' } });
  check('the status filter', rowIds(el('crhBody').innerHTML), ['JOB-0004']);
  el('crhStatus').dispatch('change', { target: { value: '<bogus>' } });
  check('   ...an unknown value falls back to all statuses', rowIds(el('crhBody').innerHTML).length, 6);

  el('crhFrom').dispatch('change', { target: { value: '2026-10-10' } });
  el('crhTo').dispatch('change', { target: { value: '2026-10-01' } });
  ok('From after To: an inline error, and no records are guessed',
    el('crhRangeError').textContent === 'The From date is after the To date.' && el('crhRangeError').hidden === false
      && /Fix the date range/.test(el('crhBody').innerHTML) && rowIds(el('crhBody').innerHTML).length === 0, el('crhRangeError').textContent);
  check('   ...the cards show dashes, saying why', [el('crhVisits').innerHTML, el('crhVisitsSub').textContent],
    ['<span aria-hidden="true">&#8212;</span>', 'Invalid date range']);
  el('crhTo').dispatch('change', { target: { value: '2026-10-12' } });
  check('fixing the range clears the error and filters inclusively', [el('crhRangeError').hidden, rowIds(el('crhBody').innerHTML)],
    [true, ['JOB-0005', 'JOB-0003']]);
  el('crhClear').dispatch('click');
  check('the toolbar\'s Clear filters button resets everything', rowIds(el('crhBody').innerHTML).length, 6);
  check('nothing was written to the database', api.calls.filter(c => c.method !== 'GET').length, 0);
}

/* ---------- 7b. pagination on the page ---------- */
console.log('\n-- 7b. pagination on the page --');
{
  const many = Array.from({ length: 26 }, (_, i) => job({ id: `JOB-${String(i + 1).padStart(4, '0')}`, customerId: 'CUS-0002',
    vehicleId: i % 2 ? 'VEH-0001' : 'VEH-0002', status: i % 2 ? 'Completed' : 'In Progress',
    date: `2026-09-${String(i + 1).padStart(2, '0')}`, total: 100 }));
  const p = page({ api: fakeApi({ rows: { customers, vehicles, 'job-cards': many } }) });
  p.h.fireReady();
  await tick();
  check('26 records: 25 on the first page', [rowIds(p.el('crhBody').innerHTML).length, p.el('crhRange').textContent], [25, '1–25 of 26']);
  check('   ...Previous disabled, Next enabled', [p.el('crhPrev').disabled, p.el('crhNext').disabled], [true, false]);
  ok('a card with no service line shows a dash, not an empty cell',
    p.el('crhBody').innerHTML.includes('data-label="Services Performed"><span class="crh-muted" title="No service line on this job card">—</span>'), '');
  check('   ...the cards count all 26, not one page', [p.el('crhVisits').innerHTML, p.el('crhCompleted').innerHTML, p.el('crhPending').innerHTML], ['26', '13', '13']);
  p.el('crhNext').dispatch('click');
  check('Next shows the 26th', [rowIds(p.el('crhBody').innerHTML), p.el('crhRange').textContent, p.el('crhNext').disabled],
    [['JOB-0001'], '26–26 of 26', true]);
  p.el('crhNext').dispatch('click');
  check('   ...Next past the end stays on the last page', p.el('crhRange').textContent, '26–26 of 26');
  p.el('crhPrev').dispatch('click');
  check('Previous goes back', p.el('crhRange').textContent, '1–25 of 26');
  p.el('crhNext').dispatch('click');
  p.el('crhStatus').dispatch('change', { target: { value: 'completed' } });
  check('a filter change returns to page one', p.el('crhRange').textContent, '1–13 of 13');
  p.el('crhStatus').dispatch('change', { target: { value: 'all' } });
  p.el('crhNext').dispatch('click');
  p.el('crhSearch').dispatch('input', { target: { value: 'karim' } });
  await tick(260);
  check('   ...and so does a search', p.el('crhRange').textContent, '1–25 of 26');
  p.el('crhNext').dispatch('click');
  p.el('crhFrom').dispatch('change', { target: { value: '2026-09-01' } });
  check('   ...and so does a date change', p.el('crhRange').textContent, '1–25 of 26');
}

/* ---------- 8. vehicle timeline ---------- */
console.log('\n-- 8. vehicle timeline --');
{
  const p = page({ api: fakeApi({ rows: DATA }), search: '?vehicle=VEH-0001' });
  p.h.fireReady();
  await tick();
  const panel = p.el('crhTimeline');
  check('the timeline panel opens for the vehicle in the address', panel.hidden, false);
  const t = panel.innerHTML;
  ok('it names the vehicle and its CURRENT owner', t.includes('DHAKA-METRO-GA-1234') && t.includes('Toyota Corolla')
    && t.includes('Current owner: Karim Mia'), t.slice(0, 600));
  ok('   ...while each visit keeps the customer it was recorded for',
    t.indexOf('Rahim Uddin') > -1 && t.indexOf('Rahim Uddin') < t.indexOf('JOB-0002'), '');
  ok('visits oldest first', t.indexOf('JOB-0001') < t.indexOf('JOB-0002'), '');
  ok('visit count, first and last visit', t.includes('<dt>Visits</dt><dd>2</dd>')
    && t.includes(`<dt>First visit</dt><dd>${p.R.formatDay('2026-09-01')}</dd>`) && t.includes(`<dt>Last visit</dt><dd>${p.R.formatDay('2026-10-01')}</dd>`), '');
  ok('mileage progression', t.includes('12,000 km → 15,500 km (+3,500 km)'), '');
  ok('completed service cost with paid / due / waived', t.includes(`<dd>${p.h.ctx.Utils.money(8000)}</dd>`)
    && t.includes(`${p.h.ctx.Utils.money(4000)} · ${p.h.ctx.Utils.money(3500)} · ${p.h.ctx.Utils.money(500)}`), '');
  check('the table and cards are scoped to the vehicle', [rowIds(p.el('crhBody').innerHTML), p.el('crhVisits').innerHTML], [['JOB-0002', 'JOB-0001'], '2']);

  const q = page({ api: fakeApi({ rows: DATA }), search: '?vehicle=VEH-0002' });
  q.h.fireReady();
  await tick();
  const t2 = q.el('crhTimeline').innerHTML;
  ok('a cancelled visit appears on the timeline but is not counted as a visit',
    t2.includes('JOB-0004') && t2.includes('<dt>Visits</dt><dd>2 <span class="crh-muted">(+1 cancelled)</span></dd>') && t2.includes('· not counted'), '');

  for (const [why, search] of [['an unknown vehicle id', '?vehicle=VEH-9999'], ['a malformed vehicle id', '?vehicle=%3Cscript%3Ealert(1)%3C%2Fscript%3E']]) {
    const u = page({ api: fakeApi({ rows: DATA }), search });
    u.h.fireReady();
    await tick();
    const ut = u.el('crhTimeline').innerHTML, ub = u.el('crhBody').innerHTML;
    ok(`${why}: "Vehicle not found", and no records`, /Vehicle not found/.test(ut) && /No vehicle matches this link/.test(ub) && rowIds(ub).length === 0, ut.slice(0, 200));
    ok('   ...the address is never echoed into the page', !/<script>|alert\(1\)/.test(ut + ub), '');
    check('   ...and the search and filters stay disabled', ['crhSearch', 'crhStatus'].map(id => u.el(id).disabled), [true, true]);
  }
  const n = page({ api: fakeApi({ rows: DATA }), search: '?vehicle=VEH-0004' });
  n.h.fireReady();
  await tick();
  ok('a vehicle with no job card: a timeline that says so, and an empty table',
    /No service visits are recorded for this vehicle yet/.test(n.el('crhTimeline').innerHTML)
      && /No service visits for this vehicle/.test(n.el('crhBody').innerHTML), '');
  const none = page({ api: fakeApi({ rows: DATA }) });
  none.h.fireReady();
  await tick();
  check('with no vehicle in the address, no timeline panel', none.el('crhTimeline').hidden, true);
}

/* ---------- 9. empty, failures, no backend, signed out ---------- */
console.log('\n-- 9. empty database and failures --');
{
  const { h: eh, el: e } = page({ api: fakeApi({ rows: {} }) });
  eh.fireReady();
  await tick();
  check('an empty database is still the database', eh.ctx.Storage.isApi(), true);
  ok('it shows a genuine empty state', /No service records yet/.test(e('crhBody').innerHTML), '');
  check('   ...with zero counts, not dashes', [e('crhVisits').innerHTML, e('crhCompleted').innerHTML, e('crhPending').innerHTML], ['0', '0', '0']);
  check('   ...no pager, and nothing seeded into the browser', [e('crhPager').hidden, eh.ctx.localStorage.getItem('taqwa_seeded')], [true, null]);
}
for (const [why, fail] of [
  ['the job cards request fails (500)', ({ method, path }) => method === 'GET' && path.startsWith('/job-cards') && { status: 500, error: { code: 'database_error', message: 'x' } }],
  ['the payments request fails (500)', ({ method, path }) => method === 'GET' && path.startsWith('/payments') && { status: 500, error: { code: 'database_error', message: 'x' } }],
  ['the health check fails (503)', ({ path }) => path === '/health' && { status: 503, error: { code: 'not_migrated', message: 'x' } }],
]) {
  const p = page({ api: fakeApi({ rows: DATA, fail }) });
  p.h.fireReady();
  await tick();
  // What app.js does after any failed load: seed demo data into this browser.
  p.h.ctx.Storage.seedIfEmpty();
  p.R.render({ mode: 'local', reason: 'database_error' });
  const body = p.el('crhBody').innerHTML;
  const demo = p.h.ctx.Storage.getData('jobCards');
  ok(`${why}: the browser now holds demo job cards (the fallback this page must not show)`, demo.length > 0, String(demo.length));
  ok('   ...but the page lists none of them', rowIds(body).length === 0 && demo.every(j => !body.includes(j.id)), body.slice(0, 200));
  ok('   ...it says the history could not be loaded, and offers Retry',
    /Service history could not be loaded/.test(body) && /data-action="retry"/.test(body), '');
  check('   ...dashes, not counts; controls disabled', [p.el('crhVisits').innerHTML, p.el('crhSearch').disabled, p.el('crhClear').disabled],
    ['<span aria-hidden="true">&#8212;</span>', true, true]);
  p.el('crhBody').dispatch('click', { target: { closest: sel => (sel === '[data-action]' ? { getAttribute: () => 'retry' } : null) } });
  check('   ...and Retry reloads the page, which runs the load again', p.reloads(), 1);
  p.el('crhBody').dispatch('click', { target: { closest: () => null } });
  check('   ...while other clicks in the table do not', p.reloads(), 1);
}
{
  const p = page({ origin: '' });   // file:// or the static demo: no backend at all
  p.h.fireReady();
  await tick(5);
  p.h.ctx.Storage.seedIfEmpty();
  p.R.render({ mode: 'local', reason: 'no_api' });
  const body = p.el('crhBody').innerHTML;
  ok('with no backend at all, the page explains it needs the database', /Service history needs the workshop database/.test(body), '');
  ok('   ...shows no demo record and offers no Retry', rowIds(body).length === 0 && !/data-action="retry"/.test(body), '');
}
{
  const p = page({ api: fakeApi({ authenticated: false, rows: DATA }) });
  p.h.fireReady();
  await tick();
  check('signed out: nothing is rendered (the sign-in screen covers the page)', [p.el('crhBody').innerHTML, p.el('crhVisits').innerHTML], ['', '']);
}

process.exit(summary('CRM history unit') === 0 ? 0 : 1);
})();
