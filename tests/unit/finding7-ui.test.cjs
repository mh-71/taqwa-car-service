/* Finding 7 UI — the void confirmation must name the payments being released.
   Drives the REAL invoices.js row action handler. */
process.env.TZ = 'Asia/Dhaka';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

function clickRowAction(els, tbodyId, action, rowId) {
  const btn = { dataset: { action }, closest: sel => sel === 'tr' ? { dataset: { id: rowId } } : btn };
  els.get(tbodyId).dispatch('click', { target: { closest: sel => sel === '[data-action]' ? btn : null } });
}
function captureModal(ctx) {
  const cap = { open: null, confirm: null };
  const realOpen = ctx.Utils.Modal.open;
  ctx.Utils.Modal.open = opts => { cap.open = opts; return { querySelector: () => ({ addEventListener() {} }) }; };
  ctx.Utils.Modal.confirm = opts => { cap.confirm = opts; };
  ctx.Utils.Modal.close = () => {};
  return cap;
}

console.log('=== Finding 7 UI: void confirmation ===\n');

/* ---- invoice WITH payments ---- */
{
  console.log('-- invoice with linked payments --');
  const { ctx, els, fireReady } = boot({ modules: ['js/invoices.js'] });
  ctx.Storage.seedIfEmpty();
  fireReady();
  const cap = captureModal(ctx);
  clickRowAction(els, 'invcTableBody', 'void', 'INV-0002');

  ok('a full modal (not the simple confirm) was opened', !!cap.open && !cap.confirm,
     `open=${!!cap.open} confirm=${!!cap.confirm}`);
  const body = cap.open ? cap.open.body : '';
  check('modal title', cap.open && cap.open.title, 'Void invoice?');
  ok('names the invoice being voided', body.includes('INV-0002'), body.slice(0, 200));
  ok('lists the payment ID', body.includes('PAY-0002'), 'PAY-0002 not listed');
  ok('lists the payment amount', body.includes(ctx.Utils.money(3000)), 'amount 3000 not shown');
  ok('shows the released total', body.includes(ctx.Utils.money(3000)), 'total not shown');
  ok('says they become Advance Payments', /Advance Payments/.test(body), 'advance wording missing');
  ok('says no money is written off', /No money is written off/.test(body), 'reassurance missing');
  ok('points at Link to Invoice', /Link to Invoice/.test(body), 'link-to-invoice guidance missing');
  ok('uses existing table components only (no new CSS classes)',
     /table table--compact/.test(body) && !/void-release-list/.test(body), 'unexpected markup');
  ok('confirm button is present', /data-confirm-void/.test(cap.open.footer), cap.open.footer);
}

/* ---- invoice with NO payments: simple confirm ---- */
{
  console.log('\n-- invoice with no linked payments --');
  const { ctx, els, fireReady } = boot({ modules: ['js/invoices.js'] });
  ctx.Storage.seedIfEmpty();
  // strip payments off INV-0001 so it has none linked
  ctx.Storage.getData('payments').filter(p => p.invoiceId === 'INV-0001')
    .forEach(p => ctx.Storage.updateData('payments', p.id, { invoiceId: null }));
  fireReady();
  const cap = captureModal(ctx);
  clickRowAction(els, 'invcTableBody', 'void', 'INV-0001');

  ok('the simple confirm dialog is used', !!cap.confirm && !cap.open,
     `open=${!!cap.open} confirm=${!!cap.confirm}`);
  const msg = cap.confirm ? cap.confirm.message : '';
  ok('still names the invoice', msg.includes('INV-0001'), msg.slice(0, 160));
  ok('no payment list in the simple path', !/Advance Payments/.test(msg), msg.slice(0, 200));
  check('confirm button label', cap.confirm && cap.confirm.confirmText, 'Void Invoice');
}

process.exit(summary('Finding 7 UI') === 0 ? 0 : 1);
