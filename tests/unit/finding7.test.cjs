/* Finding 7 — voiding an invoice releases its payments as advances.
   Runs the REAL shipped invoices.js / payments.js / reports.js logic. */
process.env.TZ = 'Asia/Dhaka';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const R = { from: '2000-01-01', to: '2099-12-31' };

function api(ctx) {
  const inv = fs.readFileSync(`${ROOT}/js/invoices.js`, 'utf8');
  const pay = fs.readFileSync(`${ROOT}/js/payments.js`, 'utf8');
  const rep = fs.readFileSync(`${ROOT}/js/reports.js`, 'utf8');
  const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b);
    if (i < 0 || j <= i) throw new Error(`slice failed: ${a}`); return s.slice(i, j); };
  const sb = { Storage: ctx.Storage, Utils: ctx.Utils, money: ctx.Utils.money, esc: ctx.Utils.esc,
    fmtDate: ctx.Utils.fmtDate, badge: ctx.Utils.badge,
    METHODS: ['Cash','Card','Mobile Banking','Bank Transfer'],
    ELIGIBLE_JOB_STATUSES: ['Completed','Delivered'],
    Date, Math, JSON, Number, String, Object, Array, Map, Set, console, api: {} };
  vm.createContext(sb);
  vm.runInContext(
    cut(inv, 'function deriveStatus', '/* ---------- summary cards') + '\n' +
    cut(pay, 'function deriveInvoiceStatus', '/* ---------- summary cards') + '\n' +
    cut(rep, 'function parseLocalDate', 'function statCardsHtml') + `
    api.createInvoiceFromJobCard = createInvoiceFromJobCard; api.voidInvoice = voidInvoice;
    api.linkedActivePayments = linkedActivePayments;
    api.recordPayment = recordPayment; api.voidPayment = voidPayment;
    api.linkPaymentToInvoice = linkPaymentToInvoice; api.payableInvoicesFor = payableInvoicesFor;
    api.computeRevenueReport = computeRevenueReport; api.computeInvoiceReport = computeInvoiceReport;
    api.computeMechanicReport = computeMechanicReport; api.buildLookups = buildLookups;
  `, sb);
  return sb.api;
}

const state = (ctx, a) => ({
  revenue: a.computeRevenueReport(R).total,
  invoiceCollected: a.computeInvoiceReport(R).totalCollected,
  invoiceDue: a.computeInvoiceReport(R).totalDue,
  advances: ctx.Storage.getData('payments').filter(p => p.status !== 'Void' && !p.invoiceId)
    .reduce((s, p) => s + p.amount, 0),
  unattributed: a.computeMechanicReport(R, a.buildLookups()).unattributed,
  jobDue: ctx.Utils.liveJobDue(ctx.Storage.getById('jobCards', 'JOB-0002')),
});
const balanced = st => st.invoiceCollected + st.advances === st.revenue;

/** seed + settle INV-0002 in full; returns ctx, api, and the two linked payments */
function settled() {
  const { ctx } = boot({}); ctx.Storage.seedIfEmpty(); const a = api(ctx);
  a.recordPayment({ invoiceId:'INV-0002', customerId:'CUS-0002', jobCardId:null,
    date: ctx.Utils.todayStr(), amount:1935, method:'Cash', notes:'' });
  const linked = a.linkedActivePayments('INV-0002').map(p => p.id);
  return { ctx, a, linked };
}

console.log('=== Finding 7: voiding an invoice releases its payments as advances ===\n');

/* ---------- 1. payments become advances, money preserved ---------- */
{
  console.log('-- 1. Void invoice with payments -> payments become advances --');
  const { ctx, a, linked } = settled();
  const before = state(ctx, a);
  check('baseline is balanced', balanced(before), true);
  check('two payments linked to INV-0002', linked.length, 2);

  const res = a.voidInvoice('INV-0002');
  ok('void succeeded', res.ok, JSON.stringify(res));
  check('void reports the released payments', res.released.map(p => p.id), linked);

  const after = state(ctx, a);
  check('invoice is Void', ctx.Storage.getById('invoices','INV-0002').status, 'Void');
  check('released payments are no longer linked',
    linked.map(id => ctx.Storage.getById('payments', id).invoiceId), [null, null]);
  check('released payments stay Active',
    linked.map(id => ctx.Storage.getById('payments', id).status), ['Active','Active']);
  check('nothing is still linked to the void invoice', a.linkedActivePayments('INV-0002').length, 0);

  // 2. revenue unchanged
  check('revenue unchanged by voiding', after.revenue, before.revenue);
  // 3. advances rose by exactly the released amount
  check('outstanding advances rose by the released total', after.advances - before.advances, 4935);
  // 4. jobCardId carried from the invoice
  check('jobCardId carried onto released payments',
    linked.map(id => ctx.Storage.getById('payments', id).jobCardId), ['JOB-0002','JOB-0002']);
  // 5. mechanic attribution intact
  check('mechanic unattributed collections stay 0', after.unattributed, 0);
  // invariant
  check('accounting invariant still balances after void', balanced(after), true);

  // amounts/dates/methods untouched
  const p0 = ctx.Storage.getById('payments', linked[0]);
  check('payment amount/method preserved', [p0.amount, p0.method], [3000, 'Mobile Banking']);
  // invoice keeps its frozen history
  const voided = ctx.Storage.getById('invoices','INV-0002');
  check('void invoice keeps frozen paid/due as history', [voided.paid, voided.due], [4935, 0]);
  check('void invoice reports 0 live collected (not its frozen paid)',
    a.computeInvoiceReport(R).rows.find(r => r.id === 'INV-0002').livePaid, 0);
}

/* ---------- 6. advance filter + Link to Invoice availability ---------- */
{
  console.log('\n-- 6. Released payments show as Advances and offer Link to Invoice --');
  const { ctx, a, linked } = settled();
  a.voidInvoice('INV-0002');
  const { ctx: c2, els, fireReady } = boot({ modules: ['js/payments.js'] });
  // replay the same state into a context that has the real payments page
  ['payments','invoices','jobCards'].forEach(col =>
    c2.Storage.saveData(col, ctx.Storage.getData(col)));
  ['customers','vehicles','mechanics','services','parts','expenses','appointments','inventoryTransactions']
    .forEach(col => c2.Storage.saveData(col, ctx.Storage.getData(col)));
  fireReady();

  const typeSel = els.get('payType'); typeSel.value = 'advance';
  typeSel.dispatch('change', { target: typeSel });
  const rows = [...els.get('payTableBody').innerHTML.matchAll(/<tr data-id="([^"]+)">/g)].map(m => m[1]);
  linked.forEach(id => ok(`${id} listed under the Advance filter`, rows.includes(id), rows.join(',')));

  const html = els.get('payTableBody').innerHTML;
  check('released payments render the Advance badge',
    (html.match(/badge--warn">Advance/g) || []).length >= 2, true);

  const stats = els.get('payStats').innerHTML;
  ok('Outstanding Advances stat shows the released money',
    stats.includes(c2.Utils.money(6935)), 'stat not found in payStats');
}

/* ---------- 7. replacement invoice consumes the advances; round trip ---------- */
{
  console.log('\n-- 7. Replacement invoice consumes the advances (full round trip) --');
  const { ctx, a, linked } = settled();
  const baseline = state(ctx, a);
  a.voidInvoice('INV-0002');

  const res = a.createInvoiceFromJobCard('JOB-0002', {});
  ok('replacement invoice created from the same Job Card', res.ok, JSON.stringify(res));
  const newId = res.invoice.id;
  check('Job Card relinked to the replacement', ctx.Storage.getById('jobCards','JOB-0002').invoiceId, newId);

  const payable = a.payableInvoicesFor('CUS-0002').map(i => i.id);
  ok('replacement invoice is offered as payable', payable.includes(newId), payable.join(','));

  linked.forEach(id => {
    const r = a.linkPaymentToInvoice(id, newId);
    ok(`advance ${id} links to ${newId}`, r.ok, JSON.stringify(r));
  });

  const after = state(ctx, a);
  check('replacement invoice fully settled',
    [ctx.Storage.getById('invoices', newId).paid, ctx.Storage.getById('invoices', newId).due,
     ctx.Storage.getById('invoices', newId).status], [4935, 0, 'Paid']);
  check('round trip returns revenue to baseline', after.revenue, baseline.revenue);
  check('round trip returns advances to baseline', after.advances, baseline.advances);
  check('round trip returns invoice collected to baseline', after.invoiceCollected, baseline.invoiceCollected);
  check('round trip returns Job Card live due to 0', after.jobDue, 0);
  check('round trip stays balanced', balanced(after), true);
  check('mechanic attribution intact after round trip', after.unattributed, 0);
}

/* ---------- 8. guards ---------- */
{
  console.log('\n-- 8. Guards: no double-linking, no overpay, no void linking, no orphans --');
  const { ctx, a, linked } = settled();
  a.voidInvoice('INV-0002');
  const newId = a.createInvoiceFromJobCard('JOB-0002', {}).invoice.id;

  // link to a Void invoice
  const toVoid = a.linkPaymentToInvoice(linked[0], 'INV-0002');
  ok('cannot link an advance to a Void invoice', !toVoid.ok && /void/i.test(toVoid.reason), JSON.stringify(toVoid));

  // link once, then again
  ok('first link succeeds', a.linkPaymentToInvoice(linked[0], newId).ok);
  const twice = a.linkPaymentToInvoice(linked[0], newId);
  ok('cannot double-link the same payment', !twice.ok && /already linked/i.test(twice.reason), JSON.stringify(twice));

  // overpay: second advance is 1935, remaining due is 1935 -> fits; a third would not
  ok('second advance links within the balance', a.linkPaymentToInvoice(linked[1], newId).ok);
  const extra = a.recordPayment({ invoiceId: null, customerId:'CUS-0002', jobCardId:null,
    date: ctx.Utils.todayStr(), amount: 500, method:'Cash', notes:'spare advance' });
  const over = a.linkPaymentToInvoice(extra.payment.id, newId);
  ok('cannot overpay by linking another advance', !over.ok && /overpay/i.test(over.reason), JSON.stringify(over));

  // void payment cannot be linked
  const v = a.recordPayment({ invoiceId: null, customerId:'CUS-0002', jobCardId:null,
    date: ctx.Utils.todayStr(), amount: 100, method:'Cash', notes:'' });
  a.voidPayment(v.payment.id);
  const voidLink = a.linkPaymentToInvoice(v.payment.id, newId);
  ok('cannot link a voided payment', !voidLink.ok && /voided/i.test(voidLink.reason), JSON.stringify(voidLink));

  // void invoice cannot receive new payments
  const toVoidInv = a.recordPayment({ invoiceId:'INV-0002', customerId:'CUS-0002', jobCardId:null,
    date: ctx.Utils.todayStr(), amount: 100, method:'Cash', notes:'' });
  ok('Void invoice cannot receive a new payment',
    !toVoidInv.ok && /void/i.test(toVoidInv.reason), JSON.stringify(toVoidInv));

  // no orphans: every non-void payment is either an advance or linked to a live invoice
  const orphans = ctx.Storage.getData('payments').filter(p => {
    if (p.status === 'Void' || !p.invoiceId) return false;
    const i = ctx.Storage.getById('invoices', p.invoiceId);
    return !i || i.status === 'Void';
  });
  check('no payment is left attached to a Void or missing invoice', orphans.map(p => p.id), []);
}

/* ---------- 9. void invoice with payments is still undeletable ---------- */
{
  console.log('\n-- 9. Historical record protection --');
  const { ctx, a } = settled();
  a.voidInvoice('INV-0002');
  const inv = ctx.Storage.getById('invoices','INV-0002');
  ok('void invoice still exists', !!inv);
  ok('delete guard still trips (frozen paid > 0 preserved)', Number(inv.paid) > 0, `paid=${inv.paid}`);
  check('invoice still carries its jobCardId for history', inv.jobCardId, 'JOB-0002');
}

/* ---------- 10. simple void (no payments) is unchanged ---------- */
{
  console.log('\n-- 10. Voiding an invoice with no payments --');
  const { ctx } = boot({}); ctx.Storage.seedIfEmpty(); const a = api(ctx);
  // JOB-0004 has no invoice; make one with zero paid
  ctx.Storage.updateData('jobCards','JOB-0004',{ status:'Completed', paid:0, due:2100 });
  const created = a.createInvoiceFromJobCard('JOB-0004', {});
  ok('invoice created with no payments', created.ok, JSON.stringify(created));
  const before = state(ctx, a);
  const res = a.voidInvoice(created.invoice.id);
  ok('void succeeded', res.ok);
  check('nothing was released', res.released.length, 0);
  const after = state(ctx, a);
  check('revenue unchanged', after.revenue, before.revenue);
  check('advances unchanged', after.advances, before.advances);
  check('still balanced', balanced(after), true);
}

process.exit(summary('Finding 7') === 0 ? 0 : 1);
