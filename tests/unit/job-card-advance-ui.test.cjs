/* Job Card Advance in the UI — runs the REAL shipped js/ modules.

   What the frontend promises:
     - a job card's live paid/due follows its RECORDED advances (payments
       against it, no invoice yet) before invoicing; a legacy card with only
       a typed figure keeps showing that figure;
     - Payments mirrors the server's job card guards: same customer, and an
       advance only for a job card that is not yet invoiced;
     - "Record Advance" opens Payments' record dialog as an advance with the
       customer and job card chosen and NO amount pre-filled;
     - the Job Card form no longer takes a typed Paid / Advance, and keeps a
       legacy card's stored value untouched;
     - the Job Card details list the payments taken against it and say
       whether each is applied;
     - offline invoice creation refuses advances over the total, as the
       server does (the applied case is in write-off-ui section 8).

   Seed facts used: JOB-0003 (CUS-0003, total 5,775, typed paid 2,000, not
   invoiced) has PAY-0004, a recorded 2,000 Cash advance. JOB-0002 (CUS-0002)
   is invoiced as INV-0002 and PAY-0002 is linked to it. */
process.env.TZ = 'Asia/Dhaka';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

function stubQueries(ctx) {
  const found = new Map();
  const get = (sel) => { if (!found.has(sel)) found.set(sel, makeElement(sel)); return found.get(sel); };
  ctx.document.querySelector = (sel) => get(sel);
  ctx.document.querySelectorAll = () => [];
  ctx.document.head = makeElement('head');
  ctx.window.print = () => {};
}
function captureModal(ctx) {
  const cap = { opened: [] };
  ctx.Utils.Modal.open = (opts) => {
    const found = new Map();
    const el = (sel) => { const e = makeElement(sel); const field = makeElement('.field'); e.closest = () => field; return e; };
    const ov = { opts, querySelector: (sel) => { if (!found.has(sel)) found.set(sel, el(sel)); return found.get(sel); }, querySelectorAll: () => [] };
    cap.opened.push(ov);
    return ov;
  };
  ctx.Utils.Modal.close = () => {};
  // Modules hold their own reference to Utils.toast, so read what it renders:
  // every element it creates is kept, and a toast is the one with a dot.
  const created = [];
  const make = ctx.document.createElement;
  ctx.document.createElement = (tag) => { const e = make(tag); created.push(e); return e; };
  Object.defineProperty(cap, 'toasts', {
    get: () => created.filter((e) => /toast__dot/.test(e.innerHTML)).map((e) => [e.innerHTML.replace(/<[^>]+>/g, '')]),
  });
  return cap;
}

/** The payment validation, lifted from the shipped file into a sandbox. */
function paymentsApi(ctx) {
  const src = fs.readFileSync(`${ROOT}/js/payments.js`, 'utf8');
  const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b);
    if (i < 0 || j <= i) throw new Error(`slice failed: ${a}`); return s.slice(i, j); };
  const sb = { Storage: ctx.Storage, Utils: ctx.Utils, money: ctx.Utils.money, esc: ctx.Utils.esc,
    fmtDate: ctx.Utils.fmtDate, badge: ctx.Utils.badge, METHODS: ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'],
    Date, Math, JSON, Number, String, Object, Array, Map, Set, Promise, console, api: {} };
  vm.createContext(sb);
  vm.runInContext(cut(src, 'function deriveInvoiceStatus', '/* ---------- summary cards') + `
    api.validatePayment = validatePayment; api.recordPayment = recordPayment;
    api.linkPaymentToInvoice = linkPaymentToInvoice;`, sb);
  return sb.api;
}

console.log('=== Job Card Advance UI ===');

/* ---------------------------------------------------------- */
console.log('\n-- 1. Live job balance follows recorded advances --');
{
  const { ctx } = boot({});
  ctx.Storage.seedIfEmpty();
  const U = ctx.Utils, S = ctx.Storage;
  // make the typed figure disagree with the ledger, so the source is visible
  S.updateData('jobCards', 'JOB-0003', { paid: 0, due: 5775 });
  check('JOB-0003: paid is its recorded advance, not the typed 0', U.liveJobBalance(S.getById('jobCards', 'JOB-0003')), { paid: 2000, due: 3775 });
  check('   ...jobAdvances lists it', U.jobAdvances('JOB-0003').map((p) => p.id), ['PAY-0004']);
  S.addData('payments', { invoiceId: null, customerId: 'CUS-0003', jobCardId: 'JOB-0003', date: U.todayStr(), amount: 500, method: 'Card', notes: '', status: 'Active' });
  check('   ...a second advance adds to it', U.liveJobBalance(S.getById('jobCards', 'JOB-0003')), { paid: 2500, due: 3275 });
  const jobs = S.getData('jobCards').filter((j) => j.customerId === 'CUS-0003');
  check('   ...and the customer totals agree', [U.sumJobsPaid(jobs), U.sumJobsDue(jobs)],
    jobs.reduce((t, j) => { const b = U.liveJobBalance(j); return [t[0] + b.paid, t[1] + b.due]; }, [0, 0]));
  S.getData('payments').filter((p) => p.jobCardId === 'JOB-0003').forEach((p) => S.updateData('payments', p.id, { status: 'Void' }));
  check('voided advances count for nothing -> back to the typed snapshot', U.liveJobBalance(S.getById('jobCards', 'JOB-0003')), { paid: 0, due: 5775 });
  check('an invoiced job card still reads its invoice', U.liveJobBalance(S.getById('jobCards', 'JOB-0002')),
    { paid: S.getById('invoices', 'INV-0002').paid, due: S.getById('invoices', 'INV-0002').due });
  S.updateData('jobCards', 'JOB-0003', { status: 'Cancelled' });
  S.updateData('payments', 'PAY-0004', { status: 'Active' });
  check('a Cancelled job card owes nothing, but its advance still shows as paid', U.liveJobBalance(S.getById('jobCards', 'JOB-0003')), { paid: 2000, due: 0 });
}

/* ---------------------------------------------------------- */
console.log('\n-- 2. Payments mirrors the server\'s job card guards --');
{
  const { ctx } = boot({});
  ctx.Storage.seedIfEmpty();
  const a = paymentsApi(ctx);
  const base = { invoiceId: null, amount: 100 };
  const wrong = a.validatePayment({ ...base, customerId: 'CUS-0001', jobCardId: 'JOB-0003' });
  ok('an advance for another customer\'s job card is refused', !wrong.ok && /different customer/.test(wrong.reason), JSON.stringify(wrong));
  const invoiced = a.validatePayment({ ...base, customerId: 'CUS-0002', jobCardId: 'JOB-0002' });
  ok('an advance for an invoiced job card is refused, naming the invoice',
    !invoiced.ok && /already invoiced \(INV-0002\)/.test(invoiced.reason), JSON.stringify(invoiced));
  ok('an advance for the customer\'s own un-invoiced job card is fine', a.validatePayment({ ...base, customerId: 'CUS-0003', jobCardId: 'JOB-0003' }).ok);
  ok('a payment against the invoice of an invoiced job card is fine',
    a.validatePayment({ invoiceId: 'INV-0002', customerId: 'CUS-0002', jobCardId: 'JOB-0002', amount: 100 }).ok);
  const before = ctx.Storage.getData('payments').length;
  const r = a.recordPayment({ invoiceId: null, customerId: 'CUS-0001', jobCardId: 'JOB-0003', date: '2026-10-09', amount: 100, method: 'Cash', notes: '' });
  ok('recordPayment refuses it and writes nothing', !r.ok && ctx.Storage.getData('payments').length === before, JSON.stringify(r));
}

/* ---------------------------------------------------------- */
console.log('\n-- 3. Record Advance opens Payments as an advance for that job card --');
function paymentsPage(search, setup) {
  const page = boot({ modules: ['js/payments.js'] });
  page.ctx.Storage.seedIfEmpty();
  if (setup) setup(page.ctx);
  page.ctx.location.search = search;
  stubQueries(page.ctx);
  const cap = captureModal(page.ctx);
  page.fireReady();
  return { ...page, cap };
}
{
  const { cap } = paymentsPage('?advanceFor=JOB-0003');
  const m = cap.opened.find((o) => o.opts.title === 'Record Payment');
  ok('?advanceFor opens the record dialog', !!m, cap.opened.map((o) => o.opts.title).join(' | '));
  const body = m ? m.opts.body : '';
  ok('   ...as an advance', /<option value="advance" selected>/.test(body), body.slice(0, 400));
  ok('   ...for the job card\'s customer', /id="pf-customer" name="customerId" value="CUS-0003"/.test(body));
  ok('   ...with the job card chosen', /<option value="JOB-0003" selected>/.test(body));
  ok('   ...and the Job Card field shown', /id="pf-jobcard-wrap" >/.test(body) || /id="pf-jobcard-wrap"\s*>/.test(body));
  ok('   ...and NO amount pre-filled', /id="pf-amount"[^>]*value=""/.test(body), (body.match(/id="pf-amount"[^>]*>/) || [''])[0]);
}
{
  const { cap } = paymentsPage('?advanceFor=JOB-0002');
  ok('?advanceFor an invoiced job card warns instead', cap.toasts.some(([m]) => /JOB-0002 is already invoiced \(INV-0002\)/.test(m)), JSON.stringify(cap.toasts));
  const m = cap.opened.find((o) => o.opts.title === 'Record Payment');
  ok('   ...and opens a payment against that invoice', m && /<option value="invoice" selected>/.test(m.opts.body) && /<option value="INV-0002" selected>/.test(m.opts.body),
    m && m.opts.body.slice(0, 600));
}
{
  // the job card choices for an advance: this customer's, not invoiced, not Cancelled
  const { cap } = paymentsPage('?advanceFor=JOB-0003', (c) => {
    c.Storage.addData('jobCards', { customerId: 'CUS-0003', vehicleId: 'VEH-0003', status: 'Cancelled', total: 100, paid: 0, due: 100, services: [], partsUsed: [] });
  });
  const body = cap.opened.find((o) => o.opts.title === 'Record Payment').opts.body;
  const jobOptions = (body.match(/<select class="select" id="pf-jobcard"[\s\S]*?<\/select>/) || [''])[0];
  ok('the job card list offers only un-invoiced, open job cards', /JOB-0003/.test(jobOptions) && !/Cancelled\)/.test(jobOptions), jobOptions);
}

/* ---------------------------------------------------------- */
console.log('\n-- 4. Job Card details and form --');
function jobCardsPage(search, setup) {
  const page = boot({ modules: ['js/job-cards.js'] });
  page.ctx.Storage.seedIfEmpty();
  if (setup) setup(page.ctx);
  page.ctx.location.search = search;
  stubQueries(page.ctx);
  const cap = captureModal(page.ctx);
  page.fireReady();
  return { ...page, cap };
}
{
  const { cap } = jobCardsPage('?view=JOB-0003', (c) => c.Storage.updateData('jobCards', 'JOB-0003', { status: 'Completed', paid: 0, due: 5775 }));
  const m = cap.opened.find((o) => /Job Card JOB-0003/.test(o.opts.title));
  ok('the details dialog opens', !!m, cap.opened.map((o) => o.opts.title).join(' | '));
  ok('   ...offers Record Advance for this job card', m && /href="payments\.html\?advanceFor=JOB-0003">Record Advance</.test(m.opts.footer), m && m.opts.footer);
  ok('   ...lists the advance, not yet applied', m && /PAY-0004[\s\S]*2,000[\s\S]*Advance, not yet applied/.test(m.opts.body));
  ok('   ...and its summary shows the ledger: Paid 2,000, Due 3,775',
    m && /<span>Paid<\/span><strong>[^<]*2,000<\/strong>/.test(m.opts.body) && /<span>Due<\/span><strong>[^<]*3,775<\/strong>/.test(m.opts.body));
}
{
  const { cap } = jobCardsPage('?view=JOB-0002');
  const m = cap.opened.find((o) => /Job Card JOB-0002/.test(o.opts.title));
  ok('an invoiced job card offers no Record Advance', m && !/Record Advance/.test(m.opts.footer), m && m.opts.footer);
  ok('   ...and shows its payment as applied to the invoice', m && /PAY-0002[\s\S]*On invoice INV-0002/.test(m.opts.body));
}
{
  const { cap, ctx } = jobCardsPage('?view=JOB-0004');
  const m = cap.opened.find((o) => /Job Card JOB-0004/.test(o.opts.title));
  ok('an open job card with no advance offers Record Advance', m && /advanceFor=JOB-0004/.test(m.opts.footer));
  ok('   ...and lists no advances', m && !/jcv-advances/.test(m.opts.body));
  // the edit form
  // The stub dialog has no real form, so wiring its events throws -- after
  // Modal.open has captured the body, which is all this checks.
  const openEdit = () => { try { (ctx.document.querySelector('[data-edit-from-view]')._on.click || []).forEach((cb) => cb({})); } catch { /* see above */ } };
  openEdit();
  const edit = cap.opened.find((o) => /Edit/.test(o.opts.title));
  ok('the edit form opens', !!edit, cap.opened.map((o) => o.opts.title).join(' | '));
  const body = edit ? edit.opts.body : '';
  ok('   ...has no typed Paid / Advance number input', !/id="jf-paid"[^>]*type="number"/.test(body), (body.match(/id="jf-paid"[^>]*>/) || [''])[0]);
  ok('   ...keeps the stored value as a hidden field', /<input id="jf-paid" name="paid" type="hidden" value="0">/.test(body), (body.match(/id="jf-paid"[^>]*>/) || [''])[0]);
  ok('   ...and points to Record Advance', /No advance recorded\. Use Record Advance/.test(body));
}
{
  const { cap, ctx } = jobCardsPage('?view=JOB-0004', (c) => c.Storage.updateData('jobCards', 'JOB-0004', { paid: 700, due: 1400 }));
  try { (ctx.document.querySelector('[data-edit-from-view]')._on.click || []).forEach((cb) => cb({})); } catch { /* stub form */ }
  const body = (cap.opened.find((o) => /Edit/.test(o.opts.title)) || { opts: { body: '' } }).opts.body;
  ok('a legacy typed figure is kept as is', /<input id="jf-paid" name="paid" type="hidden" value="700">/.test(body));
  ok('   ...and labelled as not a recorded payment', /700 was typed on this Job Card earlier\. It is not a recorded payment\./.test(body));
}

/* ---------------------------------------------------------- */
console.log('\n-- 5. Offline invoice create refuses advances over the total --');
{
  const page = boot({ modules: ['js/invoices.js'] });
  const { ctx } = page;
  ctx.Storage.seedIfEmpty();
  ctx.Storage.updateData('jobCards', 'JOB-0003', { status: 'Completed' });
  ctx.Storage.addData('payments', { invoiceId: null, customerId: 'CUS-0003', jobCardId: 'JOB-0003', date: ctx.Utils.todayStr(), amount: 4000, method: 'Cash', notes: '', status: 'Active' });
  ctx.location.search = '?fromJobCard=JOB-0003';
  stubQueries(ctx);
  const cap = captureModal(ctx);
  const invoicesBefore = ctx.Storage.getData('invoices').length;
  page.fireReady();
  const all = cap.opened.map((o) => `${o.opts.title} ${o.opts.body}`).join(' | ') + ' ' + cap.toasts.map(([m]) => m).join(' | ');
  ok('6,000 of advances on a 5,775 job card -> refused, saying so', /advances recorded on this Job Card \([^)]*6,000\) exceed the invoice total \([^)]*5,775\)/.test(all), all.slice(0, 400));
  ok('   ...no create dialog is offered', !cap.opened.some((o) => /Create Invoice — JOB-0003/.test(o.opts.title)));
  check('   ...and nothing was created', ctx.Storage.getData('invoices').length, invoicesBefore);
}
{
  const page = boot({ modules: ['js/invoices.js'] });
  const { ctx } = page;
  ctx.Storage.seedIfEmpty();
  ctx.Storage.updateData('jobCards', 'JOB-0003', { status: 'Completed' });
  ctx.Storage.addData('payments', { invoiceId: null, customerId: 'CUS-0001', jobCardId: 'JOB-0003', date: ctx.Utils.todayStr(), amount: 10, method: 'Cash', notes: '', status: 'Active' });
  ctx.location.search = '?fromJobCard=JOB-0003';
  stubQueries(ctx);
  const cap = captureModal(ctx);
  page.fireReady();
  const all = cap.opened.map((o) => `${o.opts.title} ${o.opts.body}`).join(' | ') + ' ' + cap.toasts.map(([m]) => m).join(' | ');
  ok('an advance of another customer on the job card -> refused', /belongs to a different customer/.test(all), all.slice(0, 400));
}

/* ---------------------------------------------------------- */
console.log('\n-- 6. A job card holding money keeps its customer, offline too (M1) --');
// The real edit dialog's save path, driven through a form stub shaped like
// job-card-server-owned.test.cjs's: fields read by name off #jobForm, one
// service line, and every other control a memoised spare (so the error the
// dialog writes into [data-err="customerId"] can be read back).
const FORM_FIELDS = ['customerId', 'vehicleId', 'mechanicId', 'priority', 'date', 'estDelivery',
  'mileage', 'mileageOut', 'fuelLevel', 'conditionNotes', 'complaint', 'inspection', 'diagnosis',
  'technicianNotes', 'recommendations', 'notes', 'labourHours', 'labourRate', 'labourCost',
  'discount', 'taxRate', 'paid', 'appointmentId'];
function editOverlay(values, cap) {
  const fieldOf = (v) => ({ value: String(v ?? ''), innerHTML: '', hidden: false, addEventListener() {} });
  const form = { querySelector: () => null, querySelectorAll: () => [], dataset: {} };
  FORM_FIELDS.forEach((n) => { form[n] = fieldOf(values[n]); });
  const spares = new Map();
  const spare = (sel) => {
    if (!spares.has(sel)) {
      spares.set(sel, { value: '', innerHTML: '', hidden: false, textContent: '', addEventListener() {},
        classList: { add() {}, remove() {} }, closest: () => ({ classList: { add() {}, remove() {} } }) });
    }
    return spares.get(sel);
  };
  const serviceRow = { querySelector(sel) {
    if (sel === '.line-service') return { value: 'SRV-0001', selectedOptions: [{ dataset: { name: 'Engine Oil Change' }, textContent: 'Engine Oil Change' }] };
    if (sel === '.line-qty') return { value: '1' };
    if (sel === '.line-price') return { value: String(values.linePrice ?? 500) };
    return null;
  } };
  cap.err = () => spare('[data-err="customerId"]').textContent;
  return {
    querySelector(sel) {
      if (sel === '[data-save]') return { addEventListener: (_e, cb) => { cap.save = cb; } };
      if (sel === '#jobForm') return form;
      if (sel === '#jf-source') return null;
      return spare(sel);
    },
    querySelectorAll(sel) { return sel === '[data-line="service"]' ? [serviceRow] : []; },
  };
}
function formFrom(job, over = {}) {
  return { customerId: job.customerId, vehicleId: job.vehicleId, mechanicId: job.mechanicId || 'MEC-0001',
    priority: job.priority || 'normal', date: job.date, estDelivery: '', mileage: '', mileageOut: '',
    fuelLevel: '', conditionNotes: '', complaint: job.complaint || 'x', inspection: '', diagnosis: '',
    technicianNotes: '', recommendations: '', notes: job.notes || '', labourHours: '', labourRate: '',
    labourCost: '0', discount: '0', taxRate: '0', paid: String(job.paid ?? 0), appointmentId: '',
    // one line carrying the job's own total, so its stored Paid/Advance still fits
    linePrice: Math.max(Number(job.total) || 0, 500), ...over };
}
/** Open the real Edit dialog for `jobId` with `over` typed into it, and press Save. */
async function editAndSave(page, jobId, over) {
  const { ctx, els } = page;
  const cap = {};
  const job = ctx.Storage.getById('jobCards', jobId);
  ctx.Utils.Modal.open = () => editOverlay(formFrom(job, over), cap);
  ctx.Utils.Modal.close = () => {};
  const btn = { dataset: { action: 'edit' }, closest: (sel) => (sel === 'tr' ? { dataset: { id: jobId } } : btn) };
  els.get('jobTableBody').dispatch('click', { target: { closest: (sel) => (sel === '[data-action]' ? btn : null) } });
  if (cap.save) await cap.save({});
  return cap;
}
function offlinePage(setup) {
  const page = boot({ modules: ['js/job-cards.js'] });
  page.ctx.Storage.seedIfEmpty();
  // Inspection: an editable status that does not reconcile stock, so the
  // save under test is only the job card write.
  ['JOB-0003', 'JOB-0004'].forEach((id) => page.ctx.Storage.updateData('jobCards', id, { status: 'Inspection' }));
  if (setup) setup(page.ctx);
  stubQueries(page.ctx);
  page.fireReady();
  return page;
}
async function section6() {
{
  const page = offlinePage();
  const S = page.ctx.Storage;
  ok('offline: the backend is not in use', !S.isApi());
  const cap = await editAndSave(page, 'JOB-0003', { customerId: 'CUS-0004', vehicleId: 'VEH-0004', notes: 'moved' });
  ok('changing the customer of a job card with an Active advance is refused offline',
    /PAY-0004/.test(cap.err()) && /customer cannot be changed/.test(cap.err()), cap.err());
  check('   ...the job card keeps its customer, vehicle and notes',
    [S.getById('jobCards', 'JOB-0003').customerId, S.getById('jobCards', 'JOB-0003').vehicleId, S.getById('jobCards', 'JOB-0003').notes === 'moved'],
    ['CUS-0003', 'VEH-0003', false]);
  check('   ...the advance still counts for CUS-0003 only',
    [page.ctx.Utils.sumJobsPaid(S.getData('jobCards').filter((j) => j.customerId === 'CUS-0004')),
     page.ctx.Utils.liveJobBalance(S.getById('jobCards', 'JOB-0003')).paid], [0, 2000]);

  const keep = await editAndSave(page, 'JOB-0003', { notes: 'same customer, new note' });
  check('an edit that keeps the customer still saves', [keep.err(), S.getById('jobCards', 'JOB-0003').notes], ['', 'same customer, new note']);

  const free = await editAndSave(page, 'JOB-0004', { customerId: 'CUS-0003', vehicleId: 'VEH-0003' });
  check('a job card with no payment can still change customer offline', [free.err(), S.getById('jobCards', 'JOB-0004').customerId], ['', 'CUS-0003']);
}
{
  const page = offlinePage((c) => c.Storage.updateData('payments', 'PAY-0004', { status: 'Void' }));
  const cap = await editAndSave(page, 'JOB-0003', { customerId: 'CUS-0004', vehicleId: 'VEH-0004' });
  check('only a Void payment on the job card -> the change is allowed offline',
    [cap.err(), page.ctx.Storage.getById('jobCards', 'JOB-0003').customerId], ['', 'CUS-0004']);
}
{
  // With the backend the same check runs before the request, so the server's
  // refusal is shown under the customer field instead of after a round trip.
  const { fakeApi } = require('../lib/fake-api.cjs');
  const job = { id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001',
    appointmentId: null, priority: 'normal', date: '2026-09-22', estDelivery: '', mileage: null, mileageOut: null,
    fuelLevel: '', conditionNotes: '', complaint: 'x', inspection: '', diagnosis: '', technicianNotes: '',
    recommendations: '', notes: '', services: [], partsUsed: [], inspectionChecklist: {}, labourHours: null,
    labourRate: null, labourCost: 0, discount: 0, taxRate: 0, subtotal: 500, tax: 0, total: 500, paid: 0, due: 500,
    status: 'Inspection', invoiceId: null, completedAt: null, actualDelivery: '' };
  const rows = {
    customers: [{ id: 'CUS-0001', name: 'A', phone: '1', status: 'Active' }, { id: 'CUS-0002', name: 'B', phone: '2', status: 'Active' }],
    vehicles: [{ id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'R1', brand: 'B', model: 'M', status: 'Active' },
               { id: 'VEH-0002', customerId: 'CUS-0002', regNo: 'R2', brand: 'B', model: 'M', status: 'Active' }],
    services: [{ id: 'SRV-0001', name: 'Engine Oil Change', price: 500, status: 'Active' }],
    mechanics: [{ id: 'MEC-0001', name: 'M', specialization: 'Engine', status: 'Active', availability: 'Available' }],
    parts: [], appointments: [], 'job-cards': [job],
    payments: [{ id: 'PAY-0001', invoiceId: null, customerId: 'CUS-0001', jobCardId: 'JOB-0001', date: '2026-09-22', amount: 200, method: 'Cash', status: 'Active' }],
  };
  for (const [label, payStatus, expectPut] of [['an Active advance', 'Active', 0], ['only a Void payment', 'Void', 1]]) {
    const r = JSON.parse(JSON.stringify(rows)); r.payments[0].status = payStatus;
    const f = fakeApi({ rows: r });
    const page = boot({ modules: ['js/job-cards.js'], origin: 'http://localhost:8787', fetch: f });
    await page.ctx.Storage.hydrate();
    stubQueries(page.ctx);
    page.fireReady();
    const cap = await editAndSave(page, 'JOB-0001', { customerId: 'CUS-0002', vehicleId: 'VEH-0002' });
    const puts = f.calls.filter((c) => c.method === 'PUT' && /^\/job-cards\//.test(c.path)).length;
    check(`API mode, ${label}: PUT requests sent`, puts, expectPut);
    if (!expectPut) ok('   ...and the refusal is shown under the customer field', /PAY-0001/.test(cap.err()), cap.err());
  }
}

}

section6().then(() => process.exit(summary('Job Card Advance UI') === 0 ? 0 : 1));
