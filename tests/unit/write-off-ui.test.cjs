/* Write-offs (0002) in the UI — runs the REAL shipped js/ modules.

   What the frontend promises, by decision:
     - the stored status stays Unpaid/Partial/Paid/Void; the UI may LABEL a
       balance settled by a write-off "Settled" (cash was paid) or
       "Written Off" (no cash at all);
     - Details shows the written-off figure and the write-offs, and offers
       Write Off / Reverse only with the backend -- offline both are hidden;
     - the write-off request carries the due the user was shown, so the
       server can refuse a balance that moved;
     - the customer's invoice print and payment receipt show
       "Adjustment − ৳X", never the reason, and an invoice with nothing
       written off prints exactly as before;
     - Reports count write-offs separately: never as collected, never as due;
     - Payments' live balance subtracts write-offs, as the server does;
     - a new invoice starts with nothing paid, and the create dialog says
       so when the job card shows a Paid/Advance figure. */
process.env.TZ = 'Asia/Dhaka';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const R = { from: '2000-01-01', to: '2099-12-31' };

/* ---------- page scaffolding ---------- */

/** Elements the page finds with querySelector, one per selector, per page. */
function stubQueries(ctx) {
  const found = new Map();
  const get = (sel) => { if (!found.has(sel)) found.set(sel, makeElement(sel)); return found.get(sel); };
  const all = new Map();
  ctx.document.querySelector = (sel) => get(sel);
  ctx.document.querySelectorAll = (sel) => all.get(sel) || [];
  ctx.document.head = makeElement('head');
  ctx.window.print = () => { ctx.__printed = (ctx.__printed || 0) + 1; };
  return { get, setAll: (sel, list) => all.set(sel, list) };
}

/** Capture Modal.open; each opened modal answers querySelector from its own map. */
function captureModal(ctx) {
  const cap = { opened: [], closed: 0, toasts: [] };
  ctx.Utils.Modal.open = (opts) => {
    const found = new Map();
    // each field control sits in a .field, as in the real dialog
    const el = (sel) => { const e = makeElement(sel); const field = makeElement('.field'); e.closest = () => field; return e; };
    const ov = {
      opts,
      querySelector: (sel) => { if (!found.has(sel)) found.set(sel, el(sel)); return found.get(sel); },
      querySelectorAll: () => [],
    };
    cap.opened.push(ov);
    return ov;
  };
  ctx.Utils.Modal.close = () => { cap.closed++; };
  ctx.Utils.Modal.confirm = (opts) => { cap.confirm = opts; };
  return cap;
}
const last = (cap) => cap.opened[cap.opened.length - 1];

function clickRowAction(els, tbodyId, action, rowId) {
  const btn = { dataset: { action }, closest: (sel) => (sel === 'tr' ? { dataset: { id: rowId } } : btn) };
  els.get(tbodyId).dispatch('click', { target: { closest: (sel) => (sel === '[data-action]' ? btn : null) } });
}

/** Give INV-0002 (4,935 total, 3,000 paid) a write-off in the local store. */
function writeOff(ctx, { invoiceId = 'INV-0002', amount = 1935, status = 'Active', id = 'ADJ-0001', reason = 'Loyal customer goodwill' } = {}) {
  const S = ctx.Storage;
  const adjs = S.getData('invoiceAdjustments').filter((a) => a.id !== id);
  adjs.push({ id, invoiceId, customerId: S.getById('invoices', invoiceId).customerId, type: 'write_off', amount, reason,
    date: '2026-10-08', dueBefore: amount, dueAfter: 0, status, recordedBy: 'Manager',
    voidReason: status === 'Void' ? 'Customer paid' : '', voidedAt: status === 'Void' ? '2026-10-08T10:00:00Z' : null,
    createdAt: '2026-10-08T09:00:00Z' });
  S.saveData('invoiceAdjustments', adjs);
  const inv = S.getById('invoices', invoiceId);
  const active = adjs.filter((a) => a.invoiceId === invoiceId && a.status === 'Active').reduce((s, a) => s + a.amount, 0);
  const wo = Math.min(inv.total - inv.paid, active);
  const due = Math.max(inv.total - inv.paid - wo, 0);
  S.updateData('invoices', invoiceId, { writtenOff: wo, due,
    status: inv.status === 'Void' ? 'Void' : (inv.total > 0 && inv.paid + wo >= inv.total ? 'Paid' : inv.paid > 0 ? 'Partial' : 'Unpaid') });
}

function invoicesPage({ api = false, setup } = {}) {
  const page = boot({ modules: ['js/invoices.js'] });
  page.ctx.Storage.seedIfEmpty();
  if (setup) setup(page.ctx);
  page.q = stubQueries(page.ctx);
  if (api) page.ctx.Storage.isApi = () => true;
  page.fireReady();
  page.cap = captureModal(page.ctx);
  return page;
}

(async () => {
/* ============================================================
   1. Labels
   ============================================================ */
console.log('=== 1. Status labels ===');
{
  const { ctx } = boot({});
  const L = ctx.Utils.invoiceStatusLabel;
  check('cash in full: Paid', L({ status: 'Paid', paid: 3000, writtenOff: 0, due: 0 }), 'Paid');
  check('cash + write-off covering the rest: Settled', L({ status: 'Paid', paid: 2000, writtenOff: 1000, due: 0 }), 'Settled');
  check('no cash, all written off: Written Off', L({ status: 'Paid', paid: 0, writtenOff: 3000, due: 0 }), 'Written Off');
  check('a partial write-off keeps the stored status', L({ status: 'Partial', paid: 2000, writtenOff: 500, due: 500 }), 'Partial');
  check('   ...also with no cash', L({ status: 'Unpaid', paid: 0, writtenOff: 500, due: 2500 }), 'Unpaid');
  check('Void is always Void', L({ status: 'Void', paid: 2000, writtenOff: 1000, due: 0 }), 'Void');
  check('a record from before 0002 (no writtenOff) reads as stored', L({ status: 'Partial', paid: 1, due: 2 }), 'Partial');
  check('nothing -> empty', L(null), '');
  ok('Settled is badged as good news', /good/.test(ctx.Utils.badge('Settled')), ctx.Utils.badge('Settled'));
  ok('Written Off has its own tone', /info/.test(ctx.Utils.badge('Written Off')), ctx.Utils.badge('Written Off'));
}

/* ============================================================
   2. Storage
   ============================================================ */
console.log('\n=== 2. Storage ===');
{
  const { ctx } = boot({});
  ok('invoiceAdjustments is a collection', ctx.Storage.COLLECTIONS.includes('invoiceAdjustments'), ctx.Storage.COLLECTIONS.join(','));
  ctx.Storage.seedIfEmpty();
  check('   ...seeded empty offline', ctx.Storage.getData('invoiceAdjustments'), []);
  const src = fs.readFileSync(path.join(ROOT, 'js/storage.js'), 'utf8');
  ok('   ...served by /api/invoice-adjustments', /invoiceAdjustments:\s*'invoice-adjustments'/.test(src));
}

/* ============================================================
   3. Invoice list
   ============================================================ */
console.log('\n=== 3. Invoice list ===');
{
  const { els } = invoicesPage({ setup: (ctx) => writeOff(ctx) });
  const html = els.get('invcTableBody').innerHTML;
  ok('a settled invoice is labelled Settled in the list', /INV-0002[\s\S]*?Settled/.test(html), html.slice(0, 300));
  const stats = els.get('invcStats') ? els.get('invcStats').innerHTML : '';
  ok('no Written Off stat on the Invoice list', !/Written Off/.test(stats), stats.slice(0, 300));
}

/* ============================================================
   4. Details
   ============================================================ */
console.log('\n=== 4. Details ===');
{
  console.log('-- offline: the feature is hidden --');
  const { els, cap } = invoicesPage();
  clickRowAction(els, 'invcTableBody', 'view', 'INV-0002');
  const m = last(cap).opts;
  ok('Details opens', /Invoice INV-0002/.test(m.title), m.title);
  ok('no Write Off button offline', !/data-write-off/.test(m.footer), m.footer);
  ok('no Written off row when nothing is written off', !/inv-view__wo/.test(m.body));
  ok('no Adjustments section when there are none', !/Adjustments/.test(m.body));
  ok('Record Payment is still offered', /Record Payment/.test(m.footer));
}
{
  console.log('-- online, with a balance --');
  const { els, cap, q, ctx } = invoicesPage({ api: true });
  clickRowAction(els, 'invcTableBody', 'view', 'INV-0002');
  const m = last(cap).opts;
  ok('Write Off Balance is offered with the backend', /data-write-off[^>]*>Write Off Balance/.test(m.footer), m.footer);
  ok('   ...next to Record Payment', /Record Payment/.test(m.footer));

  q.get('[data-write-off]').dispatch('click');
  const wo = last(cap);
  ok('the button opens the write-off dialog', /Write Off Balance — INV-0002/.test(wo.opts.title), wo.opts.title);
  ok('   ...the amount defaults to the due', /id="wo-amount"[^>]*value="1935"/.test(wo.opts.body), wo.opts.body.slice(0, 600));
  ok('   ...the date is read-only, today', /id="wo-date"[^>]*readonly/.test(wo.opts.body));
  ok('   ...reason is asked for, recorded-by is optional', /id="wo-reason"/.test(wo.opts.body) && /Recorded by \(optional\)/.test(wo.opts.body));
  ok('   ...and it says a write-off is not a payment', /not a payment/.test(wo.opts.body));

  // Save with no reason: refused in the browser, nothing sent.
  let sent = null;
  ctx.Storage.create = async (collection, record) => { sent = { collection, record }; return { ok: true, record: { id: 'ADJ-0001' } }; };
  ctx.Storage.refreshAll = async () => [];
  wo.querySelector('#wo-amount').value = '500';
  wo.querySelector('#wo-reason').value = '   ';
  await wo.querySelector('[data-save]')._on.click[0]({});
  ok('no reason -> refused before sending', sent === null && /required/.test(wo.querySelector('[data-err="reason"]').textContent));
  wo.querySelector('#wo-reason').value = 'Old customer';
  wo.querySelector('#wo-amount').value = '2000';
  await wo.querySelector('[data-save]')._on.click[0]({});
  ok('more than the due -> refused before sending', sent === null && /cannot exceed/.test(wo.querySelector('[data-err="amount"]').textContent));

  wo.querySelector('#wo-amount').value = '500';
  wo.querySelector('#wo-by').value = ' Manager ';
  await wo.querySelector('[data-save]')._on.click[0]({});
  check('a valid write-off is sent to invoiceAdjustments', sent && sent.collection, 'invoiceAdjustments');
  check('   ...with the due the user was shown, and no date, customer or status',
    sent && sent.record, { invoiceId: 'INV-0002', amount: 500, reason: 'Old customer', expectedDue: 1935, recordedBy: 'Manager' });
  ok('   ...then Details reopens', /Invoice INV-0002/.test(last(cap).opts.title), last(cap).opts.title);
}
{
  console.log('-- online, the server says the balance moved --');
  const { els, cap, q, ctx } = invoicesPage({ api: true });
  clickRowAction(els, 'invcTableBody', 'view', 'INV-0002');
  q.get('[data-write-off]').dispatch('click');
  const wo = last(cap);
  ctx.Storage.create = async () => ({ ok: false, status: 409, message: 'The invoice balance has changed.' });
  ctx.Storage.refreshAll = async () => { ctx.Storage.updateData('invoices', 'INV-0002', { paid: 4000, due: 935, status: 'Partial' }); return []; };
  wo.querySelector('#wo-amount').value = '1935';
  wo.querySelector('#wo-reason').value = 'x';
  await wo.querySelector('[data-save]')._on.click[0]({});
  ok('a 409 shows the new due instead of writing off blind', /now ৳?\s?935|935/.test(wo.querySelector('[data-err="expectedDue"]').textContent),
    wo.querySelector('[data-err="expectedDue"]').textContent);
  check('   ...and lowers the amount to it', wo.querySelector('#wo-amount').value, '935');
  ok('   ...the dialog stays open', last(cap) === wo);
}
{
  console.log('-- online, settled by a write-off --');
  const { els, cap, q, ctx } = invoicesPage({ api: true, setup: (c) => { writeOff(c, { id: 'ADJ-0001', amount: 400, status: 'Void' }); writeOff(c, { id: 'ADJ-0002' }); } });
  const reverseBtn = makeElement('rev'); reverseBtn.dataset.reverseAdj = 'ADJ-0002';
  q.setAll('[data-reverse-adj]', [reverseBtn]);
  clickRowAction(els, 'invcTableBody', 'view', 'INV-0002');
  const m = last(cap).opts;
  ok('the totals show the written-off figure', /inv-view__wo"><span>Written off<\/span><strong>− [^<]*1,935/.test(m.body), m.body.match(/inv-view__wo[\s\S]{0,120}/)?.[0]);
  ok('the status card says it is settled', /This invoice is settled\./.test(m.body), m.body.match(/inv-view__pay-msg[^<]*<[^>]*>[^<]*/)?.[0]);
  ok('no Write Off button once nothing is due', !/data-write-off/.test(m.footer), m.footer);
  ok('the Adjustments section lists both write-offs', /Adjustments/.test(m.body) && /ADJ-0001/.test(m.body) && /ADJ-0002/.test(m.body));
  ok('   ...the reason is shown to staff here', /Loyal customer goodwill/.test(m.body));
  ok('   ...a reversed one is marked, with why', /Reversed: Customer paid/.test(m.body));
  ok('   ...Reverse is offered only on the active one',
    (m.body.match(/data-reverse-adj=/g) || []).length === 1 && /data-reverse-adj="ADJ-0002"/.test(m.body), m.body.match(/data-reverse-adj="[^"]+"/g));

  reverseBtn.dispatch('click');
  const rv = last(cap);
  ok('Reverse opens its own dialog', /Reverse Write-off — ADJ-0002/.test(rv.opts.title), rv.opts.title);
  let action = null;
  ctx.Storage.action = async (...args) => { action = args; return { ok: true }; };
  rv.querySelector('#wo-void-reason').value = '';
  await rv.querySelector('[data-save]')._on.click[0]({});
  ok('a reversal needs a reason', action === null);
  rv.querySelector('#wo-void-reason').value = 'Customer will pay';
  await rv.querySelector('[data-save]')._on.click[0]({});
  check('   ...then calls the void action and refreshes invoices', action,
    ['invoiceAdjustments', 'ADJ-0002', 'void', { voidReason: 'Customer will pay' }, ['invoices']]);
}
{
  console.log('-- offline, with write-offs on record --');
  const { els, cap } = invoicesPage({ setup: (c) => writeOff(c) });
  clickRowAction(els, 'invcTableBody', 'view', 'INV-0002');
  const m = last(cap).opts;
  ok('the history still shows', /Adjustments/.test(m.body));
  ok('   ...but there is no Reverse button offline', !/data-reverse-adj/.test(m.body));
}
{
  console.log('-- online, a Void invoice --');
  const { els, cap } = invoicesPage({ api: true, setup: (c) => { writeOff(c, { amount: 500 }); c.Storage.updateData('invoices', 'INV-0002', { status: 'Void' }); } });
  clickRowAction(els, 'invcTableBody', 'view', 'INV-0002');
  const m = last(cap).opts;
  ok('no Write Off on a Void invoice', !/data-write-off/.test(m.footer));
  ok('   ...and no Reverse either: its write-offs are frozen', !/data-reverse-adj/.test(m.body));
}

/* ============================================================
   5. Invoice print
   ============================================================ */
console.log('\n=== 5. Invoice print ===');
{
  const { els, ctx } = invoicesPage({ setup: (c) => writeOff(c) });
  clickRowAction(els, 'invcTableBody', 'print', 'INV-0002');
  const html = els.get('printArea').innerHTML;
  ok('the print shows the adjustment', /<tr class="ivp-sum__adj"><td>Adjustment<\/td><td class="pr-num">− [^<]*1,935/.test(html), html.match(/ivp-sum__adj[\s\S]{0,120}/)?.[0]);
  ok('   ...between Paid and Due', /ivp-sum__paid[\s\S]*ivp-sum__adj[\s\S]*ivp-sum__due/.test(html));
  ok('   ...stamped SETTLED, "Balance Adjusted"', /ivp-stamp--settled/.test(html) && /<strong>Settled<\/strong>/.test(html) && /Balance Adjusted/.test(html));
  ok('   ...never the reason', !/Loyal customer goodwill/.test(html));
  ok('   ...never the words "Written Off" or "write-off"', !/written off|write-off/i.test(html));
  check('   ...and it printed', ctx.__printed, 1);
}
{
  const { els } = invoicesPage({ setup: (c) => writeOff(c, { amount: 500 }) });
  clickRowAction(els, 'invcTableBody', 'print', 'INV-0002');
  const html = els.get('printArea').innerHTML;
  ok('a partial write-off prints the adjustment and the remaining due', /Adjustment/.test(html) && /ivp-sum__due--open/.test(html));
  ok('   ...and keeps the stored status stamp', !/<strong>Settled<\/strong>/.test(html));
}
{
  const { els } = invoicesPage();
  clickRowAction(els, 'invcTableBody', 'print', 'INV-0002');
  const html = els.get('printArea').innerHTML;
  ok('nothing written off -> no Adjustment row', !/Adjustment|ivp-sum__adj/.test(html));
  ok('   ...and no Settled stamp', !/Settled|Balance Adjusted/.test(html));
}

/* ============================================================
   6. Payment receipt
   ============================================================ */
console.log('\n=== 6. Payment receipt ===');
function paymentsPage(setup) {
  const page = boot({ modules: ['js/payments.js'] });
  page.ctx.Storage.seedIfEmpty();
  if (setup) setup(page.ctx);
  stubQueries(page.ctx);
  page.fireReady();
  captureModal(page.ctx);
  return page;
}
{
  const { els } = paymentsPage((c) => writeOff(c));
  clickRowAction(els, 'payTableBody', 'print', 'PAY-0002');
  const html = els.get('printArea').innerHTML;
  ok('the receipt shows "Adjustment − ৳X"', /<tr><td>Adjustment<\/td><td>− [^<]*1,935/.test(html), html.match(/Adjustment[\s\S]{0,80}/)?.[0]);
  ok('   ...and not the reason', !/Loyal customer goodwill/.test(html));
}
{
  const { els } = paymentsPage();
  clickRowAction(els, 'payTableBody', 'print', 'PAY-0002');
  ok('no write-off -> no Adjustment line', !/Adjustment/.test(els.get('printArea').innerHTML));
}

/* ============================================================
   7. Reports and payments arithmetic
   ============================================================ */
console.log('\n=== 7. Reports and payment balance ===');
function api(ctx) {
  const inv = fs.readFileSync(`${ROOT}/js/invoices.js`, 'utf8');
  const pay = fs.readFileSync(`${ROOT}/js/payments.js`, 'utf8');
  const rep = fs.readFileSync(`${ROOT}/js/reports.js`, 'utf8');
  const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b);
    if (i < 0 || j <= i) throw new Error(`slice failed: ${a}`); return s.slice(i, j); };
  const sb = { Storage: ctx.Storage, Utils: ctx.Utils, money: ctx.Utils.money, esc: ctx.Utils.esc,
    fmtDate: ctx.Utils.fmtDate, badge: ctx.Utils.badge,
    METHODS: ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'],
    ELIGIBLE_JOB_STATUSES: ['Completed', 'Delivered'],
    Date, Math, JSON, Number, String, Object, Array, Map, Set, console, api: {} };
  vm.createContext(sb);
  vm.runInContext(
    cut(inv, 'function deriveStatus', '/* ---------- summary cards') + '\n' +
    cut(pay, 'function deriveInvoiceStatus', '/* ---------- summary cards') + '\n' +
    cut(rep, 'function parseLocalDate', 'function statCardsHtml') + `
    api.createInvoiceFromJobCard = createInvoiceFromJobCard;
    api.outstandingBalance = outstandingBalance; api.validatePayment = validatePayment;
    api.computeInvoiceReport = computeInvoiceReport; api.computeRevenueReport = computeRevenueReport;
  `, sb);
  return sb.api;
}
{
  const { ctx } = boot({});
  ctx.Storage.seedIfEmpty();
  const a = api(ctx);
  const before = a.computeInvoiceReport(R);
  check('with no write-offs the report has none', before.totalWrittenOff, 0);
  writeOff(ctx, { amount: 1000 });
  const after = a.computeInvoiceReport(R);
  const row = after.rows.find((r) => r.id === 'INV-0002');
  check('a write-off shows as written off on its invoice', [row.livePaid, row.liveWrittenOff, row.liveDue], [3000, 1000, 935]);
  check('   ...the report total counts it', after.totalWrittenOff, 1000);
  check('   ...collected is unchanged: a write-off is not cash', after.totalCollected, before.totalCollected);
  check('   ...due falls by exactly the write-off', before.totalDue - after.totalDue, 1000);
  check('   ...revenue is unchanged', a.computeRevenueReport(R).total, (() => { const c2 = boot({}).ctx; c2.Storage.seedIfEmpty(); return api(c2).computeRevenueReport(R).total; })());
  writeOff(ctx, { id: 'ADJ-0002', amount: 5000 });
  const capped = a.computeInvoiceReport(R).rows.find((r) => r.id === 'INV-0002');
  check('write-offs are capped at what cash left unpaid', [capped.liveWrittenOff, capped.liveDue], [1935, 0]);
  writeOff(ctx, { id: 'ADJ-0002', amount: 5000, status: 'Void' });
  check('a reversed write-off no longer counts', a.computeInvoiceReport(R).rows.find((r) => r.id === 'INV-0002').liveWrittenOff, 1000);

  check('Payments: the live balance subtracts write-offs', a.outstandingBalance('INV-0002'), 935);
  const v = a.validatePayment({ invoiceId: 'INV-0002', customerId: ctx.Storage.getById('invoices', 'INV-0002').customerId, amount: 936 });
  ok('   ...and a payment cannot use room a write-off took', v && v.ok === false, JSON.stringify(v));
  const v2 = a.validatePayment({ invoiceId: 'INV-0002', customerId: ctx.Storage.getById('invoices', 'INV-0002').customerId, amount: 935 });
  ok('   ...but the exact remainder is accepted', v2 && v2.ok !== false, JSON.stringify(v2));

  ctx.Storage.updateData('invoices', 'INV-0002', { status: 'Void' });
  const vrow = a.computeInvoiceReport(R).rows.find((r) => r.id === 'INV-0002');
  check('a Void invoice counts no write-off and no due', [vrow.liveWrittenOff, vrow.liveDue], [0, 0]);
}

/* ============================================================
   8. Creating an invoice
   ============================================================ */
console.log('\n=== 8. Creating an invoice: nothing is paid yet ===');
{
  const page = boot({ modules: ['js/invoices.js'] });
  const { ctx, els } = page;
  ctx.Storage.seedIfEmpty();
  ctx.Storage.updateData('jobCards', 'JOB-0003', { status: 'Completed' });   // total 5,775, Paid/Advance 2,000
  ctx.location.search = '?fromJobCard=JOB-0003';
  stubQueries(ctx);
  const cap = { opened: [] };
  ctx.Utils.Modal.open = (opts) => {
    const found = new Map();
    const ov = { opts, querySelector: (s) => { if (!found.has(s)) found.set(s, makeElement(s)); return found.get(s); }, querySelectorAll: () => [] };
    cap.opened.push(ov); return ov;
  };
  ctx.Utils.Modal.close = () => {};
  page.fireReady();
  const create = cap.opened.find((o) => /Create Invoice — JOB-0003/.test(o.opts.title));
  ok('the create dialog opens', !!create, cap.opened.map((o) => o.opts.title).join(' | '));
  ok('   ...and warns that the job card Paid/Advance is not applied',
    /class="invc-create__warn" role="note">This Job Card shows [^<]*2,000 as Paid\/Advance\. It is not a recorded payment and won't be applied\./.test(create.opts.body),
    create.opts.body.slice(-400));
  create.querySelector('#invc-date').value = '2026-10-08';
  create.querySelector('#invc-notes').value = '';
  await create.querySelector('[data-save]')._on.click[0]({});
  const made = ctx.Storage.getData('invoices').find((i) => i.jobCardId === 'JOB-0003');
  check('offline, the new invoice starts with nothing paid', made && [made.total, made.paid, made.due, made.status], [5775, 0, 5775, 'Unpaid']);
  check('   ...and the job card keeps its Paid/Advance figure', ctx.Storage.getById('jobCards', 'JOB-0003').paid, 2000);
  ok('   ...the list now shows it Unpaid', new RegExp(`${made && made.id}[\\s\\S]*?Unpaid`).test(els.get('invcTableBody').innerHTML));
}
{
  const page = boot({ modules: ['js/invoices.js'] });
  const { ctx } = page;
  ctx.Storage.seedIfEmpty();
  ctx.Storage.updateData('jobCards', 'JOB-0004', { status: 'Completed' });   // Paid/Advance 0
  ctx.location.search = '?fromJobCard=JOB-0004';
  stubQueries(ctx);
  let opened = null;
  ctx.Utils.Modal.open = (opts) => { opened = opts; return { querySelector: () => makeElement('x'), querySelectorAll: () => [] }; };
  page.fireReady();
  ok('no Paid/Advance on the job card -> no warning', opened && !/invc-create__warn/.test(opened.body), opened && opened.title);
}

/* ============================================================
   9. With the backend
   ============================================================ */
console.log('\n=== 9. API mode ===');
{
  const adj = { id: 'ADJ-0001', invoiceId: 'INV-0001', amount: 100, status: 'Active' };
  const f = fakeApi({ rows: { 'invoice-adjustments': [adj], invoices: [{ id: 'INV-0001', total: 500, paid: 0, writtenOff: 100, due: 400, status: 'Unpaid' }] } });
  const { ctx } = boot({ origin: 'http://localhost:8787', fetch: f });
  await ctx.Storage.hydrate();
  ok('the backend is in use', ctx.Storage.isApi());
  ok('hydration reads /invoice-adjustments', f.calls.some((c) => c.method === 'GET' && c.path.startsWith('/invoice-adjustments')),
    f.calls.map((c) => c.method + ' ' + c.path).join(', '));
  check('   ...into the invoiceAdjustments collection', ctx.Storage.getData('invoiceAdjustments').map((a) => a.id), ['ADJ-0001']);
  check('   ...and the invoice keeps its writtenOff', ctx.Storage.getById('invoices', 'INV-0001').writtenOff, 100);

  const res = await ctx.Storage.create('invoiceAdjustments', { invoiceId: 'INV-0001', amount: 50, reason: 'r', expectedDue: 400 });
  const post = f.calls.find((c) => c.method === 'POST' && c.path === '/invoice-adjustments');
  ok('a write-off is POSTed to /invoice-adjustments', res.ok && !!post, JSON.stringify(res));
  check('   ...with exactly the fields the dialog sends', post && post.body, { invoiceId: 'INV-0001', amount: 50, reason: 'r', expectedDue: 400 });
  ok('   ...and the id is the server\'s', /^ADJ-\d{4}$/.test(res.record && res.record.id), res.record && res.record.id);

  const v = await ctx.Storage.action('invoiceAdjustments', 'ADJ-0001', 'void', { voidReason: 'x' }, ['invoices']);
  ok('a reversal is POSTed to /invoice-adjustments/:id/void',
    v.ok && f.calls.some((c) => c.method === 'POST' && c.path === '/invoice-adjustments/ADJ-0001/void'), JSON.stringify(v));
}

process.exit(summary('Write-off UI') === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
