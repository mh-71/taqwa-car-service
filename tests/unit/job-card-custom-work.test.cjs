/* job-card-custom-work — Job Card → Services → custom work lines.

   Custom work is a job card service line with NO catalogue service behind
   it: { serviceId: null, name, qty, unitPrice, total }. It lives in
   job_card_services with service_id NULL, the convention a manual part line
   already uses, and is shown as "Name (Custom)" -- the marker is derived
   from serviceId === null and is never stored in the name.

   This suite drives the REAL js/job-cards.js through the harness: the form
   is a fake overlay whose rows answer the same selectors the module reads
   (.line-service / .line-work / .line-qty / .line-price), so what is checked
   is the module's own readLines → validate → buildRecord → forApi path and
   the HTML its edit, details and print views produce. The server side of the
   same rules is covered in api-job-cards-write.test.mjs (section 9b). */
process.env.TZ = 'Asia/Dhaka';
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

function field(value) {
  return { value: String(value), innerHTML: '', hidden: false, addEventListener() {} };
}

const FORM_FIELDS = [
  'customerId', 'vehicleId', 'mechanicId', 'priority', 'date', 'estDelivery',
  'mileage', 'mileageOut', 'fuelLevel', 'conditionNotes', 'complaint',
  'inspection', 'diagnosis', 'technicianNotes', 'recommendations', 'notes',
  'labourHours', 'labourRate', 'labourCost', 'discount', 'taxRate', 'paid',
  'appointmentId',
];

/* ---------- rows, answering the selectors readLines() uses ---------- */

const catalogRow = (serviceId, name, qty, price) => ({
  querySelector(sel) {
    if (sel === '.line-work') return null;
    if (sel === '.line-service') {
      return { value: serviceId, selectedOptions: [{ dataset: { name }, textContent: name }] };
    }
    if (sel === '.line-qty') return { value: String(qty) };
    if (sel === '.line-price') return { value: String(price) };
    return null;
  },
});
// "+ Add Service" pressed and nothing picked: the select still shows its placeholder.
const blankCatalogRow = (price = 0) => ({
  querySelector(sel) {
    if (sel === '.line-work') return null;
    if (sel === '.line-service') {
      return { value: '', selectedOptions: [{ dataset: {}, textContent: '— Select service —' }] };
    }
    if (sel === '.line-qty') return { value: '1' };
    if (sel === '.line-price') return { value: String(price) };
    return null;
  },
});
const customRow = (name, qty, price) => ({
  querySelector(sel) {
    if (sel === '.line-work') return { value: name };
    if (sel === '.line-qty') return { value: String(qty) };
    if (sel === '.line-price') return { value: String(price) };
    return null;
  },
});
const manualPartRow = (name, qty, price) => ({
  dataset: { manualName: name },
  querySelector(sel) {
    if (sel === '.line-part') return { value: '', selectedOptions: [] };
    if (sel === '.line-partno') return { value: '' };
    if (sel === '.line-qty') return { value: String(qty) };
    if (sel === '.line-price') return { value: String(price) };
    return null;
  },
});

/* An overlay that reads its rows from cap at call time, so a test can change
   the lines between opening the modal and pressing save. */
function fakeOverlay(values, cap, isEdit) {
  const form = { querySelector: () => null, querySelectorAll: () => [] };
  for (const name of FORM_FIELDS) form[name] = field(values[name] ?? '');
  const spare = () => ({ value: '', innerHTML: '', hidden: false, textContent: '',
                         addEventListener() {}, classList: { add() {}, remove() {} },
                         closest: () => null });
  const fixed = {
    '#jobForm': form,
    '#jf-apt-wrap': spare(),
    '#jf-appointment': field(values.appointmentId ?? ''),
    '#serviceLines': spare(),
    '#partLines': spare(),
    '#jf-totals': spare(),
    '[data-err="services"]': cap.servicesError,
  };
  return {
    querySelector(sel) {
      if (sel === '[data-save]') {
        return { addEventListener: (_e, cb) => { cap.saveHandler = cb; } };
      }
      if (sel === '#jf-source') return isEdit ? null : field(values.source ?? 'walkin');
      return fixed[sel] || spare();
    },
    querySelectorAll(sel) {
      if (sel === '[data-line="service"]') return cap.services;
      if (sel === '[data-line="part"]') return cap.parts;
      return [];
    },
  };
}

function hookModal(ctx, values, isEdit = false) {
  const cap = { saveHandler: null, bodies: [], services: [], parts: [],
                servicesError: { textContent: '', closest: () => null } };
  ctx.Utils.Modal.open = (opts) => {
    cap.bodies.push((opts && opts.body) || '');
    return fakeOverlay(values, cap, isEdit);
  };
  ctx.Utils.Modal.close = () => {};
  ctx.Utils.Modal.confirm = () => {};
  return cap;
}

const FORM = {
  customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001',
  priority: 'normal', date: '2026-10-07', estDelivery: '',
  mileage: '', mileageOut: '', fuelLevel: 'half', conditionNotes: '',
  complaint: 'Seat torn', inspection: '', diagnosis: '', technicianNotes: '',
  recommendations: '', notes: '', labourHours: '', labourRate: '',
  labourCost: '0', discount: '0', taxRate: '0', paid: '0',
  source: 'walkin', appointmentId: '',
};

const ROWS = {
  customers: [{ id: 'CUS-0001', name: 'Rasel', phone: '0160153567', status: 'Active' }],
  vehicles: [{ id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHAKA-METRO-GA-29-2345',
               brand: 'Toyota', model: 'Premio', status: 'Active' }],
  services: [{ id: 'SRV-0001', name: 'Engine oil change', price: 500, status: 'Active' }],
  mechanics: [{ id: 'MEC-0001', name: 'Murad', specialization: 'Engine',
                status: 'Active', availability: 'Available' }],
  parts: [],
  appointments: [],
  'job-cards': [],
};

const STORED_JOB = {
  id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001',
  appointmentId: null, priority: 'normal', date: '2026-10-07', estDelivery: '',
  mileage: null, mileageOut: null, fuelLevel: 'half', conditionNotes: '',
  complaint: 'Seat torn', inspection: '', diagnosis: '', technicianNotes: '',
  recommendations: '', notes: '',
  services: [
    { serviceId: 'SRV-0001', name: 'Engine oil change', qty: 1, unitPrice: 500, total: 500 },
    { serviceId: null, name: 'Leather work', qty: 1, unitPrice: 3000, total: 3000 },
  ],
  partsUsed: [], inspectionChecklist: {},
  labourHours: null, labourRate: null, labourCost: 0, discount: 0, taxRate: 0,
  subtotal: 3500, tax: 0, total: 3500, paid: 0, due: 3500, status: 'Received',
  invoiceId: null, completedAt: null, actualDelivery: '',
};

/* openDetailModal() and printJobCard() reach for document.querySelector and
   window.print; the harness answers neither, so stand them in. */
const pageStandIns = (doc, ctx) => {
  const base = doc.querySelector;
  doc.querySelector = (sel) => (sel === '[data-print-view]' || sel === '[data-edit-from-view]'
    ? { addEventListener() {} } : base(sel));
  ctx.window.print = () => {};
};

async function apiPage(rows = ROWS) {
  const f = fakeApi({ rows: JSON.parse(JSON.stringify(rows)) });
  const h = boot({ modules: ['js/job-cards.js'], origin: 'http://localhost:8787', fetch: f,
                   beforeModules: pageStandIns });
  await h.ctx.Storage.hydrate();
  h.ctx.Api.configure({ token: 'unit-token' });
  h.fireReady();
  return { ...h, f };
}

const sent = (f, method, re) => f.calls.filter((c) => c.method === method && re.test(c.path));
const rowAction = (h, action, id) => {
  const btn = { dataset: { action },
                closest: (sel) => (sel === 'tr' ? { dataset: { id } } : btn) };
  h.els.get('jobTableBody').dispatch('click', {
    target: { closest: (sel) => (sel === '[data-action]' ? btn : null) },
  });
};

/** Open New Job Card, set the lines, press save; returns the POST bodies. */
async function create(h, services, parts = [], form = FORM) {
  const cap = hookModal(h.ctx, form);
  h.els.get('addJobBtn').dispatch('click', {});
  cap.services = services;
  cap.parts = parts;
  await cap.saveHandler();
  return { cap, posts: h.f ? sent(h.f, 'POST', /^\/job-cards$/) : [] };
}

console.log('=== job cards: custom work lines ===\n');

(async () => {

/* ============================================================
   1. Create: catalogue + custom, and a blank catalogue row
   ============================================================ */
console.log('-- 1. create sends custom work as serviceId null --');
{
  const h = await apiPage();
  const servicesBefore = h.ctx.Storage.getData('services').length;
  const { posts } = await create(h, [
    catalogRow('SRV-0001', 'Engine oil change', 1, 500),
    blankCatalogRow(999),
    customRow('Leather work', 1, 3000),
  ]);
  check('exactly one POST /job-cards', posts.length, 1);
  const lines = posts[0] && posts[0].body.services;
  check('the catalogue line is sent exactly as before', lines && lines[0],
    { serviceId: 'SRV-0001', name: 'Engine oil change', qty: 1, unitPrice: 500, total: 500 });
  check('the custom work line is sent with serviceId null and its own name', lines && lines[1],
    { serviceId: null, name: 'Leather work', qty: 1, unitPrice: 3000, total: 3000 });
  check('the blank catalogue row is dropped -- it does not become custom work', lines && lines.length, 2);
  ok('   ...and the placeholder text is never saved as a name',
    !JSON.stringify(lines).includes('Select service'), JSON.stringify(lines));
  ok('"(Custom)" is never written into the name', !JSON.stringify(lines).includes('(Custom)'), JSON.stringify(lines));

  const rec = h.ctx.Storage.getData('jobCards').find((j) => j.complaint === 'Seat torn');
  ok('the created card reloads with its custom work line',
    !!rec && rec.services.some((l) => l.serviceId === null && l.name === 'Leather work'),
    JSON.stringify(rec && rec.services));
  check('no Service Catalog record was created', h.ctx.Storage.getData('services').length, servicesBefore);
  check('   ...and no catalogue write was sent', sent(h.f, 'POST', /^\/services/).length, 0);
}
{
  const h = await apiPage();
  const { posts } = await create(h, [customRow('Leather work', 1, 3000)]);
  check('custom work alone is enough for a job card', posts.length, 1);
}
{
  const h = await apiPage();
  const { posts } = await create(h, [customRow('  Painting  ', 3, 1200), customRow('Welding', 1, 0)]);
  const lines = posts[0] && posts[0].body.services;
  check('several custom lines, names trimmed, qty x price, a 0 price accepted, order kept',
    lines && lines.map((l) => [l.serviceId, l.name, l.qty, l.unitPrice, l.total]),
    [[null, 'Painting', 3, 1200, 3600], [null, 'Welding', 1, 0, 0]]);
}

/* ============================================================
   2. Validation
   ============================================================ */
console.log('\n-- 2. custom work validation --');
for (const [label, row, msg] of [
  ['a blank name', customRow('', 1, 3000), 'Enter a name for each custom work line, or remove it.'],
  ['a whitespace-only name', customRow('    ', 1, 3000), 'Enter a name for each custom work line, or remove it.'],
  ['a name over 200 characters', customRow('x'.repeat(201), 1, 3000), 'Custom work name must be 200 characters or fewer.'],
  ['qty 0', customRow('Leather work', 0, 3000), 'Custom work quantity must be > 0 and price cannot be negative.'],
  ['a negative qty', customRow('Leather work', -1, 3000), 'Custom work quantity must be > 0 and price cannot be negative.'],
  ['a negative price', customRow('Leather work', 1, -5), 'Custom work quantity must be > 0 and price cannot be negative.'],
  ['a price that is not finite', customRow('Leather work', 1, 'Infinity'), 'Custom work quantity must be > 0 and price cannot be negative.'],
]) {
  const h = await apiPage();
  const { cap, posts } = await create(h, [catalogRow('SRV-0001', 'Engine oil change', 1, 500), row]);
  check(`${label} -> nothing is sent`, posts.length, 0);
  check('   ...and the services error says why', cap.servicesError.textContent, msg);
}
{
  const h = await apiPage();
  const { posts } = await create(h, [customRow('x'.repeat(200), 1, 10)]);
  check('a 200-character name is accepted', posts.length, 1);
}
{
  const h = await apiPage();
  const { cap, posts } = await create(h, [blankCatalogRow(500)]);
  check('a lone blank catalogue row still counts as nothing', posts.length, 0);
  check('   ...with the existing wording', cap.servicesError.textContent, 'Add at least one service, part, or labour entry.');
}

/* ============================================================
   3. Totals (local mode stores the computed figures)
   ============================================================ */
console.log('\n-- 3. custom work in the totals --');
{
  const h = boot({ modules: ['js/job-cards.js'], beforeModules: pageStandIns });
  h.ctx.Storage.seedIfEmpty();
  h.fireReady();
  check('the app is in local mode', h.ctx.Storage.mode, 'local');
  const svc = h.ctx.Storage.getData('services')[0];
  const before = h.ctx.Storage.getData('jobCards').map((j) => j.id);
  await create(h, [
    catalogRow(svc.id, svc.name, 1, 500),
    customRow('Leather work', 1, 3000),
  ], [manualPartRow('Bracket', 2, 100)],
  { ...FORM, labourHours: '2', labourRate: '400', discount: '100', taxRate: '5' });
  const rec = h.ctx.Storage.getData('jobCards').find((j) => !before.includes(j.id));
  ok('a local job card was stored', !!rec, 'none');
  if (rec) {
    // services 500 + custom 3000 + part 200 + labour 800 = 4500
    check('subtotal = services + custom work + parts + labour', rec.subtotal, 4500);
    check('   ...discount as given', rec.discount, 100);
    check('   ...tax = round((4500 - 100) x 5%)', rec.tax, 220);
    check('   ...total', rec.total, 4620);
    check('   ...the custom line is stored with serviceId null',
      rec.services.map((l) => [l.serviceId === null, l.name, l.total]),
      [[false, svc.name, 500], [true, 'Leather work', 3000]]);
  }
}

/* ============================================================
   4. Edit: the custom line opens as custom, survives, can be removed
   ============================================================ */
console.log('\n-- 4. edit --');
{
  const h = await apiPage({ ...ROWS, 'job-cards': [STORED_JOB] });
  const cap = hookModal(h.ctx, { ...FORM }, true);
  rowAction(h, 'edit', 'JOB-0001');
  const body = cap.bodies[0] || '';
  ok('the edit form renders the custom line in its own name box',
    /class="input line-work"[^>]*value="Leather work"/.test(body), body.slice(0, 200));
  check('   ...exactly one custom row', (body.match(/line-row--custom/g) || []).length, 1);
  ok('   ...and the catalogue line is still a select with its service picked',
    /<option value="SRV-0001"[^>]*selected/.test(body));
  ok('the form offers "+ Add Custom Work" beside "+ Add Service"',
    body.includes('id="addServiceLine"') && body.includes('id="addCustomLine"') && body.includes('+ Add Custom Work'));

  cap.services = [catalogRow('SRV-0001', 'Engine oil change', 1, 500), customRow('Leather work (seat)', 2, 3000)];
  await cap.saveHandler();
  const puts = sent(h.f, 'PUT', /^\/job-cards\//);
  check('edit sends one PUT', puts.length, 1);
  check('   ...the edited custom line survives with serviceId null',
    puts[0] && puts[0].body.services[1],
    { serviceId: null, name: 'Leather work (seat)', qty: 2, unitPrice: 3000, total: 6000 });
  const reloaded = h.ctx.Storage.getById('jobCards', 'JOB-0001');
  ok('   ...and is there after the reload',
    reloaded.services.some((l) => l.serviceId === null && l.name === 'Leather work (seat)'),
    JSON.stringify(reloaded.services));
}
{
  const h = await apiPage({ ...ROWS, 'job-cards': [STORED_JOB] });
  const cap = hookModal(h.ctx, { ...FORM }, true);
  rowAction(h, 'edit', 'JOB-0001');
  cap.services = [catalogRow('SRV-0001', 'Engine oil change', 1, 500)];
  await cap.saveHandler();
  const puts = sent(h.f, 'PUT', /^\/job-cards\//);
  check('removing the custom row sends only the catalogue line',
    puts[0] && puts[0].body.services.map((l) => l.serviceId), ['SRV-0001']);
}

/* ============================================================
   5. Details and print show "Name (Custom)"
   ============================================================ */
console.log('\n-- 5. details and print --');
{
  const h = await apiPage({ ...ROWS, 'job-cards': [STORED_JOB] });
  const cap = hookModal(h.ctx, {});
  rowAction(h, 'view', 'JOB-0001');
  const body = cap.bodies[0] || '';
  ok('details shows the custom line as "Leather work (Custom)"', body.includes('Leather work (Custom)'), body.slice(0, 300));
  ok('   ...and the catalogue line exactly as before, unmarked',
    body.includes('>Engine oil change</td>') && !body.includes('Engine oil change (Custom)'));
}
{
  const h = await apiPage({ ...ROWS, 'job-cards': [STORED_JOB] });
  rowAction(h, 'print', 'JOB-0001');
  const html = h.els.get('printArea').innerHTML;
  ok('print shows "Leather work (Custom)"', html.includes('<td>Leather work (Custom)</td>'), html.slice(0, 300));
  ok('   ...and the catalogue line unmarked', html.includes('<td>Engine oil change</td>'));
}
{
  // The marker is decided by serviceId alone, never by parsing the name.
  const h = await apiPage({ ...ROWS, 'job-cards': [{ ...STORED_JOB,
    services: [{ serviceId: 'SRV-0001', name: 'Seat work (Custom)', qty: 1, unitPrice: 500, total: 500 }] }] });
  rowAction(h, 'print', 'JOB-0001');
  ok('a catalogue line whose name happens to say "(Custom)" gets no second marker',
    h.els.get('printArea').innerHTML.includes('<td>Seat work (Custom)</td>'));
}
{
  // Names are escaped like every other line name.
  const h = await apiPage({ ...ROWS, 'job-cards': [{ ...STORED_JOB,
    services: [{ serviceId: null, name: '<img src=x onerror=alert(1)>', qty: 1, unitPrice: 1, total: 1 }] }] });
  rowAction(h, 'print', 'JOB-0001');
  const html = h.els.get('printArea').innerHTML;
  ok('a custom name is HTML-escaped in print', html.includes('&lt;img src=x onerror=alert(1)&gt; (Custom)') && !html.includes('<img src=x'), html.slice(0, 200));
}

summary('Job card custom work');
})();
