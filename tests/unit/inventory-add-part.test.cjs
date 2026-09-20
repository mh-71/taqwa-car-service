/* inventory-add-part — what the Add Part form actually puts on the wire.

   The bug this guards against shipped to production and could not have been
   caught anywhere else in the suite. openAddModal() sent `stock: 0` with the
   part, the Worker refuses ANY `stock` in a parts body (routes/parts.js:118,
   the C-2 rule that a balance only moves through the ledger), and every
   create came back 422 "Some part fields are not valid."

   It survived because the server side was already tested from the SERVER's
   side -- api.test.mjs proves POST /api/parts carrying stock is refused, and
   write-crud.test.mjs proves stock is not writable in either direction --
   while nothing asserted what the BROWSER sends. In 'local' mode `stock: 0`
   is just another field in localStorage, so the defect was invisible until
   the app ran in 'api' mode.

   So these tests drive the REAL shipped js/inventory.js in API mode and
   assert the request body, not the outcome. fake-api deliberately does not
   re-implement the Worker's refusals (see its header), which is exactly why
   the assertion has to be "we never sent it" rather than "the server said
   no". */
process.env.TZ = 'Asia/Dhaka';
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

/* A form element readForm() can read: it only ever does form[name].value. */
function field(value) {
  return { value: String(value), _on: {}, addEventListener() {}, dispatch() {}, innerHTML: '' };
}
function fakeForm(values) {
  const f = { querySelectorAll: () => [], querySelector: () => null };
  Object.entries(values).forEach(([k, v]) => { f[k] = field(v); });
  return f;
}

/* Capture Modal.open and expose the save button's handler, the same way
   appointment-source.test.cjs drives its modals. Modal is destructured out of
   Utils at module load, so replacing the property reaches the module. */
function hookModal(ctx, values) {
  const cap = { saveHandler: null, opened: 0 };
  const form = fakeForm(values);
  ctx.Utils.Modal.open = () => {
    cap.opened += 1;
    return {
      querySelector: (sel) => {
        if (sel === '#partForm') return form;
        if (sel === '[data-save]') {
          return { addEventListener: (_e, cb) => { cap.saveHandler = cb; } };
        }
        return { addEventListener() {}, value: '', innerHTML: '' };
      },
      querySelectorAll: () => [],
    };
  };
  ctx.Utils.Modal.close = () => {};
  ctx.Utils.Modal.confirm = () => {};
  return cap;
}

/* The exact values from the production report that produced the 422. */
const FORM = {
  partNo: 'BP-01', name: 'Brake pade', category: 'Brakes', brand: 'Mk', unit: 'pc',
  location: 'Rack B-01', supplier: 'Mamun', status: 'Active',
  purchasePrice: '2200', sellingPrice: '2500',
  openingStock: '10', minStock: '05', reorderQty: '10',
  notes: 'Genuine brake pad',
};

async function page({ rows = { parts: [] }, values = {} } = {}) {
  const f = fakeApi({ rows });
  const h = boot({ modules: ['js/inventory.js'], origin: 'http://localhost:8787', fetch: f });
  await h.ctx.Storage.hydrate();
  h.ctx.Api.configure({ token: 'unit-token' });
  h.fireReady();
  return { ...h, f, values: { ...FORM, ...values } };
}

/* Open Add Part and run its save handler to completion. guard() swallows
   throws, so anything that goes wrong shows up as a missing request rather
   than a rejected promise -- which is why every test below asserts on calls. */
async function addPart(h) {
  const cap = hookModal(h.ctx, h.values);
  h.els.get('addPartBtn').dispatch('click', {});
  if (!cap.saveHandler) throw new Error('Add Part modal did not expose a save handler');
  await cap.saveHandler();
  return cap;
}

const sent = (f, method, re) => f.calls.filter((c) => c.method === method && re.test(c.path));
const partWrites = (f) => f.calls.filter(
  (c) => /^\/parts/.test(c.path) && (c.method === 'POST' || c.method === 'PUT')
);

console.log('=== inventory: Add Part wire contract ===\n');

(async () => {

/* ============================================================
   1. THE REGRESSION: no `stock` key may leave the browser
   ============================================================ */
console.log('-- 1. the create payload --');
{
  const h = await page();
  check('the app is talking to the backend', h.ctx.Storage.mode, 'api');
  await addPart(h);

  const posts = sent(h.f, 'POST', /^\/parts$/);
  check('Add Part sends exactly one POST /parts', posts.length, 1);
  const body = posts[0].body;

  ok('THE BODY CARRIES NO `stock` KEY -- the API refuses it, even as 0',
    !('stock' in body), JSON.stringify(body));
  ok('   ...and no `openingStock` either: that is a movement, not a column',
    !('openingStock' in body), JSON.stringify(body));

  check('   ...the part number is sent, upper-cased', body.partNo, 'BP-01');
  check('   ...the name is sent', body.name, 'Brake pade');
  check('   ...the category is sent', body.category, 'Brakes');
  check('   ...the unit is sent', body.unit, 'pc');
  check('   ...purchasePrice is a number', body.purchasePrice, 2200);
  check('   ...sellingPrice is a number', body.sellingPrice, 2500);
  check('   ...minStock "05" parses to 5', body.minStock, 5);
  check('   ...reorderQty is a number', body.reorderQty, 10);
  check('   ...status is sent', body.status, 'Active');
}

/* ============================================================
   2. Opening stock still becomes an initial-stock movement
   ============================================================ */
console.log('\n-- 2. opening stock is a ledger entry, not a field --');
{
  const h = await page();
  await addPart(h);

  const parts = sent(h.f, 'POST', /^\/parts$/);
  const moves = sent(h.f, 'POST', /^\/inventory-transactions$/);
  check('one part was created', parts.length, 1);
  check('   ...and one inventory transaction followed it', moves.length, 1);

  const created = parts[0];
  const txn = moves[0].body;
  check('the movement is an initial-stock entry', txn.type, 'initial-stock');
  check('   ...for the full opening quantity', txn.quantity, 10);
  check('   ...against the part the server just created',
    txn.partId, h.ctx.Storage.getData('parts')[0].id);
  check('   ...carrying the purchase price as unit cost', txn.unitCost, 2200);
  check('   ...with the Initial Stock reason', txn.reason, 'Initial Stock');
  check('   ...as a manual reference', txn.referenceType, 'manual');
  ok('the movement is ordered AFTER the part exists',
    h.f.calls.indexOf(created) < h.f.calls.indexOf(moves[0]), 'movement came first');
}

/* ============================================================
   3. Opening stock 0 writes no movement, and the part is at 0
   ============================================================ */
console.log('\n-- 3. opening stock 0 --');
{
  const h = await page({ values: { openingStock: '0' } });
  await addPart(h);

  check('the part is still created', sent(h.f, 'POST', /^\/parts$/).length, 1);
  check('   ...with no stock key', 'stock' in sent(h.f, 'POST', /^\/parts$/)[0].body, false);
  check('NO inventory transaction is written for an opening stock of 0',
    sent(h.f, 'POST', /^\/inventory-transactions$/).length, 0);

  const rec = h.ctx.Storage.getData('parts')[0];
  ok('the part exists in the app', !!rec, JSON.stringify(rec));
  check('   ...and its effective stock is 0', Number(rec.stock) || 0, 0);
  ok('   ...because the client never claimed a stock level',
    rec.stock === undefined || rec.stock === 0, JSON.stringify(rec));
}

/* ============================================================
   4. An empty opening stock field behaves as 0
   ============================================================ */
console.log('\n-- 4. opening stock left blank --');
{
  const h = await page({ values: { openingStock: '' } });
  await addPart(h);
  check('the part is created', sent(h.f, 'POST', /^\/parts$/).length, 1);
  check('   ...still with no stock key',
    'stock' in sent(h.f, 'POST', /^\/parts$/)[0].body, false);
  check('   ...and no movement, because blank means none',
    sent(h.f, 'POST', /^\/inventory-transactions$/).length, 0);
}

/* ============================================================
   5. Editing a part never sends stock either
   ============================================================ */
console.log('\n-- 5. the edit path --');
{
  const existing = {
    id: 'PRT-0001', name: 'Brake pad', partNo: 'BP-01', category: 'Brakes', brand: 'Mk',
    supplier: 'Mamun', location: 'Rack B-01', unit: 'pc', purchasePrice: 2200,
    sellingPrice: 2500, stock: 10, minStock: 5, reorderQty: 10, notes: '', status: 'Active',
  };
  const h = await page({ rows: { parts: [existing] } });
  const cap = hookModal(h.ctx, { ...FORM, name: 'Brake pad (front)' });

  const btn = { dataset: { action: 'edit' }, closest: (sel) => (sel === 'tr' ? { dataset: { id: 'PRT-0001' } } : btn) };
  h.els.get('invTableBody').dispatch('click', {
    target: { closest: (sel) => (sel === '[data-action]' ? btn : null) },
  });
  ok('the edit modal opened', cap.opened > 0, String(cap.opened));
  await cap.saveHandler();

  const puts = sent(h.f, 'PUT', /^\/parts\//);
  check('editing sends one PUT', puts.length, 1);
  ok('   ...and it carries no `stock` key either',
    !('stock' in puts[0].body), JSON.stringify(puts[0].body));
  ok('   ...nor `openingStock`', !('openingStock' in puts[0].body), JSON.stringify(puts[0].body));
  check('   ...and writes no movement', sent(h.f, 'POST', /^\/inventory-transactions$/).length, 0);
}

/* ============================================================
   6. The invariant, stated once over every part write made above
   ============================================================ */
console.log('\n-- 6. the invariant --');
{
  const h = await page();
  await addPart(h);
  const h2 = await page({ values: { openingStock: '0' } });
  await addPart(h2);

  const all = [...partWrites(h.f), ...partWrites(h2.f)];
  ok('every parts write this suite made is free of `stock`',
    all.length > 0 && all.every((c) => !('stock' in (c.body || {}))),
    JSON.stringify(all.map((c) => c.body)));
  ok('   ...and free of `openingStock`',
    all.every((c) => !('openingStock' in (c.body || {}))),
    JSON.stringify(all.map((c) => c.body)));
}

summary('Inventory Add Part');
})();
