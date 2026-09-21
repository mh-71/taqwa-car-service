/* appointment-create-payload — what the New Appointment form puts on the wire.

   The second production defect of exactly the shape C-16 fixed in Inventory.
   openAddModal() sent `jobCardId: null` with the appointment, and
   routes/appointments.js:156 refuses ANY jobCardId that is not undefined --
   null included -- because linking an appointment to a job card is a
   two-table operation the Job Card phase owns. Every booking came back 422
   "Some appointment fields are not valid."

   The comparison that makes this a frontend bug rather than a backend one:
   js/job-cards.js:881 sends `invoiceId: null` on create and the server takes
   it, because routes/job-cards.js:1016 guards with `!== undefined && !== null`.
   Appointments guards with a bare `!== undefined`. The client has to respect
   whichever rule the route actually states, and for appointments that means
   not sending the key at all.

   Nothing caught it because the server side was only ever tested from the
   server's side, and because in 'local' mode `jobCardId: null` is just
   another localStorage field. So this suite drives the REAL shipped
   js/appointments.js in API mode and asserts the request body. fake-api does
   not re-implement the Worker's refusals (its own header says so), which is
   why the assertion is "we never sent it" rather than "the server said no".

   Every C-3 rule stays where it is: this file asserts the payload, never
   relaxes a rule. */
process.env.TZ = 'Asia/Dhaka';
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

/* readForm() only ever does form[name].value, so this is enough of a form. */
function field(value) {
  return { value: String(value), _on: {}, addEventListener() {}, dispatch() {}, innerHTML: '' };
}
function fakeForm(values) {
  const f = { querySelectorAll: () => [], querySelector: () => null };
  Object.entries(values).forEach(([k, v]) => { f[k] = field(v); });
  return f;
}

/* Capture Modal.open and expose the save button's handler, the way
   appointment-source.test.cjs drives the same module. */
function hookModal(ctx, values) {
  const cap = { saveHandler: null, opened: 0 };
  const form = fakeForm(values);
  ctx.Utils.Modal.open = () => {
    cap.opened += 1;
    return {
      querySelector: (sel) => {
        if (sel === '#aptForm') return form;
        if (sel === '[data-save]') {
          return { addEventListener: (_e, cb) => { cap.saveHandler = cb; } };
        }
        return { addEventListener() {}, value: '', innerHTML: '', textContent: '' };
      },
      querySelectorAll: () => [],
    };
  };
  ctx.Utils.Modal.close = () => {};
  ctx.Utils.Modal.confirm = () => {};
  return cap;
}

/* Far enough ahead that the C-3 past-date rule is satisfied on any run day. */
function futureDate(offset = 10) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* The production report's own values: Confirmed, Admin, 60 minutes, 16:18. */
const FORM = {
  customerId: 'CUS-0001', vehicleId: 'VEH-0001', serviceId: 'SRV-0001', mechanicId: 'MEC-0001',
  date: futureDate(), time: '16:18', duration: '60',
  status: 'Confirmed', source: 'Admin',
  complaint: 'quick', notes: 'good',
};

const ROWS = {
  customers: [{ id: 'CUS-0001', name: 'Mosharraf Hossen', phone: '0160153057', status: 'Active' }],
  vehicles: [{ id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHAKA METRO GA, 25-3345',
               brand: 'Toyota', model: 'Axio', status: 'Active' }],
  services: [{ id: 'SRV-0001', name: 'Brake pad change', price: 1500, status: 'Active' }],
  mechanics: [{ id: 'MEC-0001', name: 'Murad', specialization: 'Engine',
                status: 'Active', availability: 'Available' }],
  appointments: [],
};

async function page({ rows = ROWS, values = {} } = {}) {
  const f = fakeApi({ rows: JSON.parse(JSON.stringify(rows)) });
  const h = boot({ modules: ['js/appointments.js'], origin: 'http://localhost:8787', fetch: f });
  await h.ctx.Storage.hydrate();
  h.ctx.Api.configure({ token: 'unit-token' });
  h.fireReady();
  return { ...h, f, values: { ...FORM, ...values } };
}

/* Open New Appointment and run its save handler to completion. guard()
   swallows throws, so a broken flow shows up as a missing request. */
async function book(h) {
  const cap = hookModal(h.ctx, h.values);
  h.els.get('addAptBtn').dispatch('click', {});
  if (!cap.saveHandler) throw new Error('New Appointment modal did not expose a save handler');
  await cap.saveHandler();
  return cap;
}

const sent = (f, method, re) => f.calls.filter((c) => c.method === method && re.test(c.path));

console.log('=== appointments: create payload wire contract ===\n');

(async () => {

/* ============================================================
   1. THE REGRESSION: no `jobCardId` key may leave the browser
   ============================================================ */
console.log('-- 1. the create payload --');
{
  const h = await page();
  check('the app is talking to the backend', h.ctx.Storage.mode, 'api');
  await book(h);

  const posts = sent(h.f, 'POST', /^\/appointments$/);
  check('booking sends exactly one POST /appointments', posts.length, 1);
  const body = posts[0].body;

  ok('THE BODY CARRIES NO `jobCardId` KEY -- the API refuses it, null included',
    !('jobCardId' in body), JSON.stringify(body));

  check('   ...customerId is sent', body.customerId, 'CUS-0001');
  check('   ...vehicleId is sent', body.vehicleId, 'VEH-0001');
  check('   ...serviceId is sent', body.serviceId, 'SRV-0001');
  check('   ...mechanicId is sent', body.mechanicId, 'MEC-0001');
  check('   ...date is sent as yyyy-mm-dd', body.date, h.values.date);
  check('   ...time is sent as HH:MM', body.time, '16:18');
  check('   ...duration is a number, not a string', body.duration, 60);
  check('   ...status is the one chosen', body.status, 'Confirmed');
  check('   ...source is preserved', body.source, 'Admin');
  check('   ...complaint is sent', body.complaint, 'quick');
  check('   ...notes are sent', body.notes, 'good');
  ok('   ...reminderSent is a real boolean, which the API does accept',
    body.reminderSent === false, JSON.stringify(body.reminderSent));
}

/* ============================================================
   2. The appointment is created and left unlinked
   ============================================================ */
console.log('\n-- 2. a new appointment starts unlinked --');
{
  const h = await page();
  await book(h);

  const rec = h.ctx.Storage.getData('appointments')[0];
  ok('the appointment exists', !!rec, JSON.stringify(rec));
  ok('   ...and is not linked to a job card',
    !rec.jobCardId, JSON.stringify(rec.jobCardId));
  ok('   ...which every caller tests by truthiness, so absent behaves as null',
    rec.jobCardId === undefined || rec.jobCardId === null, JSON.stringify(rec));
  check('no job card write was attempted', sent(h.f, 'POST', /^\/job-cards/).length, 0);
  check('   ...and no appointment PUT either', sent(h.f, 'PUT', /^\/appointments/).length, 0);
}

/* ============================================================
   3. Editing an appointment never sends jobCardId either
   ============================================================ */
console.log('\n-- 3. the edit path --');
{
  const existing = {
    id: 'APT-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', serviceId: 'SRV-0001',
    mechanicId: 'MEC-0001', date: futureDate(20), time: '09:00', duration: 60,
    status: 'Scheduled', source: 'Admin', complaint: '', notes: '',
    reminderSent: false, jobCardId: null,
  };
  const h = await page({ rows: { ...ROWS, appointments: [existing] } });
  const cap = hookModal(h.ctx, { ...FORM, date: futureDate(20), time: '11:00' });

  const btn = { dataset: { action: 'edit' }, closest: (sel) => (sel === 'tr' ? { dataset: { id: 'APT-0001' } } : btn) };
  h.els.get('aptTableBody').dispatch('click', {
    target: { closest: (sel) => (sel === '[data-action]' ? btn : null) },
  });
  ok('the edit modal opened', cap.opened > 0, String(cap.opened));
  await cap.saveHandler();

  const puts = sent(h.f, 'PUT', /^\/appointments\//);
  check('editing sends one PUT', puts.length, 1);
  ok('   ...and it carries no `jobCardId` key',
    !('jobCardId' in puts[0].body), JSON.stringify(puts[0].body));
}

/* ============================================================
   4. The C-3 rules the fix must not have touched
   ============================================================ */
console.log('\n-- 4. C-3 rules still hold --');
{
  // Source is preserved rather than defaulted, for each of the five.
  for (const src of ['Admin', 'Phone', 'Walk-in', 'Facebook', 'Website']) {
    const h = await page({ values: { source: src, time: '13:00' } });
    await book(h);
    const posts = sent(h.f, 'POST', /^\/appointments$/);
    check(`source ${src} is sent as chosen`, posts[0] && posts[0].body.source, src);
  }
}
{
  // A past date is refused by the UI before any request is made: the C-3 rule
  // is still enforced, and the fix did not open a hole around it.
  const past = new Date(); past.setDate(past.getDate() - 5);
  const pastStr = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')}`;
  const h = await page({ values: { date: pastStr } });
  await book(h);
  check('a past-dated booking sends NO request at all',
    sent(h.f, 'POST', /^\/appointments$/).length, 0);
}
{
  // A second booking on the same mechanic, date and time is stopped by the
  // UI's overlap check before the request -- the server keeps the last word.
  const h = await page();
  await book(h);
  check('the first booking is sent', sent(h.f, 'POST', /^\/appointments$/).length, 1);
  const again = await page({
    rows: {
      ...ROWS,
      appointments: [{ id: 'APT-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001',
        serviceId: 'SRV-0001', mechanicId: 'MEC-0001', date: FORM.date, time: '16:18',
        duration: 60, status: 'Confirmed', source: 'Admin', reminderSent: false, jobCardId: null }],
    },
  });
  await book(again);
  check('an overlapping booking sends NO request',
    sent(again.f, 'POST', /^\/appointments$/).length, 0);
}

/* ============================================================
   5. The invariant over every appointment write made here
   ============================================================ */
console.log('\n-- 5. the invariant --');
{
  const h = await page();
  await book(h);
  const writes = h.f.calls.filter(
    (c) => /^\/appointments/.test(c.path) && (c.method === 'POST' || c.method === 'PUT')
  );
  ok('every appointment write is free of `jobCardId`',
    writes.length > 0 && writes.every((c) => !('jobCardId' in (c.body || {}))),
    JSON.stringify(writes.map((c) => c.body)));
}

summary('Appointment create payload');
})();
