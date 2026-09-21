/* job-card-server-owned — the figures a job card write must NOT send.

   The third production defect of this shape, after C-16 (Inventory sent
   `stock: 0`) and C-17 (Appointments sent `jobCardId: null`). Here
   buildRecord() included subtotal, tax, total and due, and
   routes/job-cards.js refuses all four by name through SERVER_OWNED --
   because a client must not be able to assert a total the lines do not
   support. Every job card create and every edit came back 422 "Some job card
   fields are not valid.", naming all four.

   The create site's own comment already stated the rule the code broke:

     // Totals are recomputed from the lines on the server, so what is sent
     // is the lines -- not a subtotal it would have to take on trust.
     const created = await Storage.create('jobCards', { ...buildRecord(v), ...

   THIS ONE DIFFERS FROM C-16 AND C-17 in a way that matters: the four fields
   are NOT dead weight. 'local' mode has no server to compute them, so
   buildRecord() must keep producing them and the local record must keep
   storing them. Only the API payload may drop them. That is why the fix is
   forApi() at the two call sites rather than a deletion in buildRecord(), and
   why this suite asserts BOTH modes -- a fix that cleaned the wire by
   breaking the offline app would be a worse bug than the one it replaced.

   `paid` and `labourCost` are deliberately still sent: neither is
   SERVER_OWNED. `paid` is a real input the server stores as given, which is
   what makes it the frozen snapshot audit Finding 1 rests on. */
process.env.TZ = 'Asia/Dhaka';
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const SERVER_OWNED = ['subtotal', 'tax', 'total', 'due'];

function field(value) {
  return { value: String(value), innerHTML: '', hidden: false, addEventListener() {} };
}

/* The module reads its inputs by NAME off ov.querySelector('#jobForm')
   (form.customerId.value), and reads the line rows and the checklist through
   querySelectorAll -- an empty overlay means a card with no lines, which
   validate() allows. bindFormEvents() also wires a few #jf-* controls, so
   those have to exist and take a listener. */
const FORM_FIELDS = [
  'customerId', 'vehicleId', 'mechanicId', 'priority', 'date', 'estDelivery',
  'mileage', 'mileageOut', 'fuelLevel', 'conditionNotes', 'complaint',
  'inspection', 'diagnosis', 'technicianNotes', 'recommendations', 'notes',
  'labourHours', 'labourRate', 'labourCost', 'discount', 'taxRate', 'paid',
  'appointmentId',
];

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
  };
  // validate() requires at least one service line, so the overlay has to
  // carry one -- readLines() builds it from .line-service / -qty / -price.
  const serviceRow = {
    querySelector(sel) {
      if (sel === '.line-service') {
        return { value: 'SRV-0001',
                 selectedOptions: [{ dataset: { name: 'Engine oil change' },
                                     textContent: 'Engine oil change' }] };
      }
      if (sel === '.line-qty') return { value: '1' };
      if (sel === '.line-price') return { value: '500' };
      return null;
    },
  };
  return {
    querySelector(sel) {
      if (sel === '[data-save]') {
        return { addEventListener: (_e, cb) => { cap.saveHandler = cb; } };
      }
      // Create has a Walk-in / From appointment selector; edit has none, and
      // readForm() leans on that null to leave appointmentId untouched.
      if (sel === '#jf-source') return isEdit ? null : field(values.source ?? 'walkin');
      return fixed[sel] || spare();
    },
    querySelectorAll(sel) {
      return sel === '[data-line="service"]' ? [serviceRow] : [];
    },
  };
}

function hookModal(ctx, values, isEdit = false) {
  const cap = { saveHandler: null, opened: 0, lastTitle: '' };
  ctx.Utils.Modal.open = (opts) => {
    cap.opened += 1;
    cap.lastTitle = (opts && opts.title) || '';
    return fakeOverlay(values, cap, isEdit);
  };
  ctx.Utils.Modal.close = () => {};
  ctx.Utils.Modal.confirm = () => {};
  return cap;
}

/* The values the production report used, in the module's own field names. */
const FORM = {
  customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001',
  priority: 'normal', date: '2026-09-22', estDelivery: '',
  mileage: '', mileageOut: '', fuelLevel: 'half', conditionNotes: '',
  complaint: 'good', inspection: '', diagnosis: '', technicianNotes: '',
  recommendations: '', notes: '', labourHours: '', labourRate: '',
  labourCost: '0', discount: '0', taxRate: '5', paid: '0',
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
  appointments: [{ id: 'APT-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001',
                   serviceId: 'SRV-0001', mechanicId: 'MEC-0001', date: '2026-09-22',
                   time: '10:45', duration: 60, status: 'Confirmed', source: 'Admin',
                   reminderSent: false, jobCardId: null }],
  'job-cards': [],
};

async function apiPage(rows = ROWS) {
  const f = fakeApi({ rows: JSON.parse(JSON.stringify(rows)) });
  const h = boot({ modules: ['js/job-cards.js'], origin: 'http://localhost:8787', fetch: f });
  await h.ctx.Storage.hydrate();
  h.ctx.Api.configure({ token: 'unit-token' });
  h.fireReady();
  return { ...h, f };
}

const sent = (f, method, re) => f.calls.filter((c) => c.method === method && re.test(c.path));

console.log('=== job cards: server-owned figures must not be sent ===\n');

(async () => {

/* ============================================================
   1. buildRecord() still produces the four -- local mode needs them
   ============================================================ */
console.log('-- 1. buildRecord keeps the totals (local mode depends on it) --');
{
  const h = await apiPage();
  // Drive the real module's own builder through a create in LOCAL mode below;
  // here just assert the shape the API path must not send.
  ok('the suite knows which fields the server owns',
    SERVER_OWNED.join(',') === 'subtotal,tax,total,due', SERVER_OWNED.join(','));
  check('the app is in API mode for the wire tests', h.ctx.Storage.mode, 'api');
}

/* ============================================================
   2. THE REGRESSION: the API create payload carries none of them
   ============================================================ */
console.log('\n-- 2. the create payload --');
{
  const h = await apiPage();
  const cap = hookModal(h.ctx, FORM);
  h.els.get('addJobBtn').dispatch('click', {});
  if (!cap.saveHandler) {
    ok('the Create Job Card modal exposed a save handler', false, 'no handler');
  } else {
    await cap.saveHandler();
    const posts = sent(h.f, 'POST', /^\/job-cards$/);
    if (posts.length !== 1) {
      ok('create sends exactly one POST /job-cards', false, `got ${posts.length}`);
    } else {
      const body = posts[0].body;
      for (const key of SERVER_OWNED) {
        ok(`THE BODY CARRIES NO \`${key}\` -- the server derives it`,
          !(key in body), JSON.stringify(Object.keys(body)));
      }
      ok('   ...but `paid` IS still sent: a real input, stored as given',
        'paid' in body, JSON.stringify(Object.keys(body)));
      ok('   ...and `labourCost` too', 'labourCost' in body, JSON.stringify(Object.keys(body)));
      ok('   ...and the LINES are sent, which is what the totals come from',
        Array.isArray(body.services), JSON.stringify(body.services));
      check('   ...status is the only one a create may name', body.status, 'Received');
    }
  }
}
/* ============================================================
   3. The edit payload carries none of them either
   ============================================================ */
console.log('\n-- 3. the edit payload --');
{
  const existing = {
    id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001',
    appointmentId: null, priority: 'normal', date: '2026-09-22', estDelivery: '',
    mileage: null, mileageOut: null, fuelLevel: 'half', conditionNotes: '',
    complaint: 'good', inspection: '', diagnosis: '', technicianNotes: '',
    recommendations: '', notes: '', services: [], partsUsed: [], inspectionChecklist: {},
    labourHours: null, labourRate: null, labourCost: 0, discount: 0, taxRate: 5,
    subtotal: 0, tax: 0, total: 0, paid: 0, due: 0, status: 'Received',
    invoiceId: null, completedAt: null, actualDelivery: '',
  };
  const h = await apiPage({ ...ROWS, 'job-cards': [existing] });
  const cap = hookModal(h.ctx, { ...FORM, complaint: 'edited' }, true);
  const btn = { dataset: { action: 'edit' },
                closest: (sel) => (sel === 'tr' ? { dataset: { id: 'JOB-0001' } } : btn) };
  h.els.get('jobTableBody').dispatch('click', {
    target: { closest: (sel) => (sel === '[data-action]' ? btn : null) },
  });
  if (!cap.saveHandler) {
    ok('the Edit Job Card modal exposed a save handler', false, 'no handler');
  } else {
    await cap.saveHandler();
    const puts = sent(h.f, 'PUT', /^\/job-cards\//);
    if (puts.length !== 1) {
      ok('edit sends exactly one PUT /job-cards/:id', false, `got ${puts.length}`);
    } else {
      for (const key of SERVER_OWNED) {
        ok(`the edit body carries no \`${key}\``,
          !(key in puts[0].body), JSON.stringify(Object.keys(puts[0].body)));
      }
      ok('   ...and still sends `paid`', 'paid' in puts[0].body,
        JSON.stringify(Object.keys(puts[0].body)));
    }
  }
}

/* ============================================================
   4. LOCAL MODE MUST KEEP THE TOTALS -- the fix must not break offline
   ============================================================ */
console.log('\n-- 4. local mode still stores the computed totals --');
{
  const h = boot({ modules: ['js/job-cards.js'] });          // no fetch -> local
  h.ctx.Storage.seedIfEmpty();
  h.fireReady();
  check('the app is in local mode', h.ctx.Storage.mode, 'local');

  const before = h.ctx.Storage.getData('jobCards').map((j) => j.id);
  const cap = hookModal(h.ctx, FORM);
  h.els.get('addJobBtn').dispatch('click', {});
  if (!cap.saveHandler) {
    ok('the local Create modal exposed a save handler', false, 'no handler');
  } else {
    await cap.saveHandler();
    const rec = h.ctx.Storage.getData('jobCards').find((j) => !before.includes(j.id));
    ok('a job card was stored offline', !!rec, 'none created');
    if (rec) {
      for (const key of SERVER_OWNED) {
        ok(`   ...and it KEEPS \`${key}\`: there is no server to compute it`,
          key in rec, JSON.stringify(Object.keys(rec)));
      }
      ok('   ...and keeps `paid` too', 'paid' in rec, JSON.stringify(Object.keys(rec)));
    }
  }
}

summary('Job card server-owned figures');
})();
