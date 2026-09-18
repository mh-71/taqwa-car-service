/* GET /api/customers — unit tests against the REAL Worker handler,
   with a stubbed D1 binding. No wrangler, no network, no database. */
import worker from '../../src/index.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

/* ---- a D1 stub that records exactly what the route asked for ---- */
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
          // WHERE id = ?1 -> honour the bound id, like the real database
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
const GET = (path) => new Request('http://worker.local' + path);
const call = (path, env, init) => worker.fetch(init ? new Request('http://worker.local' + path, init) : GET(path), env);

const SEEDED = [
  { id: 'CUS-0002', name: 'Karim Hossain', phone: '01812-345678', alt_phone: '01912-345678',
    email: 'karim.h@yahoo.com', address: 'Block C, Bashundhara R/A, Dhaka', notes: null,
    status: 'Active', created_at: '2026-06-15T10:00:00.000Z', updated_at: null },
  { id: 'CUS-0001', name: 'Rahim Ahmed', phone: '01711-234567', alt_phone: null,
    email: 'rahim.ahmed@gmail.com', address: 'House 12, Road 5, Dhanmondi, Dhaka',
    notes: 'Prefers morning appointments', status: 'Active',
    created_at: '2026-05-21T10:00:00.000Z', updated_at: '2026-09-01T08:00:00.000Z' },
];

console.log('=== GET /api/customers (unit, stubbed D1) ===\n');

/* ---- 1. populated result ---- */
console.log('-- 1. Populated result --');
{
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/customers', { DB: db });
  const body = await res.json();

  check('HTTP 200', res.status, 200);
  check('content-type is JSON', res.headers.get('content-type'), 'application/json; charset=utf-8');
  ok_('body has a `data` array', Array.isArray(body.data), JSON.stringify(body).slice(0, 120));
  check('count matches row count', body.count, 2);
  check('total reported', body.total, 2);
  check('limit echoed', body.limit, 500);
  check('offset echoed', body.offset, 0);
  check('response keys', Object.keys(body).sort(), ['count', 'data', 'limit', 'offset', 'total']);

  const [first, second] = body.data;
  check('seeded customer returned by id', first.id, 'CUS-0002');
  check('name preserved', first.name, 'Karim Hossain');
  check('snake_case -> camelCase (altPhone)', first.altPhone, '01912-345678');
  check('snake_case -> camelCase (createdAt)', first.createdAt, '2026-06-15T10:00:00.000Z');
  check('NULL text -> empty string', second.altPhone, '');
  check('updatedAt omitted when never updated', 'updatedAt' in first, false);
  check('updatedAt present when set', second.updatedAt, '2026-09-01T08:00:00.000Z');
  check('record shape', Object.keys(second).sort(),
    ['address','altPhone','createdAt','email','id','name','notes','phone','status','updatedAt']);
  ok_('internal phone_digits never exposed',
    !JSON.stringify(body).includes('phone_digits') && !('phoneDigits' in first), JSON.stringify(first));
}

/* ---- 2. empty result ---- */
console.log('\n-- 2. Empty table --');
{
  const db = stubDB({ rows: [] });
  const res = await call('/api/customers', { DB: db });
  const body = await res.json();
  check('HTTP 200 on empty', res.status, 200);
  check('data is an empty array', body.data, []);
  check('count is 0', body.count, 0);
  check('total is 0', body.total, 0);
}

/* ---- 3. SQL safety ---- */
console.log('\n-- 3. SQL is parameterized --');
{
  const db = stubDB({ rows: [] });
  await call('/api/customers?limit=7&offset=3', { DB: db });
  const select = db.calls.find(c => c.sql.includes('FROM customers') && !c.sql.includes('count(*)'));
  ok_('limit/offset passed via .bind(), not interpolated',
    JSON.stringify(select.binds) === '[7,3]', JSON.stringify(select.binds));
  ok_('no request value appears inside the SQL text',
    !select.sql.includes('7') && !select.sql.includes('LIMIT 7'), select.sql);
  ok_('uses numbered placeholders', select.sql.includes('?1') && select.sql.includes('?2'), select.sql);
  ok_('column list is explicit, not SELECT *', !select.sql.includes('SELECT *'), select.sql);
  ok_('phone_digits not in the column list', !select.sql.includes('phone_digits'), select.sql);
}
{
  // a hostile limit must never reach the SQL
  const db = stubDB({ rows: [] });
  const res = await call('/api/customers?limit=1;DROP TABLE customers', { DB: db });
  check('injection attempt rejected with 400', res.status, 400);
  const body = await res.json();
  check('error code', body.error.code, 'invalid_parameter');
  check('no query was ever prepared', db.calls.length, 0);
}

/* ---- 4. parameter validation ---- */
console.log('\n-- 4. Parameter validation --');
for (const [q, why] of [
  ['limit=0', 'below minimum'], ['limit=1001', 'above maximum'], ['limit=-5', 'negative'],
  ['limit=abc', 'not a number'], ['limit=1.5', 'not an integer'], ['offset=-1', 'negative offset'],
]) {
  const res = await call('/api/customers?' + q, { DB: stubDB({ rows: [] }) });
  ok_(`${q} rejected (${why})`, res.status === 400, `got ${res.status}`);
}
{
  const db = stubDB({ rows: [] });
  const res = await call('/api/customers?limit=&offset=', { DB: db });
  check('empty params fall back to defaults', res.status, 200);
  const body = await res.json();
  check('default limit applied', body.limit, 500);
}

/* ---- 5. D1 error handling ---- */
console.log('\n-- 5. D1 failure --');
{
  const db = stubDB({ rows: [], throwOn: 'FROM customers' });
  const res = await call('/api/customers', { DB: db });
  const body = await res.json();
  check('HTTP 500 on D1 error', res.status, 500);
  check('error code', body.error.code, 'database_error');
  ok_('message is plain, no SQL or stack leaked',
    body.error.message === 'Could not read customers.'
      && !JSON.stringify(body).includes('SELECT')
      && !JSON.stringify(body).includes('D1_ERROR'), JSON.stringify(body));
}
{
  const res = await call('/api/customers', {});   // no DB binding at all
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}

/* ---- 6. method handling ---- */
console.log('\n-- 6. Methods and routing --');
// C-2 gave this collection writes, so the methods it still refuses are
// fewer and the Allow header names the new ones. The writes themselves are
// covered in tests/unit/write-crud.test.mjs.
for (const m of ['PUT', 'DELETE', 'PATCH']) {
  const res = await call('/api/customers', { DB: stubDB({ rows: [] }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
  if (m === 'POST') {
    check('405 sets Allow header', res.headers.get('allow'), 'GET');
    const b = await res.json();
    check('405 error code', b.error.code, 'method_not_allowed');
  }
}
{
  const res = await call('/api/nope', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('unknown route -> 404', res.status, 404);
  ok_('404 advertises the customers routes',
    body.error.available.includes('GET /api/customers')
      && body.error.available.includes('GET /api/customers/:id'),
    JSON.stringify(body.error.available));
}

/* ---- 7. health still works ---- */
console.log('\n-- 7. Phase A health endpoint unchanged --');
{
  const db = stubDB({ rows: [{ name: 'customers' }, { name: 'vehicles' }], total: 42 });
  const res = await call('/api/health', { DB: db });
  const body = await res.json();
  check('health HTTP 200', res.status, 200);
  check('health reports ok', body.ok, true);
  check('health reports migrated', body.data.database.migrated, true);
  ok_('health advertises the customers routes',
    body.data.routes.includes('GET /api/customers')
      && body.data.routes.includes('GET /api/customers/:id'),
    JSON.stringify(body.data.routes));
}


/* ================= GET /api/customers/:id ================= */
console.log('\n=== GET /api/customers/:id ===');

console.log('\n-- 8. Valid id --');
{
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/customers/CUS-0001', { DB: db });
  const body = await res.json();

  check('HTTP 200', res.status, 200);
  ok_('data is a single object, not an array', body.data && !Array.isArray(body.data), JSON.stringify(body.data));
  check('the requested customer is returned', body.data.id, 'CUS-0001');
  check('name correct', body.data.name, 'Rahim Ahmed');
  check('camelCase mapping held', body.data.createdAt, '2026-05-21T10:00:00.000Z');
  check('NULL alt_phone -> empty string', body.data.altPhone, '');
  check('updatedAt present', body.data.updatedAt, '2026-09-01T08:00:00.000Z');
  check('record shape matches the list route', Object.keys(body.data).sort(),
    ['address','altPhone','createdAt','email','id','name','notes','phone','status','updatedAt']);
  check('no list-only meta keys', Object.keys(body).sort(), ['data']);
  ok_('phone_digits never exposed', !JSON.stringify(body).includes('phone_digits'), JSON.stringify(body));
}
{
  // the OTHER seeded record, to prove it is not just returning row[0]
  const res = await call('/api/customers/CUS-0002', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('a different id returns a different record', body.data.id, 'CUS-0002');
  check('and its own fields', body.data.altPhone, '01912-345678');
  check('updatedAt omitted when never updated', 'updatedAt' in body.data, false);
}

console.log('\n-- 9. Unknown id --');
{
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/customers/CUS-9999', { DB: db });
  const body = await res.json();
  check('HTTP 404', res.status, 404);
  check('error code', body.error.code, 'not_found');
  check('message is plain', body.error.message, 'No customer with that id.');
  ok_('no table name or SQL leaked', !JSON.stringify(body).match(/SELECT|customers|sqlite/i), JSON.stringify(body));
}
{
  // a well-formed id from another collection is a 404, not a 400
  const res = await call('/api/customers/VEH-0001', { DB: stubDB({ rows: SEEDED }) });
  check('well-formed id of another type -> 404', res.status, 404);
}

console.log('\n-- 10. Invalid id --');
for (const [path, why] of [
  ['/api/customers/', 'empty'],
  ['/api/customers/abc', 'no numeric part'],
  ['/api/customers/CUS0001', 'missing hyphen'],
  ['/api/customers/CUS-', 'no digits'],
  ['/api/customers/-0001', 'no prefix'],
  ['/api/customers/CUS-0001-extra', 'trailing junk'],
  ['/api/customers/' + 'C'.repeat(40) + '-1', 'too long'],
  ['/api/customers/%20', 'whitespace'],
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call(path, { DB: db });
  const body = await res.json();
  ok_(`${path} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_id',
      `got ${res.status} ${JSON.stringify(body)}`);
  ok_(`   ...and no query was prepared`, db.calls.length === 0, `prepared ${db.calls.length}`);
}

console.log('\n-- 11. Injection-style ids --');
for (const raw of [
  "CUS-0001' OR '1'='1",
  "CUS-0001; DROP TABLE customers",
  "' UNION SELECT id,name,phone,phone_digits,email,address,notes,status,created_at,updated_at FROM customers --",
  '../../etc/passwd',
  'CUS-0001%00',
  '<script>alert(1)</script>',
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/customers/' + encodeURIComponent(raw), { DB: db });
  ok_(`rejected: ${raw.slice(0, 44)}`, res.status === 400, `got ${res.status}`);
  ok_(`   ...nothing reached the database`, db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  // malformed percent-encoding must not throw a 500
  const res = await call('/api/customers/%zz', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('malformed URL encoding -> 400', res.status, 400);
  check('error code', body.error.code, 'invalid_id');
}

console.log('\n-- 12. Detail route: SQL safety --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/customers/CUS-0001', { DB: db });
  const q = db.calls[0];
  check('exactly one query prepared', db.calls.length, 1);
  ok_('id passed via .bind()', JSON.stringify(q.binds) === '["CUS-0001"]', JSON.stringify(q.binds));
  ok_('id absent from the SQL text', !q.sql.includes('CUS-0001'), q.sql);
  ok_('uses a numbered placeholder', q.sql.includes('?1'), q.sql);
  ok_('explicit column list, not SELECT *', !q.sql.includes('SELECT *'), q.sql);
  ok_('phone_digits not selected', !q.sql.includes('phone_digits'), q.sql);
  ok_('bounded with LIMIT 1', q.sql.includes('LIMIT 1'), q.sql);
}

console.log('\n-- 13. Detail route: failure modes --');
{
  const res = await call('/api/customers/CUS-0001', { DB: stubDB({ rows: SEEDED, throwOn: 'WHERE id' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  ok_('no SQL or driver detail leaked',
    body.error.message === 'Could not read customer.' && !JSON.stringify(body).includes('D1_ERROR'),
    JSON.stringify(body));
}
{
  const res = await call('/api/customers/CUS-0001', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
// C-2 gave this collection writes, so the methods it still refuses are
// fewer and the Allow header names the new ones. The writes themselves are
// covered in tests/unit/write-crud.test.mjs.
for (const m of ['POST', 'PATCH']) {
  const res = await call('/api/customers/CUS-0001', { DB: stubDB({ rows: SEEDED }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/customers/CUS-0001', { DB: stubDB({ rows: SEEDED }) }, { method: 'POST' });
  check('405 Allow names the write routes', res.headers.get('allow'), 'GET, PUT, DELETE');
}

console.log('\n-- 14. List route regression (unchanged by B-2) --');
{
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/customers', { DB: db });
  const body = await res.json();
  check('list still 200', res.status, 200);
  check('list still returns an array', Array.isArray(body.data), true);
  check('list meta keys unchanged', Object.keys(body).sort(), ['count','data','limit','offset','total']);
  check('list count unchanged', body.count, 2);
  check('list ordering preserved', body.data.map(c => c.id), ['CUS-0002','CUS-0001']);
}
{
  const res = await call('/api/health', { DB: stubDB({ rows: [{ name: 'customers' }], total: 42 }) });
  const body = await res.json();
  ok_('health still advertises health and the customers routes',
    body.data.routes[0] === 'GET /api/health'
      && body.data.routes.includes('GET /api/customers/:id'),
    JSON.stringify(body.data.routes));
}
{
  const res = await call('/api/nope', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('unknown route still 404', res.status, 404);
  ok_('404 advertises the customers detail route too',
    body.error.available.includes('GET /api/customers/:id'),
    JSON.stringify(body.error.available));
}

console.log(`\nGET /api/customers unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
