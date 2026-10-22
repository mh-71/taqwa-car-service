/* Staff (0008) — unit tests against the REAL Worker handlers: /api/staff.

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0008), through the same minimal D1-shaped wrapper the
   follow-up suites use, so the rules are exercised as SQL rather than
   described.

   What must hold:
     A. Schema: the table, its CHECKs, the case-insensitive employee-code
        index, the cascade from mechanics, the STF counter; re-runnable.
     B. List: every mechanic (with or without a profile) and every other
        employee, one shape, sorted by name; never any pay field; search
        (name, id, code, email, phone digits) and the status / department /
        designation filters; limit / offset with a total; bad parameters 400.
     C. Create (not a mechanic): required fields, formats, joining-date range,
        pay refused, duplicate employee code (any case) and active phone 409.
     D. Create a mechanic: one mechanics row (the Mechanics route's rules)
        plus its profile, under ONE MEC id that /api/mechanics also returns.
     E. Detail, F. Update: merge, deactivate / reactivate, profile upsert for a
        mechanic, the type is fixed, blank required fields refused.
     G. Compatibility: the Mechanics API, pay, job cards and the delete guard
        all behave as before.
     H. Security: 401 before any statement, no DELETE (405), safe 500.
   Needs node:sqlite (Node 22.5+); says SKIPPED without it. */
import worker from '../../src/index.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}`);
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

const TEST_TOKEN = 'unit-test-token';
const call = (path, env, method, body, auth = true) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method,
    headers: auth ? { authorization: `Bearer ${TEST_TOKEN}` } : {},
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { API_TOKEN: TEST_TOKEN, ...env });

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }

if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version; nothing was checked.');
  console.log(`\nStaff unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-10-08T00:00:00Z';
const MIGRATIONS = ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql',
  '0004_job_card_discount_rate.sql', '0005_customer_follow_ups.sql', '0006_follow_up_tasks.sql',
  '0007_estimates.sql', '0008_staff.sql'];

/** The smallest D1-shaped wrapper the handlers need: prepare/bind/first/all/run/batch. */
function makeD1() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of MIGRATIONS) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const clean = (a) => a.map((x) => (x === undefined ? null : x));
  const statements = [];
  class Stmt {
    constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
    bind(...a) { return new Stmt(this.sql, clean(a)); }
    exec() {
      statements.push(this.sql);
      const s = raw.prepare(this.sql);
      if (returnsRows(this.sql)) { const r = s.all(...this.binds); return { results: r, meta: { changes: r.length } }; }
      const r = s.run(...this.binds);
      return { results: [], meta: { changes: Number(r.changes) } };
    }
    async first(col) {
      if (/\bRETURNING\b/i.test(this.sql)) { const r = this.exec().results[0] ?? null; return r && col ? r[col] : r; }
      statements.push(this.sql);
      const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r;
    }
    async all() { statements.push(this.sql); return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
    async run() { return this.exec(); }
  }
  return {
    raw,
    statements,
    prepare: (sql) => new Stmt(sql),
    async batch(list) {
      raw.exec('BEGIN');
      try { const out = list.map((s) => s.exec()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}

function fresh() {
  const DB = makeD1();
  DB.raw.exec(`
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'Rahim', '01700000001', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'R1', 'Toyota', 'Corolla', '${AT}');
    INSERT INTO mechanics (id, name, phone, email, specialization, joining_date, salary, commission_rate, created_at)
      VALUES ('MEC-0001', 'Jamal', '01800-000001', 'jamal@example.com', 'Engine', '2023-01-10', 25000, 5, '${AT}');
    INSERT INTO mechanics (id, name, phone, specialization, created_at) VALUES ('MEC-0002', 'Kamal', '01800000002', 'AC', '${AT}');
    INSERT INTO mechanics (id, name, phone, status, created_at) VALUES ('MEC-0003', 'Left', '01800000003', 'Inactive', '${AT}');
    UPDATE id_counters SET last_value = 3 WHERE collection = 'mechanics';
    INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, date, complaint, created_at) VALUES ('JOB-0001', 'CUS-0001', 'VEH-0001', 'MEC-0001', '2026-10-01', 'Noise', '${AT}');
    INSERT INTO services (id, name, price, created_at) VALUES ('SRV-0001', 'Brake service', 1200, '${AT}');
    INSERT INTO appointments (id, customer_id, vehicle_id, service_id, mechanic_id, date, time, created_at) VALUES ('APT-0001', 'CUS-0001', 'VEH-0001', 'SRV-0001', 'MEC-0002', '2026-10-09', '10:00', '${AT}');`);
  const env = { DB };
  const api = async (method, path, body, auth = true) => {
    const res = await call(path, env, method, body, auth);
    return { status: res.status, allow: res.headers.get('allow'), body: await res.json().catch(() => null) };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  return { DB, env, api, one };
}

const GOOD = (extra = {}) => ({
  name: 'Nadia Akter', phone: '01911-000001', email: 'nadia@example.com', designation: 'Accountant',
  department: 'Accounts', employeeCode: 'TQ-101', joiningDate: '2024-03-01', ...extra,
});
const fields = (r) => Object.keys(r.body?.error?.fields ?? {}).sort();
const ids = (r) => (r.body?.data ?? []).map((s) => s.id);
const PAY = /salary|commission/i;

console.log('=== Staff (0008) against an in-memory database ===');

/* ---------- A. schema ---------- */
console.log('\n-- A. schema --');
{
  const h = fresh();
  const cols = h.DB.raw.prepare('PRAGMA table_info(staff)').all().map((c) => c.name);
  check('staff has the designed columns', cols, ['id', 'mechanic_id', 'employee_code', 'designation', 'department', 'name',
    'phone', 'email', 'address', 'joining_date', 'status', 'notes', 'created_at', 'updated_at']);
  ok_('   ...and no pay column', !cols.some((c) => PAY.test(c)), cols.join(','));
  check('mechanic_id -> mechanics ON DELETE CASCADE', h.DB.raw.prepare('PRAGMA foreign_key_list(staff)').all().map((f) => [f.from, f.table, f.on_delete]),
    [['mechanic_id', 'mechanics', 'CASCADE']]);
  check('counter STF starts at 0', h.one(`SELECT prefix, last_value FROM id_counters WHERE collection = 'staff'`), { prefix: 'STF', last_value: 0 });
  let k = 0;
  const tryIns = (cols2, vals) => { k++; try { h.DB.raw.exec(`INSERT INTO staff (id, ${cols2}, created_at) VALUES ('STF-9${k}', ${vals}, '${AT}')`); return 'ok'; } catch (e) { return /CHECK|UNIQUE|FOREIGN/.exec(e.message)?.[0] ?? e.message; } };
  check('CHECK: an employee who is not a mechanic needs name, phone, status, designation, department',
    tryIns('name, phone, status, designation', `'A', '1', 'Active', 'Clerk'`), 'CHECK');
  check('CHECK: status allow-list', tryIns('name, phone, status, designation, department', `'A', '1', 'Gone', 'Clerk', 'Front'`), 'CHECK');
  check('a complete row is accepted', tryIns('name, phone, status, designation, department, employee_code', `'A', '1', 'Active', 'Clerk', 'Front', 'ab-1'`), 'ok');
  check('UNIQUE: employee code ignores case', tryIns('name, phone, status, designation, department, employee_code', `'B', '2', 'Active', 'Clerk', 'Front', 'AB-1'`), 'UNIQUE');
  let profile = 'ok';
  try { h.DB.raw.exec(`INSERT INTO staff (id, mechanic_id, name, created_at) VALUES ('MEC-0002', 'MEC-0002', 'Copy', '${AT}')`); } catch (e) { profile = /CHECK/.test(e.message) ? 'CHECK' : e.message; }
  check('CHECK: a mechanic profile cannot carry a copy of the person', profile, 'CHECK');
  let mismatch = 'ok';
  try { h.DB.raw.exec(`INSERT INTO staff (id, mechanic_id, created_at) VALUES ('STF-0500', 'MEC-0002', '${AT}')`); } catch (e) { mismatch = /CHECK/.test(e.message) ? 'CHECK' : e.message; }
  check('CHECK: a profile carries its mechanic id as its own', mismatch, 'CHECK');
  let rerun = 'ok';
  try { h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0008_staff.sql'), 'utf8')); } catch (e) { rerun = e.message; }
  check('0008 can be re-run without error', rerun, 'ok');
  check('   ...and leaves existing rows alone', h.one('SELECT count(*) AS n FROM staff').n, 1);
  check('0008 touched no existing table: mechanics still has its columns', h.DB.raw.prepare('PRAGMA table_info(mechanics)').all().length, 18);
}

/* ---------- B. list ---------- */
console.log('\n-- B. list --');
{
  const h = fresh();
  const empty = await h.api('GET', '/api/staff');
  check('with only mechanics, every mechanic is listed (no profile needed), sorted by name', [empty.status, ids(empty)], [200, ['MEC-0001', 'MEC-0002', 'MEC-0003']]);
  check('   ...as mechanics, designation Mechanic, no department or code yet',
    empty.body.data.map((s) => [s.isMechanic, s.designation, s.department, s.employeeCode]),
    [[true, 'Mechanic', '', ''], [true, 'Mechanic', '', ''], [true, 'Mechanic', '', '']]);
  check('   ...meta has count / total / limit / offset', [empty.body.count, empty.body.total, empty.body.limit, empty.body.offset], [3, 3, 500, 0]);
  ok_('   ...no pay field anywhere in the response', !PAY.test(JSON.stringify(empty.body)), JSON.stringify(empty.body).slice(0, 200));

  await h.api('POST', '/api/staff', GOOD());
  await h.api('POST', '/api/staff', GOOD({ name: 'Bashir', phone: '01911000002', email: '', employeeCode: 'TQ-102', designation: 'Service Advisor', department: 'Front Desk' }));
  await h.api('PUT', '/api/staff/MEC-0002', { employeeCode: 'TQ-007', department: 'Workshop', designation: 'Senior Mechanic' });
  const all = await h.api('GET', '/api/staff');
  check('every employee, one list, sorted by name', ids(all), ['MEC-0002', 'MEC-0001', 'MEC-0003', 'STF-0002', 'STF-0001'].sort((a, b) => {
    const n = { 'MEC-0001': 'Jamal', 'MEC-0002': 'Kamal', 'MEC-0003': 'Left', 'STF-0001': 'Nadia Akter', 'STF-0002': 'Bashir' };
    return n[a].localeCompare(n[b]);
  }));
  check('   ...a profiled mechanic shows its profile', all.body.data.find((s) => s.id === 'MEC-0002'),
    { id: 'MEC-0002', isMechanic: true, employeeCode: 'TQ-007', name: 'Kamal', designation: 'Senior Mechanic', department: 'Workshop',
      phone: '01800000002', email: '', joiningDate: '', status: 'Active', createdAt: AT, updatedAt: all.body.data.find((s) => s.id === 'MEC-0002').updatedAt });
  const q = async (qs) => ids(await h.api('GET', `/api/staff?${qs}`));
  check('search: name, any case', await q('q=nADIA'), ['STF-0001']);
  check('search: employee code', await q('q=tq-007'), ['MEC-0002']);
  check('search: id', await q('q=mec-0003'), ['MEC-0003']);
  check('search: email', await q('q=jamal%40example'), ['MEC-0001']);
  check('search: phone digits ignore separators', await q('q=018-0000-0001'), ['MEC-0001']);
  check('search: nothing matches', await q('q=zzz'), []);
  check('filter: status', await q('status=Inactive'), ['MEC-0003']);
  check('filter: department (any case)', await q('department=front%20desk'), ['STF-0002']);
  check('filter: designation, including the Mechanic fallback', await q('designation=Mechanic'), ['MEC-0001', 'MEC-0003']);
  check('filters combine', await q('designation=Mechanic&status=Active'), ['MEC-0001']);
  const page = await h.api('GET', '/api/staff?limit=2&offset=2');
  check('paging: limit/offset with the full total', [page.body.data.length, page.body.total, page.body.offset], [2, 5, 2]);
  const filteredTotal = await h.api('GET', '/api/staff?status=Active&limit=1');
  check('   ...total counts the filtered set', filteredTotal.body.total, 4);
  for (const [qs, why] of [['limit=0', 'limit 0'], ['limit=5000', 'limit too big'], ['offset=-1', 'negative offset'],
    ['status=active', 'status is case-sensitive'], [`q=${'x'.repeat(101)}`, 'search too long']]) {
    check(`bad parameter (${why}) -> 400`, (await h.api('GET', `/api/staff?${qs}`)).status, 400);
  }
}

/* ---------- C. create (not a mechanic) ---------- */
console.log('\n-- C. create --');
{
  const h = fresh();
  const r = await h.api('POST', '/api/staff', GOOD({ address: 'Mirpur', notes: 'Day shift' }));
  check('create -> 201 with an STF id and the submitted fields', [r.status, r.body.data.id, r.body.data.isMechanic, r.body.data.name,
    r.body.data.employeeCode, r.body.data.designation, r.body.data.department, r.body.data.status, r.body.data.address, r.body.data.notes],
  [201, 'STF-0001', false, 'Nadia Akter', 'TQ-101', 'Accountant', 'Accounts', 'Active', 'Mirpur', 'Day shift']);
  check('   ...persisted: the row is in the table', h.one(`SELECT name, phone FROM staff WHERE id = 'STF-0001'`), { name: 'Nadia Akter', phone: '01911-000001' });
  check('   ...and no mechanic was created', h.one('SELECT count(*) AS n FROM mechanics').n, 3);
  const listed = await h.api('GET', '/api/staff?q=nadia');
  check('   ...and a later read (a page refresh) finds it', ids(listed), ['STF-0001']);

  const missing = await h.api('POST', '/api/staff', {});
  check('nothing sent -> 422 naming every required field', [missing.status, fields(missing)], [422, ['department', 'designation', 'name', 'phone']]);
  for (const [why, extra, want] of [
    ['blank name', { name: '   ' }, ['name']],
    ['bad phone', { phone: 'call me' }, ['phone']],
    ['bad email', { email: 'nadia@' }, ['email']],
    ['joining date in the future', { joiningDate: '2999-01-01' }, ['joiningDate']],
    ['joining date not a date', { joiningDate: '2024-02-30' }, ['joiningDate']],
    ['status outside the list', { status: 'Retired' }, ['status']],
    ['employee code with a space', { employeeCode: 'TQ 1' }, ['employeeCode']],
    ['employee code too long', { employeeCode: 'X'.repeat(21) }, ['employeeCode']],
    ['designation too long', { designation: 'D'.repeat(61) }, ['designation']],
    ['salary', { salary: 20000 }, ['salary']],
    ['commission', { commissionRate: 5 }, ['commissionRate']],
    ['isMechanic not a boolean', { isMechanic: 'yes' }, ['isMechanic']],
  ]) {
    const bad = await h.api('POST', '/api/staff', GOOD({ phone: '01700999999', employeeCode: 'NEW-1', ...extra }));
    check(`${why} -> 422 on ${want.join(', ')}`, [bad.status, fields(bad)], [422, want]);
  }
  const all = await h.api('POST', '/api/staff', { name: 'X', phone: '01700999998', salary: 1 });
  check('every problem is reported at once (missing fields and a pay field)', [all.status, fields(all)], [422, ['department', 'designation', 'salary']]);
  check('   ...none of the refused creates wrote a row', h.one('SELECT count(*) AS n FROM staff').n, 1);

  const dupCode = await h.api('POST', '/api/staff', GOOD({ phone: '01911000009', employeeCode: 'tq-101' }));
  check('duplicate employee code, any case -> 409 on employeeCode, naming the holder', [dupCode.status, dupCode.body.error.field, dupCode.body.error.conflictsWith], [409, 'employeeCode', 'STF-0001']);
  const dupPhone = await h.api('POST', '/api/staff', GOOD({ phone: '019-1100-0001', employeeCode: 'TQ-200' }));
  check('an active employee with the same phone digits -> 409 on phone', [dupPhone.status, dupPhone.body.error.field, dupPhone.body.error.conflictsWith], [409, 'phone', 'STF-0001']);
  const mechPhone = await h.api('POST', '/api/staff', GOOD({ phone: '01800000001', employeeCode: 'TQ-201' }));
  check('   ...an active MECHANIC with that phone also blocks it (one record per person)', [mechPhone.status, mechPhone.body.error.conflictsWith], [409, 'MEC-0001']);
  const inactivePhone = await h.api('POST', '/api/staff', GOOD({ name: 'New', phone: '01800000003', employeeCode: 'TQ-202' }));
  check('   ...an INACTIVE employee\'s old number does not block it', inactivePhone.status, 201);
  const noCode = await h.api('POST', '/api/staff', GOOD({ name: 'Helper', phone: '01700123456', employeeCode: '', email: '' }));
  check('employee code is optional, blank stored as nothing', [noCode.status, noCode.body.data.employeeCode, h.one(`SELECT employee_code, email FROM staff WHERE id = ?`, noCode.body.data.id)],
    [201, '', { employee_code: null, email: null }]);
  const two = await Promise.all([h.api('POST', '/api/staff', GOOD({ name: 'C1', phone: '01700000101', employeeCode: 'RACE-1' })),
    h.api('POST', '/api/staff', GOOD({ name: 'C2', phone: '01700000102', employeeCode: 'race-1' }))]);
  check('two creates racing for one code: one 201, one 409', two.map((x) => x.status).sort(), [201, 409]);
}

/* ---------- D. create a mechanic ---------- */
console.log('\n-- D. create a mechanic --');
{
  const h = fresh();
  const noSpec = await h.api('POST', '/api/staff', GOOD({ isMechanic: true }));
  check('a mechanic needs a specialization (the Mechanics route\'s own rule)', [noSpec.status, fields(noSpec)], [422, ['specialization']]);
  const r = await h.api('POST', '/api/staff', GOOD({ isMechanic: true, specialization: 'Electrical', designation: 'Auto Electrician', department: 'Workshop' }));
  check('create a mechanic -> 201 with the next MEC id', [r.status, r.body.data.id, r.body.data.isMechanic, r.body.data.designation, r.body.data.specialization],
    [201, 'MEC-0004', true, 'Auto Electrician', 'Electrical']);
  check('   ...one mechanics row holds the person', h.one(`SELECT name, phone, specialization, status FROM mechanics WHERE id = 'MEC-0004'`),
    { name: 'Nadia Akter', phone: '01911-000001', specialization: 'Electrical', status: 'Active' });
  check('   ...and the profile holds only the HR fields', h.one(`SELECT mechanic_id, employee_code, designation, department, name, phone FROM staff WHERE id = 'MEC-0004'`),
    { mechanic_id: 'MEC-0004', employee_code: 'TQ-101', designation: 'Auto Electrician', department: 'Workshop', name: null, phone: null });
  check('   ...no STF id was spent', h.one(`SELECT last_value FROM id_counters WHERE collection = 'staff'`).last_value, 0);
  const viaMechanics = await h.api('GET', '/api/mechanics/MEC-0004');
  check('   ...the Mechanics API returns the same person under the same id', [viaMechanics.status, viaMechanics.body.data.name, viaMechanics.body.data.salary], [200, 'Nadia Akter', null]);
  const bare = await h.api('POST', '/api/staff', { isMechanic: true, name: 'Bare', phone: '01700777777', specialization: 'Tyres' });
  check('a mechanic with no HR fields needs no profile row', [bare.status, bare.body.data.designation, h.one(`SELECT count(*) AS n FROM staff WHERE id = ?`, bare.body.data.id).n], [201, 'Mechanic', 0]);
  const pay = await h.api('POST', '/api/staff', { isMechanic: true, name: 'Paid', phone: '01700777778', specialization: 'Tyres', salary: 30000 });
  check('pay cannot be set through the staff API, even for a mechanic', [pay.status, fields(pay)], [422, ['salary']]);
}

/* ---------- E. detail ---------- */
console.log('\n-- E. detail --');
{
  const h = fresh();
  await h.api('POST', '/api/staff', GOOD({ address: 'Mirpur' }));
  const s = await h.api('GET', '/api/staff/STF-0001');
  check('an employee\'s detail adds address and notes', [s.status, s.body.data.address, s.body.data.notes, 'specialization' in s.body.data], [200, 'Mirpur', '', false]);
  const m = await h.api('GET', '/api/staff/MEC-0001');
  check('a mechanic\'s detail adds specialization, alt phone and employment type', [m.status, m.body.data.isMechanic, m.body.data.specialization, m.body.data.joiningDate],
    [200, true, 'Engine', '2023-01-10']);
  ok_('   ...and never pay, although this mechanic has a salary and commission', !PAY.test(JSON.stringify(m.body)), JSON.stringify(m.body));
  check('unknown id -> 404', (await h.api('GET', '/api/staff/STF-0999')).status, 404);
  check('malformed id -> 400', (await h.api('GET', '/api/staff/not%20an%20id')).status, 400);
}

/* ---------- F. update ---------- */
console.log('\n-- F. update --');
{
  const h = fresh();
  await h.api('POST', '/api/staff', GOOD());
  const u = await h.api('PUT', '/api/staff/STF-0001', { designation: 'Senior Accountant' });
  check('PUT merges: only the sent field changes', [u.status, u.body.data.designation, u.body.data.department, u.body.data.name, !!u.body.data.updatedAt],
    [200, 'Senior Accountant', 'Accounts', 'Nadia Akter', true]);
  const off = await h.api('PUT', '/api/staff/STF-0001', { status: 'Inactive' });
  check('deactivate -> Inactive, and the record is kept', [off.status, off.body.data.status, h.one(`SELECT status FROM staff WHERE id = 'STF-0001'`).status], [200, 'Inactive', 'Inactive']);
  await h.api('POST', '/api/staff', GOOD({ name: 'Replacement', employeeCode: 'TQ-300' }));
  const back = await h.api('PUT', '/api/staff/STF-0001', { status: 'Active' });
  check('reactivating while someone active now has the number -> 409 on phone', [back.status, back.body.error.field, back.body.error.conflictsWith], [409, 'phone', 'STF-0002']);
  for (const [why, body, want] of [
    ['blank name', { name: '' }, ['name']], ['blank phone', { phone: '' }, ['phone']], ['blank designation', { designation: ' ' }, ['designation']],
    ['blank status', { status: '' }, ['status']], ['type change', { isMechanic: true }, ['isMechanic']], ['salary', { salary: 1 }, ['salary']],
  ]) {
    const bad = await h.api('PUT', '/api/staff/STF-0001', body);
    check(`update with ${why} -> 422 on ${want.join(', ')}`, [bad.status, fields(bad)], [422, want]);
  }
  check('an empty update -> 422', (await h.api('PUT', '/api/staff/STF-0001', {})).status, 422);
  check('code taken by someone else -> 409', (await h.api('PUT', '/api/staff/STF-0001', { employeeCode: 'tq-300' })).status, 409);
  check('keeping your own code is fine', (await h.api('PUT', '/api/staff/STF-0001', { employeeCode: 'TQ-101', notes: 'x' })).status, 200);
  check('unknown id -> 404', (await h.api('PUT', '/api/staff/STF-0999', { notes: 'x' })).status, 404);

  // A mechanic: person fields go to the mechanics row, HR fields to the profile.
  const m = await h.api('PUT', '/api/staff/MEC-0001', { name: 'Jamal Uddin', employeeCode: 'TQ-001', department: 'Workshop' });
  check('editing a mechanic -> 200 with both halves', [m.status, m.body.data.name, m.body.data.employeeCode, m.body.data.department, m.body.data.designation],
    [200, 'Jamal Uddin', 'TQ-001', 'Workshop', 'Mechanic']);
  check('   ...the name changed on the mechanics row itself', h.one(`SELECT name FROM mechanics WHERE id = 'MEC-0001'`).name, 'Jamal Uddin');
  check('   ...a profile was created on first edit', h.one(`SELECT employee_code, department, name FROM staff WHERE id = 'MEC-0001'`),
    { employee_code: 'TQ-001', department: 'Workshop', name: null });
  const m2 = await h.api('PUT', '/api/staff/MEC-0001', { designation: 'Head Mechanic' });
  check('   ...a second edit updates the same profile', [m2.body.data.designation, m2.body.data.employeeCode, h.one(`SELECT count(*) AS n FROM staff WHERE mechanic_id = 'MEC-0001'`).n], ['Head Mechanic', 'TQ-001', 1]);
  check('   ...pay was not touched', h.one(`SELECT salary, commission_rate FROM mechanics WHERE id = 'MEC-0001'`), { salary: 25000, commission_rate: 5 });
  const mOff = await h.api('PUT', '/api/staff/MEC-0002', { status: 'Inactive' });
  check('deactivating a mechanic sets the mechanics row Inactive', [mOff.status, h.one(`SELECT status FROM mechanics WHERE id = 'MEC-0002'`).status], [200, 'Inactive']);
  check('   ...its appointment still names it', h.one(`SELECT mechanic_id FROM appointments WHERE id = 'APT-0001'`).mechanic_id, 'MEC-0002');
  check('a mechanic cannot become a non-mechanic', fields(await h.api('PUT', '/api/staff/MEC-0001', { isMechanic: false })), ['isMechanic']);
  check('a mechanic\'s blank name -> 422 on name', fields(await h.api('PUT', '/api/staff/MEC-0001', { name: '' })), ['name']);
  const clash = await h.api('PUT', '/api/staff/MEC-0001', { phone: '01911-000001' });
  check('a mechanic taking an active employee\'s phone -> 409', [clash.status, clash.body.error.conflictsWith], [409, 'STF-0002']);
}

/* ---------- G. compatibility ---------- */
console.log('\n-- G. compatibility with mechanics, job cards and appointments --');
{
  const h = fresh();
  const before = await h.api('GET', '/api/mechanics');
  await h.api('PUT', '/api/staff/MEC-0001', { employeeCode: 'TQ-001', designation: 'Head Mechanic' });
  const after = await h.api('GET', '/api/mechanics');
  check('the Mechanics list keeps its shape and ids', after.body.data.map((m) => [m.id, Object.keys(m).sort().join()]), before.body.data.map((m) => [m.id, Object.keys(m).sort().join()]));
  check('   ...and still carries pay for the Mechanics page', after.body.data.find((m) => m.id === 'MEC-0001').salary, 25000);
  const mechCreate = await h.api('POST', '/api/mechanics', { name: 'Via Mechanics', phone: '01700555555', specialization: 'Body' });
  check('a mechanic added on the Mechanics page appears in the Staff List at once', [mechCreate.status, ids(await h.api('GET', `/api/staff?q=${mechCreate.body.data.id}`))], [201, [mechCreate.body.data.id]]);
  const mechEdit = await h.api('PUT', '/api/mechanics/MEC-0001', { name: 'Renamed On Mechanics' });
  check('an edit on the Mechanics page shows in the Staff List (one record)', [mechEdit.status, (await h.api('GET', '/api/staff/MEC-0001')).body.data.name], [200, 'Renamed On Mechanics']);
  const guarded = await h.api('DELETE', '/api/mechanics/MEC-0001');
  check('a mechanic used by a job card still cannot be deleted', [guarded.status, h.one(`SELECT count(*) AS n FROM staff WHERE id = 'MEC-0001'`).n], [409, 1]);
  await h.api('PUT', '/api/staff/MEC-0002', { employeeCode: 'TQ-002' });
  check('a mechanic used by an appointment still cannot be deleted', (await h.api('DELETE', '/api/mechanics/MEC-0002')).status, 409);
  await h.api('PUT', '/api/staff/MEC-0003', { employeeCode: 'TQ-003' });
  const free = await h.api('DELETE', '/api/mechanics/MEC-0003');
  check('an unused mechanic deletes as before, and its profile goes with it', [free.status, h.one(`SELECT count(*) AS n FROM staff WHERE id = 'MEC-0003'`).n], [200, 0]);
  check('job cards and appointments still reference the same mechanic ids',
    [h.one(`SELECT mechanic_id FROM job_cards WHERE id = 'JOB-0001'`).mechanic_id, h.one(`SELECT mechanic_id FROM appointments WHERE id = 'APT-0001'`).mechanic_id], ['MEC-0001', 'MEC-0002']);
}

/* ---------- H. security and failure ---------- */
console.log('\n-- H. security and failure --');
{
  const h = fresh();
  h.DB.statements.length = 0;
  const open = [];
  for (const [m, p, b] of [['GET', '/api/staff'], ['GET', '/api/staff/MEC-0001'], ['POST', '/api/staff', GOOD()], ['PUT', '/api/staff/MEC-0001', { name: 'X' }]]) {
    const res = await h.api(m, p, b, false);
    if (res.status !== 401) open.push([m, p, res.status]);
  }
  check('every staff route refuses a caller with no credential (401)', open, []);
  check('   ...without reaching the database', h.DB.statements.length, 0);
  const del = await h.api('DELETE', '/api/staff/MEC-0001');
  check('there is no DELETE (deactivate instead) -> 405, Allow: GET, PUT', [del.status, del.allow], [405, 'GET, PUT']);
  const patch = await h.api('PATCH', '/api/staff');
  check('an unsupported method on the list -> 405, Allow: GET, POST', [patch.status, patch.allow], [405, 'GET, POST']);
  check('a body that is not JSON -> 400', (await h.api('POST', '/api/staff', '{nope')).status, 400);

  const broken = { DB: { prepare: () => { throw new Error('D1_ERROR: no such table: staff'); } } };
  for (const [m, p, b] of [['GET', '/api/staff'], ['GET', '/api/staff/STF-0001'], ['POST', '/api/staff', GOOD()], ['PUT', '/api/staff/STF-0001', { notes: 'x' }]]) {
    const res = await call(p, broken, m, b);
    const text = await res.text();
    check(`${m} ${p} with a failing database -> 500 database_error`, [res.status, JSON.parse(text).error.code], [500, 'database_error']);
    ok_('   ...and the SQL error text is not sent', !/no such table|D1_ERROR|SELECT|staff s/i.test(text.replace('"database_error"', '')), text);
  }
}

console.log(`\nStaff unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
