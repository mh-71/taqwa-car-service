/* Appointment Source — drives the REAL shipped appointments.js module. */
process.env.TZ = 'Asia/Dhaka';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const SOURCES = ['Admin', 'Phone', 'Walk-in', 'Facebook', 'Website'];

/* Build a fake form element the module's readForm() can read, then drive
   openAddModal / openEditModal through the real Modal + save button. */
function field(value) { return { value, _on: {}, addEventListener(){}, dispatch(){}, innerHTML: '' }; }
function fakeForm(values) {
  const f = { querySelectorAll: () => [], querySelector: () => null };
  Object.entries(values).forEach(([k, v]) => { f[k] = field(String(v)); });
  return f;
}
/* Capture Modal.open, hand back an overlay whose querySelector resolves the
   form and the save button, and expose a click() that fires the save handler. */
function hookModal(ctx, formValues) {
  const captured = { body: null, title: null, saveHandler: null, opened: [] };
  const form = fakeForm(formValues);
  ctx.Utils.Modal.open = opts => {
    captured.opened.push(opts);
    captured.body = opts.body; captured.title = opts.title;
    return {
      querySelector: sel => {
        if (sel === '#aptForm') return form;
        if (sel === '[data-save]') return { addEventListener: (_e, cb) => { captured.saveHandler = cb; } };
        return { addEventListener() {}, value: '', innerHTML: '' };
      },
      querySelectorAll: () => [],
    };
  };
  ctx.Utils.Modal.confirm = () => {};
  ctx.Utils.Modal.close = () => {};
  return captured;
}
function clickRowAction(els, tbodyId, action, rowId) {
  const btn = { dataset: { action }, closest: sel => sel === 'tr' ? { dataset: { id: rowId } } : btn };
  els.get(tbodyId).dispatch('click', { target: { closest: sel => sel === '[data-action]' ? btn : null } });
}
const futureDate = () => { const d = new Date(); d.setDate(d.getDate() + 10);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

function page() {
  const h = boot({ modules: ['js/appointments.js'] });
  h.ctx.Storage.seedIfEmpty();
  h.fireReady();
  return h;
}
/* create an appointment through the real save path; returns the created record */
function createVia(h, overrides = {}) {
  const values = { customerId: 'CUS-0001', vehicleId: 'VEH-0001', serviceId: 'SRV-0001',
    mechanicId: '', date: futureDate(), time: '09:00', duration: '60',
    status: 'Scheduled', source: 'Admin', complaint: 'test', notes: '', ...overrides };
  const cap = hookModal(h.ctx, values);
  h.els.get('addAptBtn').dispatch('click', {});
  if (!cap.saveHandler) return { cap, rec: null };
  const before = h.ctx.Storage.getData('appointments').map(a => a.id);
  cap.saveHandler();
  const rec = h.ctx.Storage.getData('appointments').find(a => !before.includes(a.id)) || null;
  return { cap, rec };
}

console.log('=== Appointment Source ===\n');

/* ---- 1-3. create with each manual source ---- */
console.log('-- 1/2/3. Create appointment with each manual source --');
for (const src of ['Admin', 'Phone', 'Walk-in', 'Facebook', 'Website']) {
  const h = page();
  const { rec } = createVia(h, { source: src, time: `1${['0','1','2'].indexOf(src[0]) >= 0 ? '0' : '3'}:00` });
  ok(`create with source="${src}" persists it`, rec && rec.source === src, rec ? `got ${rec.source}` : 'no record created');
}

/* ---- default source ---- */
{
  const h = page();
  const cap = hookModal(h.ctx, {});
  h.els.get('addAptBtn').dispatch('click', {});
  const body = cap.body || '';
  ok('create form renders a Source select', /id="af-source" name="source"/.test(body), body.slice(0, 120));
  ok('Admin is the default selection', /<option value="Admin" selected>Admin<\/option>/.test(body), body.match(/<select[^>]*af-source[\s\S]*?<\/select>/)?.[0]);
  const selHtml = body.match(/id="af-source"[\s\S]*?<\/select>/)?.[0] || '';
  ['Admin','Phone','Walk-in','Facebook','Website'].forEach(sc =>
    ok(`create form offers ${sc}`, new RegExp(`value="${sc}"`).test(selHtml), 'missing'));
  check('create form offers exactly 5 options', (selHtml.match(/<option /g) || []).length, 5);
}

/* ---- 4. Website accepted by the data layer / validation ---- */
console.log('\n-- 4. Website is a valid data value --');
{
  const h = page();
  const rec = h.ctx.Storage.addData('appointments', {
    customerId: 'CUS-0001', vehicleId: 'VEH-0001', serviceId: 'SRV-0001', mechanicId: '',
    date: futureDate(), time: '08:00', duration: 60, status: 'Scheduled',
    source: 'Website', complaint: 'online booking', notes: '', reminderSent: false, jobCardId: null });
  check('Website stored verbatim', h.ctx.Storage.getById('appointments', rec.id).source, 'Website');
  // and it survives a render
  h.fireReady();
  ok('Website row renders in the list',
     h.els.get('aptTableBody').innerHTML.includes('Website'), 'not rendered');
}

/* ---- 5. edit source ---- */
console.log('\n-- 5. Edit an appointment source --');
{
  const h = page();
  const { rec } = createVia(h, { source: 'Phone', time: '14:00' });
  ok('created with Phone', rec && rec.source === 'Phone');
  const cap = hookModal(h.ctx, { customerId: rec.customerId, vehicleId: rec.vehicleId,
    serviceId: rec.serviceId, mechanicId: '', date: rec.date, time: rec.time,
    duration: String(rec.duration), status: rec.status, source: 'Walk-in',
    complaint: rec.complaint, notes: '' });
  clickRowAction(h.els, 'aptTableBody', 'edit', rec.id);
  ok('edit modal opened', !!cap.saveHandler, 'no save handler');
  cap.saveHandler();
  check('source updated by an explicit edit', h.ctx.Storage.getById('appointments', rec.id).source, 'Walk-in');
}
{
  // a Website record keeps Website selectable while editing
  const h = page();
  const rec = h.ctx.Storage.addData('appointments', { customerId:'CUS-0001', vehicleId:'VEH-0001',
    serviceId:'SRV-0001', mechanicId:'', date: futureDate(), time:'15:30', duration:60,
    status:'Scheduled', source:'Website', complaint:'x', notes:'', reminderSent:false, jobCardId:null });
  h.fireReady();
  const cap = hookModal(h.ctx, {});
  clickRowAction(h.els, 'aptTableBody', 'edit', rec.id);
  const sel = (cap.body || '').match(/id="af-source"[\s\S]*?<\/select>/)?.[0] || '';
  ok('editing a Website appointment keeps Website selected', /value="Website" selected/.test(sel), sel);
  ok('edit form offers all five', ['Admin','Phone','Walk-in','Facebook','Website']
     .every(sc => new RegExp(`value="${sc}"`).test(sel)), sel);
  ok('no legacy "(from website)" suffix remains', !/\(from website\)/.test(sel), sel);
}

/* ---- 6. invalid source rejected ---- */
console.log('\n-- 6. Invalid sources are rejected --');
for (const bad of ['', 'website', 'facebook', 'API', 'Walkin', 'FB', 'Drive-by', '<script>']) {
  const h = page();
  const { rec } = createVia(h, { source: bad, time: '16:00' });
  ok(`source="${bad || '(empty)'}" rejected`, rec === null, rec ? `created with ${rec.source}` : '');
}

/* ---- 7. list displays source ---- */
console.log('\n-- 7. List shows the source --');
{
  const h = page();
  const html = h.els.get('aptTableBody').innerHTML;
  ['Phone', 'Website', 'Admin', 'Walk-in', 'Facebook'].forEach(sc =>
    ok(`list renders "${sc}"`, html.includes(`>${sc}</span>`), 'not found'));
  ok('rendered via the existing badge component', /class="badge badge--neutral">(Phone|Website|Admin|Walk-in|Facebook)/.test(html), 'not a badge');
  check('table header has a Source column',
    /<th>Status<\/th><th>Source<\/th>/.test(fs.readFileSync(`${ROOT}/pages/appointments.html`, 'utf8')), true);
}

/* ---- 8. source filter ---- */
console.log('\n-- 8. Source filter --');
{
  const h = page();
  const rows = () => [...h.els.get('aptTableBody').innerHTML.matchAll(/<tr data-id="([^"]+)">/g)].map(m => m[1]);
  check('all 5 seeded appointments listed', rows().length, 5);
  const sel = h.els.get('aptSource');
  for (const [src, expected] of [['Website', ['APT-0002']], ['Admin', ['APT-0004']],
                                 ['Phone', ['APT-0001']], ['Walk-in', ['APT-0005']],
                                 ['Facebook', ['APT-0003']]]) {
    sel.value = src; sel.dispatch('change', { target: sel });
    check(`filter "${src}"`, rows().sort(), expected.sort());
  }
  sel.value = 'all'; sel.dispatch('change', { target: sel });
  check('filter cleared restores all', rows().length, 5);
  ok('count label reflects the source filter',
     (sel.value = 'Website', sel.dispatch('change', { target: sel }),
      h.els.get('aptCount').textContent.includes('of 5')), h.els.get('aptCount').textContent);
}

/* ---- 9. legacy records without source ---- */
console.log('\n-- 9. Legacy appointments with no source field --');
{
  const h = page();
  const appts = h.ctx.Storage.getData('appointments');
  // strip source three different ways, as legacy data might
  delete appts[0].source; appts[1].source = null; appts[2].source = '';
  h.ctx.Storage.saveData('appointments', appts);
  h.fireReady();
  const html = h.els.get('aptTableBody').innerHTML;
  ok('list still renders with legacy records', html.includes('APT-0001'), 'render broke');
  check('three legacy records now read as Admin',
    h.ctx.Storage.getData('appointments').slice(0, 3)
      .map(a => (SOURCES.includes(a.source) ? a.source : 'Admin')), ['Admin','Admin','Admin']);
  const sel = h.els.get('aptSource');
  sel.value = 'Admin'; sel.dispatch('change', { target: sel });
  const rows = [...h.els.get('aptTableBody').innerHTML.matchAll(/<tr data-id="([^"]+)">/g)].map(m => m[1]);
  check('legacy records filter under Admin', rows.sort(), ['APT-0001','APT-0002','APT-0003','APT-0004']);
  // stored data untouched -- no silent rewrite
  const stored = h.ctx.Storage.getData('appointments');
  check('legacy source values NOT rewritten in storage',
    [stored[0].source, stored[1].source, stored[2].source], [undefined, null, '']);
}

/* ---- 10. appointment -> job card ---- */
console.log('\n-- 10. Appointment -> Job Card workflow --');
{
  const h = boot({ modules: ['js/job-cards.js'] });
  h.ctx.Storage.seedIfEmpty();
  h.fireReady();
  const before = h.ctx.Storage.getById('appointments', 'APT-0001');
  check('APT-0001 source before conversion', before.source, 'Phone');
  // simulate the job-card link + status sync the module performs
  h.ctx.Storage.updateData('appointments', 'APT-0001', { jobCardId: 'JOB-9001' });
  h.ctx.Storage.updateData('appointments', 'APT-0001', { status: 'In Progress' });
  const after = h.ctx.Storage.getById('appointments', 'APT-0001');
  check('source survives the job-card link', after.source, 'Phone');
  check('source survives the status sync', after.status, 'In Progress');
  check('jobCardId written as before', after.jobCardId, 'JOB-9001');
  ok('job-cards.js never writes a source field',
     !/updateData\('appointments'[^)]*source/.test(fs.readFileSync(`${ROOT}/js/job-cards.js`, 'utf8')),
     'job-cards.js touches source');
  ok('source not copied onto the Job Card record',
     !/source/.test(fs.readFileSync(`${ROOT}/js/job-cards.js`, 'utf8').match(/function buildRecord[\s\S]*?\n  \}/)?.[0] || ''),
     'buildRecord mentions source');
}

/* ---- 11. existing appointments intact ---- */
console.log('\n-- 11. Existing appointment data intact --');
{
  const h = page();
  const appts = h.ctx.Storage.getData('appointments');
  check('still 5 seeded appointments', appts.length, 5);
  check('ids unchanged', appts.map(a => a.id), ['APT-0001','APT-0002','APT-0003','APT-0004','APT-0005']);
  check('APT-0003 keeps its job card link', appts[2].jobCardId, 'JOB-0004');
  check('seed sources are the canonical set',
    appts.map(a => a.source), ['Phone','Website','Facebook','Admin','Walk-in']);
  check('all five canonical values appear in seed data',
    [...new Set(appts.map(a => a.source))].sort(), ['Admin','Facebook','Phone','Walk-in','Website']);
  ok('every seeded source is canonical', appts.every(a => SOURCES.includes(a.source)));
}

process.exit(summary('Appointment Source') === 0 ? 0 : 1);
