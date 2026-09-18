/* GET /api/vehicles and /api/vehicles/:id — unit tests against the REAL
   Worker handler with a stubbed D1 binding. No wrangler, no network. */
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
const call = (path, env, init) =>
  worker.fetch(new Request('http://worker.local' + path, init), env);

/* Two rows modelled on seed-data.js, one fully populated and one sparse. */
const SEEDED = [
  { id: 'VEH-0002', customer_id: 'CUS-0002', reg_no: 'DHAKA-METRO-KHA-5678',
    brand: 'Honda', model: 'Civic', year: 2021, color: 'White',
    vin: '2HGFC2F59MH512345', engine_no: 'L15B7-3312456', chassis_no: null,
    mileage: 26500, fuel_type: 'Octane', transmission: 'CVT',
    next_service_date: '2026-06-20', notes: null, status: 'Active',
    created_at: '2026-06-15T04:00:00.000Z', updated_at: null },
  { id: 'VEH-0001', customer_id: 'CUS-0001', reg_no: 'DHAKA-METRO-GA-1234',
    brand: 'Toyota', model: 'Corolla', year: null, color: null,
    vin: null, engine_no: null, chassis_no: 'NZE161-4412345',
    mileage: null, fuel_type: null, transmission: null,
    next_service_date: null, notes: 'AC needs periodic check', status: 'Active',
    created_at: '2026-05-21T04:00:00.000Z', updated_at: '2026-09-18T04:00:00.000Z' },
];

console.log('=== GET /api/vehicles (unit, stubbed D1) ===\n');

/* ---------- 1. populated list ---------- */
console.log('-- 1. Populated list --');
{
  const res = await call('/api/vehicles', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('content-type JSON', res.headers.get('content-type'), 'application/json; charset=utf-8');
  ok_('data is an array', Array.isArray(body.data), JSON.stringify(body).slice(0, 100));
  check('count', body.count, 2);
  check('total', body.total, 2);
  check('meta keys match the customers route', Object.keys(body).sort(),
    ['count', 'data', 'limit', 'offset', 'total']);
  check('newest first', body.data.map(v => v.id), ['VEH-0002', 'VEH-0001']);

  const [full, sparse] = body.data;
  check('customerId mapped', full.customerId, 'CUS-0002');
  check('regNo mapped', full.regNo, 'DHAKA-METRO-KHA-5678');
  check('engineNo mapped', full.engineNo, 'L15B7-3312456');
  check('fuelType mapped', full.fuelType, 'Octane');
  check('nextServiceDate mapped', full.nextServiceDate, '2026-06-20');
  check('year kept as a number', full.year, 2021);
  check('mileage kept as a number', full.mileage, 26500);
  check('NULL text -> empty string (chassisNo)', full.chassisNo, '');
  check('NULL text -> empty string (notes)', full.notes, '');
  check('updatedAt omitted when never updated', 'updatedAt' in full, false);

  check('NULL year -> null, not 0', sparse.year, null);
  check('NULL mileage -> null, not 0', sparse.mileage, null);
  check('updatedAt present when set', sparse.updatedAt, '2026-09-18T04:00:00.000Z');
  check('record shape', Object.keys(full).sort(),
    ['brand','chassisNo','color','createdAt','customerId','engineNo','fuelType','id',
     'mileage','model','nextServiceDate','notes','regNo','status','transmission','vin','year']);
  ok_('no snake_case leaked', !JSON.stringify(body).match(/customer_id|reg_no|engine_no|fuel_type/),
    JSON.stringify(full));
}

/* ---------- 2. empty ---------- */
console.log('\n-- 2. Empty table --');
{
  const res = await call('/api/vehicles', { DB: stubDB({ rows: [] }) });
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
  const res = await call('/api/vehicles?limit=1&offset=1', { DB: db });
  const body = await res.json();
  check('limit echoed', body.limit, 1);
  check('offset echoed', body.offset, 1);
  check('count reflects the page', body.count, 1);
  check('total reflects the table', body.total, 2);

  const q = db.calls.find(c => c.sql.includes('FROM vehicles') && !c.sql.includes('count(*)'));
  ok_('limit/offset bound, not interpolated', JSON.stringify(q.binds) === '[1,1]', JSON.stringify(q.binds));
  ok_('numbered placeholders', q.sql.includes('?1') && q.sql.includes('?2'), q.sql);
  ok_('explicit column list, not SELECT *', !q.sql.includes('SELECT *'), q.sql);
  ok_('ordered newest first', /ORDER BY created_at DESC, id DESC/.test(q.sql), q.sql);
}
{
  const db = stubDB({ rows: [] });
  const res = await call('/api/vehicles?limit=1;DROP TABLE vehicles', { DB: db });
  check('injection in limit -> 400', res.status, 400);
  check('no query prepared', db.calls.length, 0);
}

/* ---------- 4. parameter validation ---------- */
console.log('\n-- 4. Parameter validation --');
for (const [q, why] of [
  ['limit=0', 'below minimum'], ['limit=1001', 'above maximum'], ['limit=-1', 'negative'],
  ['limit=abc', 'not a number'], ['limit=2.5', 'not an integer'], ['offset=-1', 'negative offset'],
  ['offset=xyz', 'offset not a number'],
]) {
  const db = stubDB({ rows: [] });
  const res = await call('/api/vehicles?' + q, { DB: db });
  const body = await res.json();
  ok_(`${q} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_parameter',
    `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/vehicles?limit=1000&offset=0', { DB: stubDB({ rows: [] }) });
  check('limit at the maximum is accepted', res.status, 200);
}

/* ---------- 5. list failure modes ---------- */
console.log('\n-- 5. List failure modes --');
{
  const res = await call('/api/vehicles', { DB: stubDB({ rows: [], throwOn: 'FROM vehicles' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  ok_('no SQL or driver detail leaked',
    body.error.message === 'Could not read vehicles.' && !JSON.stringify(body).includes('D1_ERROR'),
    JSON.stringify(body));
}
{
  const res = await call('/api/vehicles', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const res = await call('/api/vehicles', { DB: stubDB({ rows: [] }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/vehicles', { DB: stubDB({ rows: [] }) }, { method: 'POST' });
  check('405 sets Allow', res.headers.get('allow'), 'GET');
}

console.log('\n=== GET /api/vehicles/:id ===');

/* ---------- 6. detail success ---------- */
console.log('\n-- 6. Valid id --');
{
  const res = await call('/api/vehicles/VEH-0001', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  ok_('data is a single object', body.data && !Array.isArray(body.data), JSON.stringify(body.data));
  check('the requested vehicle is returned', body.data.id, 'VEH-0001');
  check('regNo correct', body.data.regNo, 'DHAKA-METRO-GA-1234');
  check('customerId correct', body.data.customerId, 'CUS-0001');
  check('chassisNo mapped', body.data.chassisNo, 'NZE161-4412345');
  check('only a data key', Object.keys(body).sort(), ['data']);
}
{
  const res = await call('/api/vehicles/VEH-0002', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('a different id returns a different record', body.data.id, 'VEH-0002');
  check('and its own fields', body.data.brand, 'Honda');
}

/* ---------- 7. detail not-found / invalid ---------- */
console.log('\n-- 7. Unknown and invalid ids --');
{
  const res = await call('/api/vehicles/VEH-9999', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('unknown id -> 404', res.status, 404);
  check('error code', body.error.code, 'not_found');
  check('message', body.error.message, 'No vehicle with that id.');
  ok_('no table name or SQL leaked', !JSON.stringify(body).match(/SELECT|vehicles|sqlite/i), JSON.stringify(body));
}
{
  // a well-formed id of another collection is a 404, not a 400
  const res = await call('/api/vehicles/CUS-0001', { DB: stubDB({ rows: SEEDED }) });
  check('CUS-0001 on the vehicles route -> 404', res.status, 404);
}
for (const [path, why] of [
  ['/api/vehicles/', 'empty'],
  ['/api/vehicles/abc', 'no numeric part'],
  ['/api/vehicles/VEH0001', 'missing hyphen'],
  ['/api/vehicles/VEH-', 'no digits'],
  ['/api/vehicles/-0001', 'no prefix'],
  ['/api/vehicles/VEH-0001-extra', 'trailing junk'],
  ['/api/vehicles/' + 'V'.repeat(40) + '-1', 'too long'],
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
  "VEH-0001' OR '1'='1",
  "VEH-0001; DROP TABLE vehicles",
  "' UNION SELECT id,customer_id,reg_no FROM vehicles --",
  '../../etc/passwd',
  'VEH-0001%00',
  '<script>alert(1)</script>',
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/vehicles/' + encodeURIComponent(raw), { DB: db });
  ok_(`rejected: ${raw.slice(0, 40)}`, res.status === 400, `got ${res.status}`);
  ok_('   ...nothing reached the database', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/vehicles/%zz', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('malformed URL encoding -> 400', res.status, 400);
  check('error code', body.error.code, 'invalid_id');
}

/* ---------- 9. detail SQL safety and failures ---------- */
console.log('\n-- 9. Detail SQL safety and failure modes --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/vehicles/VEH-0001', { DB: db });
  const q = db.calls[0];
  check('exactly one query', db.calls.length, 1);
  ok_('id bound', JSON.stringify(q.binds) === '["VEH-0001"]', JSON.stringify(q.binds));
  ok_('id absent from the SQL text', !q.sql.includes('VEH-0001'), q.sql);
  ok_('numbered placeholder', q.sql.includes('?1'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('bounded with LIMIT 1', q.sql.includes('LIMIT 1'), q.sql);
}
{
  const res = await call('/api/vehicles/VEH-0001', { DB: stubDB({ rows: SEEDED, throwOn: 'WHERE id' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  check('message', body.error.message, 'Could not read vehicle.');
}
{
  const res = await call('/api/vehicles/VEH-0001', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const res = await call('/api/vehicles/VEH-0001', { DB: stubDB({ rows: SEEDED }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/vehicles/VEH-0001', { DB: stubDB({ rows: SEEDED }) }, { method: 'POST' });
  check('405 sets Allow', res.headers.get('allow'), 'GET');
}

/* ---------- 10. routing regression ---------- */
console.log('\n-- 10. Routing and customers regression --');
{
  const res = await call('/api/health', { DB: stubDB({ rows: [{ name: 'customers' }], total: 9 }) });
  const body = await res.json();
  check('health 200', res.status, 200);
  ok_('health advertises the vehicles routes',
    body.data.routes.includes('GET /api/vehicles')
      && body.data.routes.includes('GET /api/vehicles/:id'),
    JSON.stringify(body.data.routes));
}
{
  const res = await call('/api/nope', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('unknown collection -> 404', res.status, 404);
  ok_('404 advertises the vehicles routes',
    body.error.available.includes('GET /api/vehicles')
      && body.error.available.includes('GET /api/vehicles/:id'),
    JSON.stringify(body.error.available));
}
{
  const res = await call('/api/nope/VEH-0001', { DB: stubDB({ rows: [] }) });
  check('unknown collection detail -> 404', res.status, 404);
}
{
  // the customers routes must be untouched by the router change
  const CUST = [{ id: 'CUS-0001', name: 'Rahim Ahmed', phone: '01711-234567',
    alt_phone: null, email: null, address: null, notes: null, status: 'Active',
    created_at: '2026-05-21T04:00:00.000Z', updated_at: null }];
  const list = await call('/api/customers', { DB: stubDB({ rows: CUST }) });
  const lb = await list.json();
  check('customers list still 200', list.status, 200);
  check('customers meta keys unchanged', Object.keys(lb).sort(), ['count','data','limit','offset','total']);
  check('customers record unchanged', lb.data[0].id, 'CUS-0001');

  const detail = await call('/api/customers/CUS-0001', { DB: stubDB({ rows: CUST }) });
  const db2 = await detail.json();
  check('customers detail still 200', detail.status, 200);
  check('customers detail record', db2.data.name, 'Rahim Ahmed');

  const missing = await call('/api/customers/CUS-9999', { DB: stubDB({ rows: CUST }) });
  check('customers 404 still works', missing.status, 404);
  const bad = await call('/api/customers/abc', { DB: stubDB({ rows: CUST }) });
  check('customers 400 still works', bad.status, 400);
}

console.log(`\nGET /api/vehicles unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
