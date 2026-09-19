/* GET /api/mechanics and /api/mechanics/:id — unit tests against the REAL
   Worker handler with a stubbed D1 binding.

   Mechanics is the first collection whose sensitive columns (salary,
   commission_rate) are nullable numbers, so the NULL-versus-zero rule gets
   more attention here than in the other suites: for payroll, "nobody
   recorded this" and "zero" are not the same claim. */
import worker from '../../src/index.js';

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

function stubDB({ rows = [], total = null, throwOn = null }) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const entry = { sql, binds: null };
      calls.push(entry);
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async all() {
          if (throwOn && sql.includes(throwOn)) throw new Error('D1_ERROR: simulated failure');
          return { results: rows };
        },
        async first() {
          if (throwOn && sql.includes(throwOn)) throw new Error('D1_ERROR: simulated failure');
          if (sql.includes('count(*)')) return { n: total === null ? rows.length : total };
          if (sql.includes('WHERE id =') && entry.binds) {
            return rows.find((r) => r.id === entry.binds[0]) ?? null;
          }
          return rows[0] ?? null;
        },
      };
      return stmt;
    },
  };
}
/* C-12 protects reads as well as writes, so every call here carries the same
   machine credential the write suites use. These suites are about what a route
   RETURNS, not about the gate -- the gate has its own suite (api-auth). */
const TEST_TOKEN = 'unit-test-token';
const withAuth = (init = {}) => ({
  ...init,
  headers: { authorization: `Bearer ${TEST_TOKEN}`, ...(init.headers || {}) },
});
const call = (path, env, init) =>
  worker.fetch(new Request('http://worker.local' + path, withAuth(init)),
               { API_TOKEN: TEST_TOKEN, ...env });

/* Modelled on seed-data.js: one fully populated, one sparse. The sparse row
   deliberately leaves every nullable column NULL, including the three
   numbers, so the zero-versus-null rule is exercised on all of them. */
const SEEDED = [
  { id: 'MEC-0002', name: 'Sohel Rana', phone: '01888-222333',
    alt_phone: '01888-999000', email: 'sohel@taqwaauto.com', address: 'Kafrul, Dhaka',
    specialization: 'Electrical & AC', experience: 6, joining_date: '2022-07-01',
    employment_type: 'Full Time', salary_type: 'Monthly', salary: 24000,
    commission_rate: 3, availability: 'Available', notes: 'Second shift',
    status: 'Active', created_at: '2026-05-17T04:00:00.000Z', updated_at: null },
  { id: 'MEC-0001', name: 'Abdul Karim', phone: '01777-111222',
    alt_phone: null, email: null, address: null,
    specialization: null, experience: null, joining_date: null,
    employment_type: null, salary_type: null, salary: null,
    commission_rate: null, availability: null, notes: null,
    status: 'Inactive', created_at: '2026-05-14T04:00:00.000Z',
    updated_at: '2026-09-18T04:00:00.000Z' },
];

console.log('=== GET /api/mechanics (unit, stubbed D1) ===\n');

/* ---------- 1. populated list ---------- */
console.log('-- 1. Populated list --');
{
  const res = await call('/api/mechanics', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('content-type JSON', res.headers.get('content-type'), 'application/json; charset=utf-8');
  ok_('data is an array', Array.isArray(body.data), JSON.stringify(body).slice(0, 100));
  check('count', body.count, 2);
  check('total', body.total, 2);
  check('meta keys match the other collections', Object.keys(body).sort(),
    ['count', 'data', 'limit', 'offset', 'total']);
  check('newest first', body.data.map(m => m.id), ['MEC-0002', 'MEC-0001']);

  const [full, sparse] = body.data;
  check('name mapped', full.name, 'Sohel Rana');
  check('phone kept as a string', full.phone, '01888-222333');
  check('alt_phone -> altPhone', full.altPhone, '01888-999000');
  check('email mapped', full.email, 'sohel@taqwaauto.com');
  check('address mapped', full.address, 'Kafrul, Dhaka');
  check('specialization mapped', full.specialization, 'Electrical & AC');
  check('experience mapped', full.experience, 6);
  check('joining_date -> joiningDate', full.joiningDate, '2022-07-01');
  check('employment_type -> employmentType', full.employmentType, 'Full Time');
  check('salary_type -> salaryType', full.salaryType, 'Monthly');
  check('salary kept as a number', full.salary, 24000);
  check('commission_rate -> commissionRate', full.commissionRate, 3);
  check('availability mapped', full.availability, 'Available');
  check('notes mapped', full.notes, 'Second shift');
  check('status mapped', full.status, 'Active');
  check('createdAt mapped', full.createdAt, '2026-05-17T04:00:00.000Z');
  check('updatedAt omitted when never updated', 'updatedAt' in full, false);

  check('NULL alt_phone -> empty string', sparse.altPhone, '');
  check('NULL email -> empty string', sparse.email, '');
  check('NULL address -> empty string', sparse.address, '');
  check('NULL specialization -> empty string', sparse.specialization, '');
  check('NULL joining_date -> empty string', sparse.joiningDate, '');
  check('NULL notes -> empty string', sparse.notes, '');
  check('NULL experience -> null, not 0', sparse.experience, null);
  check('NULL salary -> null, not 0', sparse.salary, null);
  check('NULL commission_rate -> null, not 0', sparse.commissionRate, null);
  // The UI supplies its own display defaults for these three; inventing them
  // here would turn "not recorded" into a stored answer.
  check('NULL employment_type -> empty string, not "Full Time"', sparse.employmentType, '');
  check('NULL salary_type -> empty string, not "Monthly"', sparse.salaryType, '');
  check('NULL availability -> empty string, not "Available"', sparse.availability, '');
  check('Inactive status preserved', sparse.status, 'Inactive');
  check('updatedAt present when set', sparse.updatedAt, '2026-09-18T04:00:00.000Z');

  check('record shape', Object.keys(full).sort(),
    ['address', 'altPhone', 'availability', 'commissionRate', 'createdAt', 'email',
      'employmentType', 'experience', 'id', 'joiningDate', 'name', 'notes', 'phone',
      'salary', 'salaryType', 'specialization', 'status']);
  ok_('no snake_case leaked', !JSON.stringify(body).match(/alt_phone|joining_date|employment_type|salary_type|commission_rate/),
    JSON.stringify(full));
}

/* ---------- 1b. zero is not null ---------- */
console.log('\n-- 1b. Zero and null are different answers --');
{
  const ZEROED = [{ ...SEEDED[1], id: 'MEC-0003', experience: 0, salary: 0, commission_rate: 0 }];
  const res = await call('/api/mechanics', { DB: stubDB({ rows: ZEROED }) });
  const body = await res.json();
  check('experience 0 stays 0', body.data[0].experience, 0);
  check('salary 0 stays 0', body.data[0].salary, 0);
  check('commissionRate 0 stays 0', body.data[0].commissionRate, 0);
  ok_('0 is not turned into null', body.data[0].salary !== null, JSON.stringify(body.data[0]));
}

/* ---------- 2. empty ---------- */
console.log('\n-- 2. Empty table --');
{
  const res = await call('/api/mechanics', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('data empty', body.data, []);
  check('count 0', body.count, 0);
  check('total 0', body.total, 0);
}

/* ---------- 3. pagination + SQL safety ---------- */
console.log('\n-- 3. Pagination and SQL safety --');
{
  const db = stubDB({ rows: [SEEDED[1]], total: 2 });
  const res = await call('/api/mechanics?limit=1&offset=1', { DB: db });
  const body = await res.json();
  check('limit echoed', body.limit, 1);
  check('offset echoed', body.offset, 1);
  check('count is the page', body.count, 1);
  check('total is the table', body.total, 2);

  const q = db.calls.find(c => c.sql.includes('FROM mechanics') && !c.sql.includes('count(*)'));
  ok_('limit/offset bound', JSON.stringify(q.binds) === '[1,1]', JSON.stringify(q.binds));
  ok_('numbered placeholders', q.sql.includes('?1') && q.sql.includes('?2'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('ordering is newest first with an id tie-break',
    /ORDER BY created_at DESC, id DESC/.test(q.sql), q.sql);
  ok_('salary is selected explicitly, never via *', q.sql.includes('salary'), q.sql);
}
{
  const res = await call('/api/mechanics', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('default limit', body.limit, 500);
  check('default offset', body.offset, 0);
}

/* ---------- 4. parameter validation ---------- */
console.log('\n-- 4. Parameter validation --');
for (const [q, why] of [
  ['limit=0', 'below minimum'], ['limit=1001', 'above maximum'], ['limit=-3', 'negative'],
  ['limit=abc', 'not a number'], ['limit=1.5', 'not an integer'],
  ['offset=-1', 'negative offset'], ['offset=abc', 'offset not a number'],
]) {
  const db = stubDB({ rows: [] });
  const res = await call('/api/mechanics?' + q, { DB: db });
  const body = await res.json();
  ok_(`${q} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_parameter', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/mechanics?limit=1000', { DB: stubDB({ rows: [] }) });
  check('limit at the maximum accepted', res.status, 200);
}

/* ---------- 5. list failure modes ---------- */
console.log('\n-- 5. List failure modes --');
{
  const res = await call('/api/mechanics', { DB: stubDB({ rows: [], throwOn: 'FROM mechanics' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  check('message names the collection', body.error.message, 'Could not read mechanics.');
  ok_('no driver detail leaked', !JSON.stringify(body).includes('D1_ERROR'), JSON.stringify(body));
}
{
  const res = await call('/api/mechanics', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
// C-2 gave this collection writes, so the methods it still refuses are
// fewer and the Allow header names the new ones. The writes themselves are
// covered in tests/unit/write-crud.test.mjs.
for (const m of ['PUT', 'DELETE', 'PATCH']) {
  const res = await call('/api/mechanics', { DB: stubDB({ rows: [] }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/mechanics', { DB: stubDB({ rows: [] }) }, { method: 'PATCH' });
  check('405 Allow now names POST too', res.headers.get('allow'), 'GET, POST');
}

console.log('\n=== GET /api/mechanics/:id ===');

/* ---------- 6. detail success ---------- */
console.log('\n-- 6. Valid id --');
{
  const res = await call('/api/mechanics/MEC-0001', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  ok_('data is a single object', body.data && !Array.isArray(body.data), JSON.stringify(body.data));
  check('the requested mechanic is returned', body.data.id, 'MEC-0001');
  check('name correct', body.data.name, 'Abdul Karim');
  check('only a data key', Object.keys(body).sort(), ['data']);
  check('detail keeps salary null, not 0', body.data.salary, null);
}
{
  const res = await call('/api/mechanics/MEC-0002', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('a different id returns a different record', body.data.id, 'MEC-0002');
  check('and its own fields', body.data.commissionRate, 3);
}
{
  // The detail record must be byte-identical to the same row from the list.
  const listBody = await (await call('/api/mechanics', { DB: stubDB({ rows: SEEDED }) })).json();
  const detail = await (await call('/api/mechanics/MEC-0002', { DB: stubDB({ rows: SEEDED }) })).json();
  check('detail record matches the list record',
    JSON.stringify(detail.data), JSON.stringify(listBody.data.find(m => m.id === 'MEC-0002')));
}

/* ---------- 7. unknown / invalid ---------- */
console.log('\n-- 7. Unknown and invalid ids --');
{
  const res = await call('/api/mechanics/MEC-9999', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('unknown id -> 404', res.status, 404);
  check('error code', body.error.code, 'not_found');
  check('message', body.error.message, 'No mechanic with that id.');
  ok_('no table name or SQL leaked', !JSON.stringify(body).match(/SELECT|sqlite/i), JSON.stringify(body));
}
{
  const res = await call('/api/mechanics/CUS-0001', { DB: stubDB({ rows: SEEDED }) });
  check('a well-formed id of another collection -> 404', res.status, 404);
}
for (const [path, why] of [
  ['/api/mechanics/', 'empty'],
  ['/api/mechanics/abc', 'no numeric part'],
  ['/api/mechanics/MEC0001', 'missing hyphen'],
  ['/api/mechanics/MEC-', 'no digits'],
  ['/api/mechanics/-0001', 'no prefix'],
  ['/api/mechanics/MEC-0001-extra', 'trailing junk'],
  ['/api/mechanics/' + 'M'.repeat(40) + '-1', 'too long'],
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call(path, { DB: db });
  const body = await res.json();
  ok_(`${path} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_id', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 8. injection-style ids ---------- */
console.log('\n-- 8. Injection-style ids --');
for (const raw of [
  "MEC-0001' OR '1'='1",
  "MEC-0001; DROP TABLE mechanics",
  "' UNION SELECT id,name,salary FROM mechanics --",
  '../../etc/passwd',
  'MEC-0001%00',
  '<script>alert(1)</script>',
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/mechanics/' + encodeURIComponent(raw), { DB: db });
  ok_(`rejected: ${raw.slice(0, 38)}`, res.status === 400, `got ${res.status}`);
  ok_('   ...nothing reached the database', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/mechanics/%zz', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('malformed URL encoding -> 400', res.status, 400);
  check('error code', body.error.code, 'invalid_id');
}

/* ---------- 9. detail SQL safety and failures ---------- */
console.log('\n-- 9. Detail SQL safety and failure modes --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/mechanics/MEC-0001', { DB: db });
  const q = db.calls[0];
  check('exactly one query', db.calls.length, 1);
  ok_('id bound', JSON.stringify(q.binds) === '["MEC-0001"]', JSON.stringify(q.binds));
  ok_('id absent from the SQL text', !q.sql.includes('MEC-0001'), q.sql);
  ok_('numbered placeholder', q.sql.includes('?1'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('bounded with LIMIT 1', q.sql.includes('LIMIT 1'), q.sql);
}
{
  const res = await call('/api/mechanics/MEC-0001', { DB: stubDB({ rows: SEEDED, throwOn: 'WHERE id' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('message names the singular', body.error.message, 'Could not read mechanic.');
}
{
  const res = await call('/api/mechanics/MEC-0001', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
// C-2 gave this collection writes, so the methods it still refuses are
// fewer and the Allow header names the new ones. The writes themselves are
// covered in tests/unit/write-crud.test.mjs.
for (const m of ['POST', 'PATCH']) {
  const res = await call('/api/mechanics/MEC-0001', { DB: stubDB({ rows: SEEDED }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/mechanics/MEC-0001', { DB: stubDB({ rows: SEEDED }) }, { method: 'POST' });
  check('405 Allow names the write routes', res.headers.get('allow'), 'GET, PUT, DELETE');
}

/* ---------- 10. the shared factory still keeps collections distinct ---------- */
console.log('\n-- 10. Shared factory: mechanics stays distinct --');
{
  const mDb = stubDB({ rows: [] });
  await call('/api/mechanics', { DB: mDb });
  const sDb = stubDB({ rows: [] });
  await call('/api/services', { DB: sDb });
  const cDb = stubDB({ rows: [] });
  await call('/api/customers', { DB: cDb });

  ok_('mechanics queries FROM mechanics', mDb.calls[0].sql.includes('FROM mechanics'), mDb.calls[0].sql);
  ok_('mechanics selects its own columns',
    mDb.calls[0].sql.includes('commission_rate') && mDb.calls[0].sql.includes('joining_date'),
    mDb.calls[0].sql);
  ok_('no other collection selects mechanics columns',
    !sDb.calls[0].sql.includes('commission_rate') && !cDb.calls[0].sql.includes('salary'),
    'column lists leaked between collections');
  ok_('mechanics does not select another collection\'s columns',
    !mDb.calls[0].sql.includes('reg_no') && !mDb.calls[0].sql.includes('est_time'),
    mDb.calls[0].sql);
  // phone_digits backs the customers duplicate-phone rule and must never leak;
  // mechanics has a phone column of its own and no generated companion.
  ok_('no generated column selected', !mDb.calls[0].sql.includes('phone_digits'), mDb.calls[0].sql);
}
{
  const m = await (await call('/api/mechanics/MEC-9999', { DB: stubDB({ rows: [] }) })).json();
  const s = await (await call('/api/services/SRV-9999', { DB: stubDB({ rows: [] }) })).json();
  const v = await (await call('/api/vehicles/VEH-9999', { DB: stubDB({ rows: [] }) })).json();
  const c = await (await call('/api/customers/CUS-9999', { DB: stubDB({ rows: [] }) })).json();
  check('mechanics 404 message', m.error.message, 'No mechanic with that id.');
  check('services 404 message', s.error.message, 'No service with that id.');
  check('vehicles 404 message', v.error.message, 'No vehicle with that id.');
  check('customers 404 message', c.error.message, 'No customer with that id.');
}

/* ---------- 11. routing ---------- */
console.log('\n-- 11. Routing --');
{
  const res = await call('/api/health', { DB: stubDB({ rows: [{ name: 'customers' }], total: 11 }) });
  const body = await res.json();
  check('health 200', res.status, 200);
  ok_('health advertises the mechanics routes',
    body.data.routes.includes('GET /api/mechanics')
      && body.data.routes.includes('GET /api/mechanics/:id'),
    JSON.stringify(body.data.routes));
}
{
  const res = await call('/api/nope', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('unknown collection -> 404', res.status, 404);
  ok_('404 advertises the mechanics routes',
    body.error.available.includes('GET /api/mechanics')
      && body.error.available.includes('GET /api/mechanics/:id'),
    JSON.stringify(body.error.available));
}
{
  const res = await call('/api/mechanic', { DB: stubDB({ rows: [] }) });
  check('the singular is not a route', res.status, 404);
}

console.log(`\nGET /api/mechanics unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
