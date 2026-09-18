/* Finding 1 — live outstanding balances.
   Drives the REAL shipped financial logic: invoices.js createInvoiceFromJobCard/
   voidInvoice and payments.js recordPayment/voidPayment are executed from their
   own source text, and the balances are read back out of the REAL rendered
   output of dashboard.js / customers.js / vehicles.js. Nothing is reimplemented. */
process.env.TZ = 'Asia/Dhaka';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

/* ---- pull the shipped money logic out of its IIFE and run that exact text ---- */
function financeApi(ctx) {
  const inv = fs.readFileSync(`${ROOT}/js/invoices.js`, 'utf8');
  const pay = fs.readFileSync(`${ROOT}/js/payments.js`, 'utf8');
  const slice = (src, from, to, label) => {
    const a = src.indexOf(from), b = src.indexOf(to);
    if (a < 0 || b < a) throw new Error(`could not slice ${label} (${a},${b})`);
    return src.slice(a, b);
  };
  const sandbox = {
    Storage: ctx.Storage, Utils: ctx.Utils, money: ctx.Utils.money, esc: ctx.Utils.esc,
    METHODS: ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'],
    ELIGIBLE_JOB_STATUSES: ['Completed', 'Delivered'],
    Date, Math, JSON, Number, String, Object, Array, console, api: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    slice(inv, 'function deriveStatus', '/* ---------- summary cards', 'invoices') + '\n' +
    slice(pay, 'function deriveInvoiceStatus', '/* ---------- eligible invoices', 'payments') + `
    api.createInvoiceFromJobCard = createInvoiceFromJobCard;
    api.voidInvoice = voidInvoice;
    api.recordPayment = recordPayment;
    api.voidPayment = voidPayment;
    api.outstandingBalance = outstandingBalance;
  `, sandbox);
  return sandbox.api;
}

/* ---- read balances back out of the REAL page modules ---- */
const dashTotalDue = (ctx, els, fireReady) => {
  fireReady();
  const m = els.get('statsGrid').innerHTML
    .match(/<div class="stat__value">([^<]*)<\/div>\s*<div class="stat__label">Total Due<\/div>/);
  return m ? m[1].trim() : null;
};
const custRowTotalDue = (els, custId) => {
  const html = els.get('custTableBody').innerHTML;
  const row = html.split(`<tr data-id="${custId}">`)[1];
  if (!row) return null;
  const tds = [...row.split('</tr>')[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
  return tds[6] ? tds[6].replace(/<[^>]+>/g, '').trim() : null;   // 7th cell = Total Due
};
// capture what a detail modal renders, without a real DOM
function captureModal(ctx) {
  const stub = makeElement('x');
  const captured = {};
  ctx.Utils.Modal.open = ({ title, body }) => {
    captured.title = title; captured.body = body;
    return { querySelector: () => ({ addEventListener() {} }) };
  };
  ctx.Utils.Modal.close = () => {};
  return captured;
}
const tileValue = (html, label) => {
  const m = html.match(new RegExp(`<strong>([^<]*)</strong><span>${label}</span>`));
  return m ? m[1].trim() : null;
};

const money = n => `৳ ${n.toLocaleString('en-IN')}`;
const SEED_TOTAL_DUE = 0 + 1935 + 3775 + 2100 + 0;   // JOB-0001..0005

console.log('=== Finding 1: live outstanding balances ===\n');

/* ---------------- 1. Invoice partially paid ---------------- */
{
  console.log('-- 1. Invoice partially paid -> correct Due --');
  const { ctx } = boot({});
  ctx.Storage.seedIfEmpty();
  const api = financeApi(ctx);

  const before = ctx.Utils.liveJobDue(ctx.Storage.getById('jobCards', 'JOB-0002'));
  check('JOB-0002 live due before payment', before, 1935);

  const r = api.recordPayment({ invoiceId: 'INV-0002', customerId: 'CUS-0002', jobCardId: null,
    date: ctx.Utils.todayStr(), amount: 935, method: 'Cash', notes: 'partial' });
  ok('partial payment accepted', r.ok, JSON.stringify(r));

  const invoice = ctx.Storage.getById('invoices', 'INV-0002');
  check('INV-0002 paid after partial', invoice.paid, 3935);
  check('INV-0002 due after partial', invoice.due, 1000);
  check('INV-0002 status after partial', invoice.status, 'Partial');
  check('JOB-0002 live due after partial', ctx.Utils.liveJobDue(ctx.Storage.getById('jobCards', 'JOB-0002')), 1000);
  check('JOB-0002 live paid after partial', ctx.Utils.liveJobPaid(ctx.Storage.getById('jobCards', 'JOB-0002')), 3935);

  const job = ctx.Storage.getById('jobCards', 'JOB-0002');
  check('Job Card snapshot paid untouched', job.paid, 3000);
  check('Job Card snapshot due untouched', job.due, 1935);
}

/* ---------------- 2-5. Full payment, seen from every surface ---------------- */
{
  console.log('\n-- 2/3/4/5. Invoice fully paid -> Due 0 on Dashboard, Customer and Vehicle --');
  const { ctx, els, fireReady } = boot({ modules: ['js/dashboard.js'] });
  ctx.Storage.seedIfEmpty();
  const api = financeApi(ctx);
  check('Dashboard Total Due at seed', dashTotalDue(ctx, els, fireReady), money(SEED_TOTAL_DUE));

  const r = api.recordPayment({ invoiceId: 'INV-0002', customerId: 'CUS-0002', jobCardId: null,
    date: ctx.Utils.todayStr(), amount: 1935, method: 'Cash', notes: 'settle in full' });
  ok('full settlement accepted', r.ok, JSON.stringify(r));

  const invoice = ctx.Storage.getById('invoices', 'INV-0002');
  check('INV-0002 fully paid', [invoice.paid, invoice.due, invoice.status], [4935, 0, 'Paid']);
  check('JOB-0002 live due is 0', ctx.Utils.liveJobDue(ctx.Storage.getById('jobCards', 'JOB-0002')), 0);

  // 5. Dashboard
  const { ctx: c2, els: e2, fireReady: f2 } = boot({ modules: ['js/dashboard.js'] });
  c2.Storage.seedIfEmpty();
  financeApi(c2).recordPayment({ invoiceId: 'INV-0002', customerId: 'CUS-0002', jobCardId: null,
    date: c2.Utils.todayStr(), amount: 1935, method: 'Cash', notes: '' });
  check('Dashboard Total Due drops by the settled 1935',
    dashTotalDue(c2, e2, f2), money(SEED_TOTAL_DUE - 1935));

  // 3. Customer list + detail
  const { ctx: c3, els: e3, fireReady: f3 } = boot({ modules: ['js/customers.js'] });
  c3.Storage.seedIfEmpty();
  const api3 = financeApi(c3);
  f3();
  check('Customer CUS-0002 Total Due column before payment', custRowTotalDue(e3, 'CUS-0002'), money(1935));
  api3.recordPayment({ invoiceId: 'INV-0002', customerId: 'CUS-0002', jobCardId: null,
    date: c3.Utils.todayStr(), amount: 1935, method: 'Cash', notes: '' });
  f3();
  check('Customer CUS-0002 Total Due column after full payment', custRowTotalDue(e3, 'CUS-0002'), money(0));

  const cap3 = captureModal(c3);
  c3.location.search = '?view=CUS-0002';
  f3();
  check('Customer detail tile Total Due', tileValue(cap3.body, 'Total Due'), money(0));
  check('Customer detail tile Total Paid', tileValue(cap3.body, 'Total Paid'), money(4935));

  // "With due" filter must no longer list a settled customer
  const { ctx: c3b, els: e3b, fireReady: f3b } = boot({ modules: ['js/customers.js'] });
  c3b.Storage.seedIfEmpty();
  financeApi(c3b).recordPayment({ invoiceId: 'INV-0002', customerId: 'CUS-0002', jobCardId: null,
    date: c3b.Utils.todayStr(), amount: 1935, method: 'Cash', notes: '' });
  f3b();
  const filterEl = e3b.get('custFilter'); filterEl.value = 'with-due';
  // re-render through the module's own change handler is not reachable here;
  // assert the underlying figure the filter reads instead
  check('CUS-0002 live due feeding the "With due" filter',
    c3b.Utils.sumJobsDue(c3b.Storage.getData('jobCards').filter(j => j.customerId === 'CUS-0002')), 0);

  // 4. Vehicle detail
  const { ctx: c4, els: e4, fireReady: f4 } = boot({ modules: ['js/vehicles.js'] });
  c4.Storage.seedIfEmpty();
  financeApi(c4).recordPayment({ invoiceId: 'INV-0002', customerId: 'CUS-0002', jobCardId: null,
    date: c4.Utils.todayStr(), amount: 1935, method: 'Cash', notes: '' });
  const cap4 = captureModal(c4);
  c4.location.search = '?view=VEH-0002';
  f4();
  check('Vehicle detail tile Total Due', tileValue(cap4.body, 'Total Due'), money(0));
  check('Vehicle detail tile Total Paid', tileValue(cap4.body, 'Total Paid'), money(4935));
}

/* ---------------- 6. Cancelled job contributes nothing ---------------- */
{
  console.log('\n-- 6. Cancelled Job Card does not count as outstanding --');
  const { ctx, els, fireReady } = boot({ modules: ['js/dashboard.js'] });
  ctx.Storage.seedIfEmpty();
  check('JOB-0004 due while open', ctx.Utils.liveJobDue(ctx.Storage.getById('jobCards', 'JOB-0004')), 2100);
  ctx.Storage.updateData('jobCards', 'JOB-0004', { status: 'Cancelled' });
  check('JOB-0004 due once Cancelled', ctx.Utils.liveJobDue(ctx.Storage.getById('jobCards', 'JOB-0004')), 0);
  check('Cancelled job keeps its snapshot due for history',
    ctx.Storage.getById('jobCards', 'JOB-0004').due, 2100);
  check('Dashboard Total Due excludes the cancelled job',
    dashTotalDue(ctx, els, fireReady), money(SEED_TOTAL_DUE - 2100));
}

/* ---------------- 7. Voided invoice ---------------- */
{
  console.log('\n-- 7. Void invoice does not remain outstanding on its own frozen figures --');
  const { ctx } = boot({});
  ctx.Storage.seedIfEmpty();
  const api = financeApi(ctx);

  // JOB-0002 / INV-0002: 4935 total, 1935 still due, then void the invoice
  const v = api.voidInvoice('INV-0002');
  ok('voidInvoice succeeded', v.ok, JSON.stringify(v));
  check('INV-0002 is Void', ctx.Storage.getById('invoices', 'INV-0002').status, 'Void');
  check('Void invoice keeps its frozen due for history', ctx.Storage.getById('invoices', 'INV-0002').due, 1935);
  check('voiding unlinks the Job Card', ctx.Storage.getById('jobCards', 'JOB-0002').invoiceId, null);
  check('job falls back to its pre-invoice snapshot, not the void invoice',
    ctx.Utils.liveJobDue(ctx.Storage.getById('jobCards', 'JOB-0002')), 1935);

  // defensive path: a job still pointing at a Void invoice must not use its figures
  ctx.Storage.updateData('jobCards', 'JOB-0002', { invoiceId: 'INV-0002' });
  check('stale link to a Void invoice is ignored (uses snapshot)',
    ctx.Utils.liveJobDue(ctx.Storage.getById('jobCards', 'JOB-0002')), 1935);
  check('stale link to a Void invoice ignored for paid too',
    ctx.Utils.liveJobPaid(ctx.Storage.getById('jobCards', 'JOB-0002')), 3000);

  // a fully-settled job whose invoice is then voided must not resurrect a debt
  const { ctx: c2 } = boot({});
  c2.Storage.seedIfEmpty();
  check('JOB-0005 settled, due 0', c2.Utils.liveJobDue(c2.Storage.getById('jobCards', 'JOB-0005')), 0);
  financeApi(c2).voidInvoice('INV-0003');
  check('JOB-0005 still 0 due after its invoice is voided',
    c2.Utils.liveJobDue(c2.Storage.getById('jobCards', 'JOB-0005')), 0);
}

/* ---------------- 8. Payment source-of-truth intact ---------------- */
{
  console.log('\n-- 8. Existing Payment source-of-truth behaviour is unchanged --');
  const { ctx } = boot({});
  ctx.Storage.seedIfEmpty();
  const api = financeApi(ctx);

  const over = api.recordPayment({ invoiceId: 'INV-0002', customerId: 'CUS-0002', jobCardId: null,
    date: ctx.Utils.todayStr(), amount: 99999, method: 'Cash', notes: '' });
  ok('overpayment still rejected', !over.ok && /overpay/i.test(over.reason), JSON.stringify(over));

  const wrongCust = api.recordPayment({ invoiceId: 'INV-0002', customerId: 'CUS-0001', jobCardId: null,
    date: ctx.Utils.todayStr(), amount: 100, method: 'Cash', notes: '' });
  ok('payment against another customer\'s invoice still rejected',
    !wrongCust.ok && /different customer/i.test(wrongCust.reason), JSON.stringify(wrongCust));

  const p = api.recordPayment({ invoiceId: 'INV-0002', customerId: 'CUS-0002', jobCardId: null,
    date: ctx.Utils.todayStr(), amount: 1935, method: 'Cash', notes: '' });
  ok('valid payment accepted', p.ok, JSON.stringify(p));
  check('invoice recomputed to Paid', ctx.Storage.getById('invoices', 'INV-0002').status, 'Paid');
  check('live due 0 after settlement', ctx.Utils.liveJobDue(ctx.Storage.getById('jobCards', 'JOB-0002')), 0);

  const vp = api.voidPayment(p.payment.id);
  ok('voiding the payment succeeded', vp.ok, JSON.stringify(vp));
  const inv = ctx.Storage.getById('invoices', 'INV-0002');
  check('invoice balance restored from non-Void payments only', [inv.paid, inv.due, inv.status], [3000, 1935, 'Partial']);
  check('live due follows the invoice back up',
    ctx.Utils.liveJobDue(ctx.Storage.getById('jobCards', 'JOB-0002')), 1935);

  const job = ctx.Storage.getById('jobCards', 'JOB-0002');
  check('Job Card snapshot never written throughout', [job.paid, job.due], [3000, 1935]);
  ok('no jobCards write path added for payments',
    !fs.readFileSync(`${ROOT}/js/payments.js`, 'utf8').includes("updateData('jobCards'"),
    'payments.js now writes to jobCards');
}

process.exit(summary('Finding 1') === 0 ? 0 : 1);
