/* staff-add — Staff Management › Add Staff, connected to the database.

   Drives the REAL js/staff-add.js (with the real api.js, storage.js,
   utils.js, app.js and staff-form.js) through the shared harness, against a
   fake API that answers POST /api/staff the way the Worker does.

     1. No backend, signed out: the form stays disabled, says why (no
        backend) and sends nothing; nothing is kept in browser storage.
     2. Connected: the form is enabled, offers the requested designations and
        departments, caps the joining date at today and focuses Full name.
     3. The browser's checks: an empty form names every required field, puts
        each message on its field (aria-invalid, first field focused) and
        sends nothing; "Other" designations; the department suggestion.
     4. Saving someone who is not a mechanic: exactly the staff fields go to
        POST /api/staff (no id, no pay, no specialization), a second press
        sends nothing, and the browser goes to the Staff List with ?added=.
     5. Saving a mechanic: the specialization is required and sent, with
        isMechanic: true -- one record, created by the Worker.
     6. Refusals and failures -- a duplicate phone or employee code (409), a
        field the Worker refuses (422), an ended session (401), a timeout, no
        network, a server error: the reason is shown, every value stays in
        the form, Save Staff works again, and the page does not move. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

const MECHANICS = [
  { id: 'MEC-0001', name: 'Karim Mia', phone: '01811-111111', specialization: 'Engine', salary: 25000, commissionRate: 5, status: 'Active' },
];

/** fakeApi for the hydrated collections; POST /staff answered by `answer` (default: created). */
function api({ answer = null, authenticated = true } = {}) {
  const base = fakeApi({ rows: { mechanics: MECHANICS }, authenticated });
  const calls = base.calls;
  let n = 0;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (!path.startsWith('/staff')) return base(url, init);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (method !== 'POST') return res(405, { error: { code: 'method_not_allowed', message: 'Allowed: GET, POST' } });
    if (answer) {
      const a = await answer(body);
      if (a.throw) throw a.throw;
      return res(a.status, a.status < 300 ? { data: a.data } : { error: a.error });
    }
    n += 1;
    const id = body.isMechanic ? `MEC-000${n + 1}` : `STF-000${n + 3}`;
    return res(201, { data: { id, isMechanic: body.isMechanic, name: body.name, phone: body.phone, designation: body.designation || 'Mechanic',
      department: body.department || '', employeeCode: body.employeeCode || '', email: body.email || '', joiningDate: body.joiningDate, status: body.status } });
  };
  fn.calls = calls;
  return fn;
}

/** The page, with elements that remember attributes, classes and focus. */
function page({ origin = 'http://localhost:8787', fetch } = {}) {
  const focused = [], stored = [];
  const h = boot({
    origin, fetch, modules: ['js/staff-form.js', 'js/staff-add.js'],
    beforeModules(doc, ctx) {
      const get = doc.getElementById.bind(doc);
      doc.getElementById = id => {
        const el = get(id);
        if (!el._attrs) {
          el._attrs = {};
          el.setAttribute = (k, v) => { el._attrs[k] = String(v); };
          el.removeAttribute = k => { delete el._attrs[k]; };
          const classes = new Set();
          el.classList = { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle() {} };
          el.focus = () => focused.push(id);
          // The page as served: hidden extras, a disabled form, the default choices.
          if (/^(saSpec|saDesignationOther|saDepartmentOther)-field$/.test(id) || id === 'saAlert') el.hidden = true;
          if (id === 'saFields' || id === 'saSave') el.disabled = true;
          if (id === 'saTypeStaff') el.checked = true;
          if (id === 'saTypeMechanic') el.checked = false;
          if (id === 'saStatus') el.value = 'Active';
          if (id === 'saSave') el.textContent = 'Save Staff';
        }
        return el;
      };
      ctx.location.href = 'http://localhost/pages/staff-add.html';
      // Every browser-storage write, to prove no staff data goes there.
      const set = ctx.localStorage.setItem;
      ctx.localStorage.setItem = (k, v) => { stored.push([k, String(v)]); set(k, v); };
      ctx.sessionStorage = { getItem: () => null, setItem: (k, v) => stored.push([k, String(v)]), removeItem() {} };
    },
  });
  vm.runInContext('globalThis.StaffAdd = StaffAdd; globalThis.StaffForm = StaffForm;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, A: h.ctx.StaffAdd, focused, stored };
}

const fill = (el, values) => { for (const [id, v] of Object.entries(values)) el(id).value = v; };
const errOf = (el, id) => el(`${id}-err`).textContent;
const GOOD = { saName: '  Nadia   Akter ', saPhone: '01911-000101', saEmail: 'nadia@example.com', saJoined: '2026-10-01', saCode: 'TQ-101',
  saAddress: 'Mirpur 10', saNotes: 'Day shift' };
const choose = (el, id, value) => { el(id).value = value; el(id).dispatch('change', { target: el(id) }); };
const posts = f => f.calls.filter(c => c.method === 'POST' && c.path === '/staff');
const leaked = stored => stored.filter(([k, v]) => /staff/i.test(k) || /Nadia|01911-000101|Jamal|01822/.test(v));

(async () => {
console.log('=== staff-add: Add Staff ===\n');

/* ---------- 1. no backend, signed out ---------- */
console.log('-- 1. no backend, signed out --');
{
  const { h, el, A, stored } = page({ origin: '' });
  h.fireReady();
  await tick(40);
  ok('no backend: the form and Save Staff stay disabled', el('saFields').disabled === true && el('saSave').disabled === true, '');
  ok('   ...and the page says it needs the workshop database, and that nothing is saved in the browser instead',
    el('saAlert').hidden === false && /Add Staff needs the workshop database/.test(el('saAlert').innerHTML) && /Nothing is saved in this browser instead/.test(el('saAlert').innerHTML), el('saAlert').innerHTML);
  fill(el, GOOD);
  el('saDesignation').value = 'Accountant'; el('saDepartment').value = 'Accounts';
  await A.submit({ preventDefault() {} });
  ok('   ...pressing Save Staff anyway saves nothing anywhere: no staff in browser storage', h.ctx.localStorage.getItem('taqwa_staff') === null && leaked(stored).length === 0, JSON.stringify(leaked(stored)));
  ok('   ...and the page does not move', h.ctx.location.href === 'http://localhost/pages/staff-add.html', h.ctx.location.href);
}
{
  const f = api({ authenticated: false });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  ok('signed out: the form stays disabled under the sign-in screen', el('saFields').disabled === true && el('saSave').disabled === true, '');
  ok('   ...and nothing is sent to /staff', !f.calls.some(c => c.path.startsWith('/staff')), '');
}

/* ---------- 2. connected ---------- */
console.log('\n-- 2. connected --');
{
  const f = api();
  const { h, el, focused } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  ok('the form and Save Staff are enabled once the database answers', el('saFields').disabled === false && el('saSave').disabled === false, '');
  ok('   ...with no message showing', el('saAlert').hidden === true, '');
  const designations = [...el('saDesignation').innerHTML.matchAll(/<option value="([^"]*)">/g)].map(m => m[1]);
  ok('the designation list offers every requested designation, plus Other',
    ['Mechanic', 'Technician', 'Electrician', 'Service Advisor', 'Receptionist', 'Accountant', 'Storekeeper', 'Office Assistant', '__other']
      .every(d => designations.includes(d)) && designations[0] === '', JSON.stringify(designations));
  ok('the department list offers the workshop\'s departments, plus Other',
    ['Workshop', 'Front Desk', 'Accounts', 'Stores', 'Management', 'Administration', '__other'].every(d => el('saDepartment').innerHTML.includes(`value="${d}"`)), '');
  check('the joining date cannot be after today or before 1980', [el('saJoined')._attrs.max, el('saJoined')._attrs.min], [h.ctx.Utils.todayStr(), '1980-01-01']);
  ok('specializations already in use are suggested for a mechanic', /<option value="Engine">/.test(el('saSpecs').innerHTML), '');
  check('Full name has the focus', focused[focused.length - 1], 'saName');
  ok('nothing is written by opening the page', !f.calls.some(c => c.method && c.method !== 'GET'), '');
}

/* ---------- 3. the browser's checks ---------- */
console.log('\n-- 3. the browser\'s checks --');
{
  const f = api();
  const { h, el, A, focused } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  await A.submit({ preventDefault() {} });
  check('an empty form names every required field and sends nothing',
    [errOf(el, 'saName'), errOf(el, 'saPhone'), errOf(el, 'saDesignation'), errOf(el, 'saDepartment'), errOf(el, 'saJoined'), posts(f).length],
    ['Full name is required.', 'Phone is required.', 'Designation is required.', 'Department is required.', 'Joining date is required.', 0]);
  ok('   ...marks those fields invalid for assistive technology', ['saName', 'saPhone', 'saDesignation', 'saDepartment', 'saJoined'].every(id => el(id)._attrs['aria-invalid'] === 'true')
    && !el('saEmail')._attrs['aria-invalid'], '');
  ok('   ...and red', el('saName-field').classList.contains('field--error'), '');
  check('   ...focuses the first of them', focused[focused.length - 1], 'saName');
  ok('   ...and says so at the top: nothing saved, values kept', el('saAlert').hidden === false && /Please correct 5 fields/.test(el('saAlert').innerHTML)
    && /Nothing was saved/.test(el('saAlert').innerHTML), el('saAlert').innerHTML);
  el('saName').value = 'Nadia';
  el('saName').dispatch('input', { target: el('saName') });
  ok('a field loses its message as soon as it is changed', errOf(el, 'saName') === '' && !el('saName')._attrs['aria-invalid'], '');

  fill(el, { ...GOOD, saPhone: 'call me', saEmail: 'x@', saCode: 'TQ 1', saJoined: '2999-01-01' });
  choose(el, 'saDesignation', 'Accountant');
  await A.submit({ preventDefault() {} });
  check('bad formats are caught before sending: phone, email, employee code, a future joining date',
    [!!errOf(el, 'saPhone'), !!errOf(el, 'saEmail'), !!errOf(el, 'saCode'), errOf(el, 'saJoined'), posts(f).length],
    [true, true, true, 'Joining date cannot be in the future.', 0]);
}
{
  const f = api();
  const { h, el, A } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  choose(el, 'saDesignation', 'Accountant');
  check('choosing a designation suggests its department', el('saDepartment').value, 'Accounts');
  choose(el, 'saDesignation', 'Storekeeper');
  check('   ...and follows a new designation while the department was only suggested', el('saDepartment').value, 'Stores');
  choose(el, 'saDepartment', 'Front Desk');
  choose(el, 'saDesignation', 'Electrician');
  check('   ...but never overrides a department chosen by hand', el('saDepartment').value, 'Front Desk');

  choose(el, 'saDesignation', A.OTHER);
  ok('"Other" designation shows a box to type it in', el('saDesignationOther-field').hidden === false, '');
  fill(el, GOOD);
  await A.submit({ preventDefault() {} });
  ok('   ...an empty box is caught, with the message on the box', /Designation is required/.test(errOf(el, 'saDesignationOther')) && posts(f).length === 0, errOf(el, 'saDesignationOther'));
  el('saDesignationOther').value = '<b>Driver</b>';
  await A.submit({ preventDefault() {} });
  ok('   ...markup is refused before sending', /Use letters, digits/.test(errOf(el, 'saDesignationOther')) && posts(f).length === 0, '');
  el('saDesignationOther').value = 'Driver';
  await A.submit({ preventDefault() {} });
  await tick(20);
  check('   ...and the typed designation is what is sent', posts(f).map(c => [c.body.designation, c.body.department]), [['Driver', 'Front Desk']]);
  choose(el, 'saDesignation', 'Accountant');
  ok('choosing a listed designation again hides the box', el('saDesignationOther-field').hidden === true, '');
}

/* ---------- 4. saving a non-mechanic ---------- */
console.log('\n-- 4. saving someone who is not a mechanic --');
{
  let release;
  const gate = new Promise(r => { release = r; });
  const f = api({
    answer: async body => { await gate; return { status: 201, data: { id: 'STF-0004', isMechanic: false, name: body.name, status: 'Active' } }; },
  });
  const { h, el, A, stored } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  fill(el, GOOD);
  choose(el, 'saDesignation', 'Receptionist');
  const first = A.submit({ preventDefault() {} });
  await tick(10);
  ok('while saving: Save Staff is disabled and says Saving…, and the status line says so',
    el('saSave').disabled === true && el('saSave').textContent === 'Saving…' && el('saStatus').textContent === 'Saving…', el('saSave').textContent);
  let cancelled = false;
  el('saCancel').dispatch('click', { preventDefault: () => { cancelled = true; } });
  ok('   ...Cancel waits for the answer instead of leaving mid-save', cancelled, '');
  // Not awaited before the answer is released: a second save in flight would wait on it too.
  const second = A.submit({ preventDefault() {} });
  el('saForm').dispatch('submit', { preventDefault() {} });
  release();
  await Promise.all([first, second]);
  await tick(20);
  check('a second and third press while saving send nothing: one POST', posts(f).length, 1);
  const body = posts(f)[0].body;
  check('exactly the staff fields are sent, trimmed, with isMechanic: false', Object.keys(body).sort(),
    ['address', 'department', 'designation', 'email', 'employeeCode', 'isMechanic', 'joiningDate', 'name', 'notes', 'phone', 'status']);
  check('   ...with the values as typed (a name\'s extra spaces collapsed)',
    [body.name, body.phone, body.designation, body.department, body.joiningDate, body.status, body.isMechanic, body.employeeCode],
    ['Nadia Akter', '01911-000101', 'Receptionist', 'Front Desk', '2026-10-01', 'Active', false, 'TQ-101']);
  ok('   ...never an id, pay, a password or a specialization', !/"id"|salary|commission|password|specialization|mechanicId/i.test(JSON.stringify(body)), JSON.stringify(body));
  check('on success the browser goes to the Staff List, naming the id the database gave', h.ctx.location.href, 'staff-list.html?added=STF-0004');
  ok('   ...the form is locked meanwhile, so nothing more can be sent', el('saFields').disabled === true && h.ctx.StaffAdd.state.done === true, '');
  await A.submit({ preventDefault() {} });
  check('   ...pressing Save again after success sends nothing', posts(f).length, 1);
  ok('nothing about the staff member is kept in browser storage (local or session)', h.ctx.localStorage.getItem('taqwa_staff') === null
    && leaked(stored).length === 0, JSON.stringify(leaked(stored)));
}
{
  const f = api();
  const { h, el, A } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  fill(el, { saName: 'Rahim', saPhone: '01700-000001', saJoined: '2026-01-15' });
  choose(el, 'saDesignation', 'Office Assistant');
  el('saStatus').value = 'Inactive';
  await A.submit({ preventDefault() {} });
  await tick(20);
  const b = posts(f)[0].body;
  check('optional fields may stay empty; Inactive is sent as chosen', [b.email, b.employeeCode, b.address, b.notes, b.status, b.department],
    ['', '', '', '', 'Inactive', 'Administration']);
}

/* ---------- 5. saving a mechanic ---------- */
console.log('\n-- 5. saving a mechanic --');
{
  const f = api();
  const { h, el, A } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  el('saTypeStaff').checked = false; el('saTypeMechanic').checked = true;
  el('saTypeMechanic').dispatch('change', { target: el('saTypeMechanic') });
  ok('choosing Mechanic shows Specialization', el('saSpec-field').hidden === false && el('saSpec')._attrs.required === '', '');
  check('   ...and fills in the designation Mechanic and the Workshop department', [el('saDesignation').value, el('saDepartment').value], ['Mechanic', 'Workshop']);
  ok('   ...designation and department are no longer required', el('saDesignation')._attrs.required === undefined && el('saDepartment')._attrs.required === undefined, '');
  fill(el, { saName: 'Jamal', saPhone: '01822-222222', saJoined: '2026-09-01' });
  await A.submit({ preventDefault() {} });
  check('   ...a mechanic without a specialization is caught', [errOf(el, 'saSpec'), posts(f).length], ['Specialization is required.', 0]);
  el('saSpec').value = 'AC';
  await A.submit({ preventDefault() {} });
  await tick(20);
  const b = posts(f)[0] && posts(f)[0].body;
  check('a mechanic is sent with isMechanic: true and the specialization', [b.isMechanic, b.specialization, b.designation, b.department], [true, 'AC', 'Mechanic', 'Workshop']);
  ok('   ...still never with pay', !/salary|commission/i.test(JSON.stringify(b)), '');
  check('   ...and the Staff List opens on the Mechanics record the Worker created', h.ctx.location.href, 'staff-list.html?added=MEC-0002');
}
{
  const f = api();
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  const toMech = on => { el('saTypeStaff').checked = !on; el('saTypeMechanic').checked = on; el(on ? 'saTypeMechanic' : 'saTypeStaff').dispatch('change', {}); };
  toMech(true);
  toMech(false);
  check('switching back to other staff clears what Mechanic filled in, and hides Specialization',
    [el('saDesignation').value, el('saDepartment').value, el('saSpec-field').hidden], ['', '', true]);
  choose(el, 'saDesignation', 'Accountant');
  toMech(true);
  check('   ...but never replaces a designation chosen by hand', el('saDesignation').value, 'Accountant');
}

/* ---------- 6. refusals and failures ---------- */
console.log('\n-- 6. refusals and failures --');
async function attempt(answer, { mechanic = false } = {}) {
  const f = api({ answer });
  const p = page({ fetch: f });
  p.h.fireReady();
  await tick(80);
  fill(p.el, GOOD);
  choose(p.el, 'saDesignation', 'Accountant');
  if (mechanic) { p.el('saTypeStaff').checked = false; p.el('saTypeMechanic').checked = true; p.el('saTypeMechanic').dispatch('change', {}); p.el('saSpec').value = 'Engine'; }
  await p.A.submit({ preventDefault() {} });
  await tick(20);
  const kept = Object.entries(GOOD).every(([id, v]) => p.el(id).value === v) && p.el('saDesignation').value === 'Accountant';
  return { ...p, f, kept, alert: p.el('saAlert').innerHTML, stayed: p.h.ctx.location.href === 'http://localhost/pages/staff-add.html',
    again: p.el('saSave').disabled === false && p.el('saSave').textContent === 'Save Staff' };
}
{
  const r = await attempt(() => ({ status: 409, error: { code: 'conflict', message: 'A staff member with this phone number already exists.',
    conflictsWith: 'MEC-0001', field: 'phone', fields: { phone: 'A staff member with this phone number already exists. (MEC-0001)' } } }));
  check('a duplicate phone (409): the message is on Phone, naming the existing record', errOf(r.el, 'saPhone'), 'A staff member with this phone number already exists. (MEC-0001)');
  ok('   ...and at the top, with the existing id and "nothing was saved"', /already exists\. \(MEC-0001\)/.test(r.alert) && /Nothing was saved/.test(r.alert), r.alert);
  ok('   ...Phone is marked invalid and focused', r.el('saPhone')._attrs['aria-invalid'] === 'true' && r.focused[r.focused.length - 1] === 'saPhone', JSON.stringify(r.focused));
  ok('   ...every value stays in the form', r.kept, '');
  ok('   ...Save Staff works again, and the page does not move', r.again && r.stayed, '');
}
{
  const r = await attempt(() => ({ status: 409, error: { code: 'conflict', message: 'That employee code is already used by another staff member.',
    conflictsWith: 'STF-0001', field: 'employeeCode', fields: { employeeCode: 'That employee code is already used by another staff member. (STF-0001)' } } }));
  check('a reused employee code (409): the message is on Employee code', errOf(r.el, 'saCode'), 'That employee code is already used by another staff member. (STF-0001)');
  ok('   ...values kept, Save works again, page stays', r.kept && r.again && r.stayed, '');
}
{
  const r = await attempt(() => ({ status: 422, error: { code: 'validation_failed', message: 'Some staff fields are not valid.',
    fields: { email: 'Enter a valid email address.', salary: 'Pay is managed on the Mechanics page, not in the staff list.' } } }));
  check('a 422 puts the Worker\'s message on the field', errOf(r.el, 'saEmail'), 'Enter a valid email address.');
  ok('   ...and a refused property with no field of its own is listed at the top', /Some staff fields are not valid/.test(r.alert) && /salary: Pay is managed on the Mechanics page/.test(r.alert), r.alert);
  ok('   ...values kept, Save works again, page stays', r.kept && r.again && r.stayed, '');
}
{
  const r = await attempt(() => ({ status: 401, error: { code: 'unauthorized', message: 'Authentication required.' } }));
  ok('an ended session (401): says so, and that nothing was saved', /Your session has ended, so nothing was saved/.test(r.alert) && /still here/.test(r.alert), r.alert);
  ok('   ...values kept, Save works again, page stays (no reload that would lose them)', r.kept && r.again && r.stayed, '');
}
{
  const r = await attempt(() => ({ throw: Object.assign(new Error('aborted'), { name: 'AbortError' }) }));
  ok('a timeout: says the save may or may not have landed, and to check the Staff List first', /took too long/.test(r.alert) && /may or may not have been saved/.test(r.alert) && /Check the Staff List/.test(r.alert), r.alert);
  ok('   ...values kept, Save works again, page stays', r.kept && r.again && r.stayed, '');
}
{
  const r = await attempt(() => ({ throw: new TypeError('Failed to fetch') }));
  ok('no network: says nothing was saved and to try again', /Could not reach the workshop database, so nothing was saved/.test(r.alert), r.alert);
  ok('   ...values kept, Save works again, page stays', r.kept && r.again && r.stayed, '');
}
{
  const r = await attempt(() => ({ status: 500, error: { code: 'database_error', message: 'Could not create the staff member.' } }), { mechanic: true });
  ok('a server error: the Worker\'s message, and nothing saved', /Could not create the staff member/.test(r.alert) && /Nothing was saved/.test(r.alert), r.alert);
  ok('   ...values kept (a mechanic\'s specialization too), Save works again, page stays', r.kept && r.el('saSpec').value === 'Engine' && r.again && r.stayed, '');
  ok('   ...the message is escaped', !/<script/.test(r.alert), '');
}
{
  const r = await attempt(() => ({ status: 409, error: { code: 'conflict', message: '<img src=x onerror=alert(1)>', conflictsWith: 'STF-0001' } }));
  ok('a message from the server is shown as text, never markup', !/<img/.test(r.alert) && /&lt;img/.test(r.alert), r.alert);
}

process.exit(summary('staff-add') === 0 ? 0 : 1);
})();
