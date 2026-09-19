/* GET /api/parts and /api/parts/:id — unit tests against the REAL Worker
   handler with a stubbed D1 binding.

   Parts is the first collection carrying a running balance, so alongside the
   usual shape and safety checks this suite pins down two things specifically:
   that `stock` is returned from the column rather than derived, and that the
   route never reads inventory_transactions. */
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

/* Modelled on seed-data.js. Three rows on purpose:
   - PRT-0002 fully populated
   - PRT-0001 every nullable column NULL
   - PRT-0007 out of stock, which in this app is a real state, not a gap */
const SEEDED = [
  { id: 'PRT-0002', name: 'Oil Filter', part_no: 'OF-TYT-90915', category: 'Filters',
    brand: 'Toyota', supplier: 'Dhaka Auto Parts', location: 'Rack A2', unit: 'pc',
    purchase_price: 350, selling_price: 500, stock: 18, min_stock: 8, reorder_qty: 10,
    notes: 'Fast mover', status: 'Active',
    created_at: '2026-05-17T04:00:00.000Z', updated_at: null },
  { id: 'PRT-0001', name: 'Engine Oil 5W-30 (4L)', part_no: null, category: null,
    brand: null, supplier: null, location: null, unit: null,
    purchase_price: 2200, selling_price: 2800, stock: 24, min_stock: 10, reorder_qty: null,
    notes: null, status: 'Inactive',
    created_at: '2026-05-14T04:00:00.000Z', updated_at: '2026-09-18T04:00:00.000Z' },
  { id: 'PRT-0007', name: 'Spark Plug (Iridium)', part_no: 'SP-IR-NGK', category: 'Engine',
    brand: 'NGK', supplier: 'Dhaka Auto Parts', location: 'Rack A3', unit: 'pc',
    purchase_price: 450, selling_price: 650, stock: 0, min_stock: 12, reorder_qty: 0,
    notes: '', status: 'Active',
    created_at: '2026-05-10T04:00:00.000Z', updated_at: null },
];

console.log('=== GET /api/parts (unit, stubbed D1) ===\n');

/* ---------- 1. populated list ---------- */
console.log('-- 1. Populated list --');
{
  const res = await call('/api/parts', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('content-type JSON', res.headers.get('content-type'), 'application/json; charset=utf-8');
  ok_('data is an array', Array.isArray(body.data), JSON.stringify(body).slice(0, 100));
  check('count', body.count, 3);
  check('total', body.total, 3);
  check('meta keys match the other collections', Object.keys(body).sort(),
    ['count', 'data', 'limit', 'offset', 'total']);
  check('newest first', body.data.map(p => p.id), ['PRT-0002', 'PRT-0001', 'PRT-0007']);

  const [full, sparse, empty] = body.data;
  check('name mapped', full.name, 'Oil Filter');
  check('part_no -> partNo', full.partNo, 'OF-TYT-90915');
  check('category mapped', full.category, 'Filters');
  check('brand mapped', full.brand, 'Toyota');
  check('supplier mapped', full.supplier, 'Dhaka Auto Parts');
  check('location mapped', full.location, 'Rack A2');
  check('unit mapped', full.unit, 'pc');
  check('purchase_price -> purchasePrice', full.purchasePrice, 350);
  check('selling_price -> sellingPrice', full.sellingPrice, 500);
  check('stock mapped', full.stock, 18);
  check('min_stock -> minStock', full.minStock, 8);
  check('reorder_qty -> reorderQty', full.reorderQty, 10);
  check('notes mapped', full.notes, 'Fast mover');
  check('status mapped', full.status, 'Active');
  check('createdAt mapped', full.createdAt, '2026-05-17T04:00:00.000Z');
  check('updatedAt omitted when never updated', 'updatedAt' in full, false);

  check('NULL part_no -> empty string', sparse.partNo, '');
  check('NULL category -> empty string', sparse.category, '');
  check('NULL brand -> empty string', sparse.brand, '');
  check('NULL supplier -> empty string', sparse.supplier, '');
  check('NULL location -> empty string', sparse.location, '');
  check('NULL unit -> empty string', sparse.unit, '');
  check('NULL notes -> empty string', sparse.notes, '');
  // The edit form already shows `p.reorderQty ?? 10`; supplying that here
  // would turn "nobody set one" into a stored instruction.
  check('NULL reorder_qty -> null, not 0 and not 10', sparse.reorderQty, null);
  check('Inactive status preserved', sparse.status, 'Inactive');
  check('updatedAt present when set', sparse.updatedAt, '2026-09-18T04:00:00.000Z');

  check('stock 0 stays 0 — out of stock is a real state', empty.stock, 0);
  ok_('stock 0 is not turned into null', empty.stock !== null, JSON.stringify(empty));
  check('reorderQty stored as 0 stays 0', empty.reorderQty, 0);
  ok_('a stored 0 and a NULL are distinguishable',
    empty.reorderQty === 0 && sparse.reorderQty === null,
    JSON.stringify({ stored: empty.reorderQty, absent: sparse.reorderQty }));
  check('empty-string notes stay empty', empty.notes, '');

  check('record shape', Object.keys(full).sort(),
    ['brand', 'category', 'createdAt', 'id', 'location', 'minStock', 'name', 'notes',
      'partNo', 'purchasePrice', 'reorderQty', 'sellingPrice', 'status', 'stock',
      'supplier', 'unit']);
  ok_('no snake_case leaked',
    !JSON.stringify(body).match(/part_no|purchase_price|selling_price|min_stock|reorder_qty/),
    JSON.stringify(full));
}

/* ---------- 1b. stock is read, not derived ---------- */
console.log('\n-- 1b. Stock comes from the column, never from the ledger --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/parts', { DB: db });
  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('no query touches inventory_transactions', !sql.includes('inventory_transactions'), sql);
  ok_('nothing is SUMmed', !/\bSUM\s*\(/i.test(sql), sql);
  ok_('no join', !/\bJOIN\b/i.test(sql), sql);
  ok_('stock is selected as a plain column', /\bstock\b/.test(sql), sql);
  check('exactly two queries: the page and its count', db.calls.length, 2);
}
{
  // Whatever the column says is what the API reports, even a value the ledger
  // would disagree with. The API is not a reconciler.
  const ODD = [{ ...SEEDED[0], id: 'PRT-0099', stock: 7.5 }];
  const res = await call('/api/parts', { DB: stubDB({ rows: ODD }) });
  const body = await res.json();
  check('fractional stock passes through unchanged', body.data[0].stock, 7.5);
}
{
  const NO_DERIVED = [{ ...SEEDED[2] }];   // stock 0, min_stock 12 -> "low" in the UI
  const res = await call('/api/parts', { DB: stubDB({ rows: NO_DERIVED }) });
  const body = await res.json();
  const keys = Object.keys(body.data[0]);
  ok_('no derived low-stock flag invented',
    !keys.some(k => /low|isLow|alert|needsReorder/i.test(k)), keys);
  ok_('no derived stock-value field invented',
    !keys.some(k => /value|worth|total/i.test(k)), keys);
  ok_('no openingStock — it is not a stored column', !('openingStock' in body.data[0]), keys);
  ok_('no transaction history embedded',
    !keys.some(k => /transaction|history|movement|ledger/i.test(k)), keys);
}

/* ---------- 2. empty ---------- */
console.log('\n-- 2. Empty table --');
{
  const res = await call('/api/parts', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('data empty', body.data, []);
  check('count 0', body.count, 0);
  check('total 0', body.total, 0);
}

/* ---------- 3. pagination + SQL safety ---------- */
console.log('\n-- 3. Pagination and SQL safety --');
{
  const db = stubDB({ rows: [SEEDED[1]], total: 3 });
  const res = await call('/api/parts?limit=1&offset=1', { DB: db });
  const body = await res.json();
  check('limit echoed', body.limit, 1);
  check('offset echoed', body.offset, 1);
  check('count is the page', body.count, 1);
  check('total is the table', body.total, 3);

  const q = db.calls.find(c => c.sql.includes('FROM parts') && !c.sql.includes('count(*)'));
  ok_('limit/offset bound', JSON.stringify(q.binds) === '[1,1]', JSON.stringify(q.binds));
  ok_('numbered placeholders', q.sql.includes('?1') && q.sql.includes('?2'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('ordering is newest first with an id tie-break',
    /ORDER BY created_at DESC, id DESC/.test(q.sql), q.sql);
}
{
  const res = await call('/api/parts', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('default limit', body.limit, 500);
  check('default offset', body.offset, 0);
}
{
  const res = await call('/api/parts?limit=1000', { DB: stubDB({ rows: [] }) });
  check('limit at the maximum accepted', res.status, 200);
}

/* ---------- 4. parameter validation ---------- */
console.log('\n-- 4. Parameter validation --');
for (const [q, why] of [
  ['limit=0', 'below minimum'], ['limit=1001', 'above maximum'], ['limit=-3', 'negative'],
  ['limit=abc', 'not a number'], ['limit=1.5', 'not an integer'],
  ['offset=-1', 'negative offset'], ['offset=abc', 'offset not a number'],
]) {
  const db = stubDB({ rows: [] });
  const res = await call('/api/parts?' + q, { DB: db });
  const body = await res.json();
  ok_(`${q} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_parameter', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 5. list failure modes ---------- */
console.log('\n-- 5. List failure modes --');
{
  const res = await call('/api/parts', { DB: stubDB({ rows: [], throwOn: 'FROM parts' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  check('message names the collection', body.error.message, 'Could not read parts.');
  ok_('no driver detail leaked', !JSON.stringify(body).includes('D1_ERROR'), JSON.stringify(body));
}
{
  const res = await call('/api/parts', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
// C-2 gave this collection writes, so the methods it still refuses are
// fewer and the Allow header names the new ones. The writes themselves are
// covered in tests/unit/write-crud.test.mjs.
for (const m of ['PUT', 'DELETE', 'PATCH']) {
  const res = await call('/api/parts', { DB: stubDB({ rows: [] }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/parts', { DB: stubDB({ rows: [] }) }, { method: 'PATCH' });
  check('405 Allow now names POST too', res.headers.get('allow'), 'GET, POST');
}

console.log('\n=== GET /api/parts/:id ===');

/* ---------- 6. detail success ---------- */
console.log('\n-- 6. Valid id --');
{
  const res = await call('/api/parts/PRT-0001', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  ok_('data is a single object', body.data && !Array.isArray(body.data), JSON.stringify(body.data));
  check('the requested part is returned', body.data.id, 'PRT-0001');
  check('name correct', body.data.name, 'Engine Oil 5W-30 (4L)');
  check('only a data key', Object.keys(body).sort(), ['data']);
  check('detail keeps reorderQty null', body.data.reorderQty, null);
}
{
  const res = await call('/api/parts/PRT-0007', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('a different id returns a different record', body.data.id, 'PRT-0007');
  check('out-of-stock detail reports 0', body.data.stock, 0);
}
{
  const listBody = await (await call('/api/parts', { DB: stubDB({ rows: SEEDED }) })).json();
  const detail = await (await call('/api/parts/PRT-0002', { DB: stubDB({ rows: SEEDED }) })).json();
  check('detail record matches the list record',
    JSON.stringify(detail.data), JSON.stringify(listBody.data.find(p => p.id === 'PRT-0002')));
}

/* ---------- 7. unknown / invalid ---------- */
console.log('\n-- 7. Unknown and invalid ids --');
{
  const res = await call('/api/parts/PRT-9999', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('unknown id -> 404', res.status, 404);
  check('error code', body.error.code, 'not_found');
  check('message', body.error.message, 'No part with that id.');
  ok_('no table name or SQL leaked', !JSON.stringify(body).match(/SELECT|sqlite/i), JSON.stringify(body));
}
for (const other of ['CUS-0001', 'MEC-0001', 'SRV-0001', 'VEH-0001']) {
  const res = await call('/api/parts/' + other, { DB: stubDB({ rows: SEEDED }) });
  ok_(`${other} on the parts route -> 404, not 400`, res.status === 404, `got ${res.status}`);
}
for (const [path, why] of [
  ['/api/parts/', 'empty'],
  ['/api/parts/abc', 'no numeric part'],
  ['/api/parts/PRT0001', 'missing hyphen'],
  ['/api/parts/PRT-', 'no digits'],
  ['/api/parts/-0001', 'no prefix'],
  ['/api/parts/PRT-0001-extra', 'trailing junk'],
  ['/api/parts/' + 'P'.repeat(40) + '-1', 'too long'],
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
  "PRT-0001' OR '1'='1",
  "PRT-0001; DROP TABLE parts",
  "PRT-0001'; UPDATE parts SET stock=0 --",
  "' UNION SELECT id,name,stock FROM parts --",
  '../../etc/passwd',
  'PRT-0001%00',
  '<script>alert(1)</script>',
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/parts/' + encodeURIComponent(raw), { DB: db });
  ok_(`rejected: ${raw.slice(0, 38)}`, res.status === 400, `got ${res.status}`);
  ok_('   ...nothing reached the database', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/parts/%zz', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('malformed URL encoding -> 400', res.status, 400);
  check('error code', body.error.code, 'invalid_id');
}

/* ---------- 9. detail SQL safety and failures ---------- */
console.log('\n-- 9. Detail SQL safety and failure modes --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/parts/PRT-0001', { DB: db });
  const q = db.calls[0];
  check('exactly one query', db.calls.length, 1);
  ok_('id bound', JSON.stringify(q.binds) === '["PRT-0001"]', JSON.stringify(q.binds));
  ok_('id absent from the SQL text', !q.sql.includes('PRT-0001'), q.sql);
  ok_('numbered placeholder', q.sql.includes('?1'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('bounded with LIMIT 1', q.sql.includes('LIMIT 1'), q.sql);
  ok_('detail does not read the ledger either', !q.sql.includes('inventory_transactions'), q.sql);
}
{
  const res = await call('/api/parts/PRT-0001', { DB: stubDB({ rows: SEEDED, throwOn: 'WHERE id' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('message names the singular', body.error.message, 'Could not read part.');
}
{
  const res = await call('/api/parts/PRT-0001', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
// C-2 gave this collection writes, so the methods it still refuses are
// fewer and the Allow header names the new ones. The writes themselves are
// covered in tests/unit/write-crud.test.mjs.
for (const m of ['POST', 'PATCH']) {
  const res = await call('/api/parts/PRT-0001', { DB: stubDB({ rows: SEEDED }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/parts/PRT-0001', { DB: stubDB({ rows: SEEDED }) }, { method: 'POST' });
  check('405 Allow names the write routes', res.headers.get('allow'), 'GET, PUT, DELETE');
}

/* ---------- 10. the shared factory still keeps collections distinct ---------- */
console.log('\n-- 10. Shared factory: parts stays distinct --');
{
  const pDb = stubDB({ rows: [] });
  await call('/api/parts', { DB: pDb });
  const mDb = stubDB({ rows: [] });
  await call('/api/mechanics', { DB: mDb });
  const sDb = stubDB({ rows: [] });
  await call('/api/services', { DB: sDb });

  ok_('parts queries FROM parts', pDb.calls[0].sql.includes('FROM parts'), pDb.calls[0].sql);
  ok_('parts selects its own columns',
    pDb.calls[0].sql.includes('reorder_qty') && pDb.calls[0].sql.includes('min_stock'),
    pDb.calls[0].sql);
  ok_('parts does not select another collection\'s columns',
    !pDb.calls[0].sql.includes('commission_rate') && !pDb.calls[0].sql.includes('est_time'),
    pDb.calls[0].sql);
  ok_('no other collection selects stock',
    !mDb.calls[0].sql.includes('reorder_qty') && !sDb.calls[0].sql.includes('min_stock'),
    'column lists leaked between collections');
  // parts.price columns and services.price are different things; make sure the
  // two column lists cannot be confused.
  ok_('services still selects its own single price column',
    sDb.calls[0].sql.includes('price') && !sDb.calls[0].sql.includes('purchase_price'),
    sDb.calls[0].sql);
}
{
  const p = await (await call('/api/parts/PRT-9999', { DB: stubDB({ rows: [] }) })).json();
  const m = await (await call('/api/mechanics/MEC-9999', { DB: stubDB({ rows: [] }) })).json();
  const s = await (await call('/api/services/SRV-9999', { DB: stubDB({ rows: [] }) })).json();
  const v = await (await call('/api/vehicles/VEH-9999', { DB: stubDB({ rows: [] }) })).json();
  const c = await (await call('/api/customers/CUS-9999', { DB: stubDB({ rows: [] }) })).json();
  check('parts 404 message', p.error.message, 'No part with that id.');
  check('mechanics 404 message', m.error.message, 'No mechanic with that id.');
  check('services 404 message', s.error.message, 'No service with that id.');
  check('vehicles 404 message', v.error.message, 'No vehicle with that id.');
  check('customers 404 message', c.error.message, 'No customer with that id.');
}

/* ---------- 11. routing ---------- */
console.log('\n-- 11. Routing --');
{
  const res = await call('/api/health', { DB: stubDB({ rows: [{ name: 'customers' }], total: 13 }) });
  const body = await res.json();
  check('health 200', res.status, 200);
  ok_('health advertises the parts routes',
    body.data.routes.includes('GET /api/parts')
      && body.data.routes.includes('GET /api/parts/:id'),
    JSON.stringify(body.data.routes));
}
{
  const res = await call('/api/nope', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('unknown collection -> 404', res.status, 404);
  ok_('404 advertises the parts routes',
    body.error.available.includes('GET /api/parts')
      && body.error.available.includes('GET /api/parts/:id'),
    JSON.stringify(body.error.available));
}
{
  // B-13 shipped the ledger, so the probe that asserted it 404s is derived
  // from what health advertises rather than hardcoded -- the same fix the
  // other suites already use, so the next phase inherits this unchanged.
  const advertised = (await (await call('/api/health', {
    DB: {
      prepare(sql) {
        return {
          async all() { return { results: sql.includes("type = 'table'") ? [{ name: 'customers' }] : [] }; },
          async first() { return { n: 1 }; },
        };
      },
    },
  })).json()).data.routes;

  // Whatever is advertised must answer; whatever is not must 404. Neither
  // list is hardcoded, so shipping a route can never make this stale again.
  for (const path of ['/api/inventory-transactions', '/api/inventory', '/api/part', '/api/stock']) {
    const res = await call(path, { DB: stubDB({ rows: [] }) });
    const isRouted = advertised.includes(`GET ${path}`);
    ok_(`${path} ${isRouted ? 'is a route -> 200' : 'is not a route -> 404'}`,
      isRouted ? res.status === 200 : res.status === 404, `got ${res.status}`);
  }

  // The ledger specifically: exposed as of B-13, and separate from parts.
  ok_('the ledger is now advertised', advertised.includes('GET /api/inventory-transactions'));
  ok_('/api/inventory is still not a route', !advertised.includes('GET /api/inventory'));
  const ledger = await call('/api/inventory-transactions', { DB: stubDB({ rows: [] }) });
  ok_('the ledger route answers 200', ledger.status === 200, `got ${ledger.status}`);
  const lb = await ledger.json();
  ok_('the ledger returns its own rows, not parts', Array.isArray(lb.data));

  // parts.stock stays the balance; B-6's rule is unchanged by B-13.
  const partsRes = await call('/api/parts', { DB: stubDB({ rows: [] }) });
  const partsDb = stubDB({ rows: [] });
  await call('/api/parts', { DB: partsDb });
  ok_('the parts route still never reads the ledger',
    !partsDb.calls.some((c) => /inventory_transactions/i.test(c.sql)),
    partsDb.calls.map((c) => c.sql).join(' | '));
  ok_('parts still answers independently', partsRes.status === 200);
}

console.log(`\nGET /api/parts unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
