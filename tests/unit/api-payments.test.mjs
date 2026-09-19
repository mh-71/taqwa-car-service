/* GET /api/payments and /api/payments/:id — unit tests against the REAL Worker
   handler with a stubbed D1 binding.

   Payments is a flat collection and goes through lib/collection.js, so the
   plumbing is already covered by the other factory-built suites. The weight
   here is on what is specific to this table: that amount and the two nullable
   references round-trip exactly, that the three lookalike states (linked,
   advance, voided) stay distinguishable, and — most of all — that a GET never
   reaches into invoices the way this module's write paths do. */
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

/* All four invoice_id / job_card_id combinations, both statuses, and a row
   that has been updated. Modelled on seed-data.js:190-193. */
const SEEDED = [
  // linked + job card
  { id: 'PAY-0001', invoice_id: 'INV-0001', customer_id: 'CUS-0001', job_card_id: 'JOB-0001',
    date: '2026-09-12', amount: 4200, method: 'Cash', status: 'Active',
    notes: 'Paid in full', created_at: '2026-05-17T04:00:00.000Z', updated_at: null },
  // linked, no job card
  { id: 'PAY-0002', invoice_id: 'INV-0003', customer_id: 'CUS-0005', job_card_id: null,
    date: '2026-09-11', amount: 5250.75, method: 'Card', status: 'Active',
    notes: null, created_at: '2026-05-16T04:00:00.000Z', updated_at: '2026-09-18T04:00:00.000Z' },
  // advance carrying a job card — the shape a released payment ends up in
  { id: 'PAY-0003', invoice_id: null, customer_id: 'CUS-0003', job_card_id: 'JOB-0003',
    date: '2026-09-10', amount: 2000, method: 'Bank Transfer', status: 'Active',
    notes: 'Released when INV-0002 was voided', created_at: '2026-05-15T04:00:00.000Z', updated_at: null },
  // pure advance
  { id: 'PAY-0004', invoice_id: null, customer_id: 'CUS-0004', job_card_id: null,
    date: '2026-09-09', amount: 1500, method: 'Mobile Banking', status: 'Active',
    notes: null, created_at: '2026-05-14T04:00:00.000Z', updated_at: null },
  // voided, and it KEEPS its invoice link
  { id: 'PAY-0005', invoice_id: 'INV-0001', customer_id: 'CUS-0001', job_card_id: 'JOB-0001',
    date: '2026-09-08', amount: 500, method: 'Cash', status: 'Void',
    notes: 'Keyed twice', created_at: '2026-05-13T04:00:00.000Z', updated_at: null },
];
const byId = (body) => Object.fromEntries(body.data.map(p => [p.id, p]));

console.log('=== GET /api/payments (unit, stubbed D1) ===\n');

/* ---------- 1. list and exact field mapping ---------- */
console.log('-- 1. List and field mapping --');
{
  const res = await call('/api/payments', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('content-type JSON', res.headers.get('content-type'), 'application/json; charset=utf-8');
  ok_('data is an array', Array.isArray(body.data), JSON.stringify(body).slice(0, 80));
  check('count', body.count, 5);
  check('total', body.total, 5);
  check('meta keys match the other collections', Object.keys(body).sort(),
    ['count', 'data', 'limit', 'offset', 'total']);
  check('newest first', body.data.map(p => p.id),
    ['PAY-0001', 'PAY-0002', 'PAY-0003', 'PAY-0004', 'PAY-0005']);

  const p = byId(body);
  const full = p['PAY-0001'];
  check('invoice_id -> invoiceId', full.invoiceId, 'INV-0001');
  check('customer_id -> customerId', full.customerId, 'CUS-0001');
  check('job_card_id -> jobCardId', full.jobCardId, 'JOB-0001');
  check('date verbatim', full.date, '2026-09-12');
  check('amount', full.amount, 4200);
  check('method', full.method, 'Cash');
  check('status', full.status, 'Active');
  check('notes', full.notes, 'Paid in full');
  check('createdAt', full.createdAt, '2026-05-17T04:00:00.000Z');
  check('updatedAt omitted when never updated', 'updatedAt' in full, false);
  check('record shape — exactly the ten stored fields plus nothing',
    Object.keys(full).sort(),
    ['amount', 'createdAt', 'customerId', 'date', 'id', 'invoiceId', 'jobCardId',
      'method', 'notes', 'status']);
  ok_('no snake_case leaked',
    !JSON.stringify(body).match(/invoice_id|customer_id|job_card_id|created_at|updated_at/),
    JSON.stringify(full));

  check('NULL notes -> ""', p['PAY-0002'].notes, '');
  check('updatedAt present when set', p['PAY-0002'].updatedAt, '2026-09-18T04:00:00.000Z');
  check('a decimal amount survives', p['PAY-0002'].amount, 5250.75);
  ok_('amount is a number, not a string', typeof p['PAY-0002'].amount === 'number',
    typeof p['PAY-0002'].amount);
}

/* ---------- 2. the four reference combinations ---------- */
console.log('\n-- 2. All four invoiceId / jobCardId combinations --');
{
  const p = byId(await (await call('/api/payments', { DB: stubDB({ rows: SEEDED }) })).json());
  check('1. invoiceId set + jobCardId set',
    [p['PAY-0001'].invoiceId, p['PAY-0001'].jobCardId], ['INV-0001', 'JOB-0001']);
  check('2. invoiceId set + jobCardId null',
    [p['PAY-0002'].invoiceId, p['PAY-0002'].jobCardId], ['INV-0003', null]);
  check('3. invoiceId null + jobCardId set',
    [p['PAY-0003'].invoiceId, p['PAY-0003'].jobCardId], [null, 'JOB-0003']);
  check('4. invoiceId null + jobCardId null',
    [p['PAY-0004'].invoiceId, p['PAY-0004'].jobCardId], [null, null]);
  ok_('a null reference is null, not ""',
    p['PAY-0004'].invoiceId === null && p['PAY-0004'].jobCardId === null,
    JSON.stringify([p['PAY-0004'].invoiceId, p['PAY-0004'].jobCardId]));
}

/* ---------- 3. the three lookalike states ---------- */
console.log('\n-- 3. Linked, advance and voided stay distinguishable --');
{
  const p = byId(await (await call('/api/payments', { DB: stubDB({ rows: SEEDED }) })).json());

  // advance
  check('an advance reports invoiceId null and stays Active',
    [p['PAY-0004'].invoiceId, p['PAY-0004'].status], [null, 'Active']);
  check('a released advance keeps the inherited job card',
    [p['PAY-0003'].invoiceId, p['PAY-0003'].jobCardId, p['PAY-0003'].status],
    [null, 'JOB-0003', 'Active']);
  check('and its amount is untouched by the release', p['PAY-0003'].amount, 2000);

  // voided — the key distinction: it KEEPS its invoice link
  const voided = p['PAY-0005'];
  check('a voided payment reports status Void', voided.status, 'Void');
  check('a voided payment KEEPS its invoiceId', voided.invoiceId, 'INV-0001');
  check('a voided payment keeps its jobCardId', voided.jobCardId, 'JOB-0001');
  check('a voided payment keeps its amount', voided.amount, 500);
  check('a voided payment keeps its date, method and notes',
    [voided.date, voided.method, voided.notes], ['2026-09-08', 'Cash', 'Keyed twice']);
  ok_('void and released-advance are not the same state',
    voided.invoiceId !== null && p['PAY-0003'].invoiceId === null,
    JSON.stringify({ voided: voided.invoiceId, released: p['PAY-0003'].invoiceId }));

  // nothing derived
  const keys = new Set(Object.values(p).flatMap(Object.keys));
  ok_('no isAdvance invented', !keys.has('isAdvance'), [...keys]);
  ok_('no advance / paymentType invented', !keys.has('advance') && !keys.has('paymentType'), [...keys]);
  ok_('no releasedFromInvoice invented', !keys.has('releasedFromInvoice'), [...keys]);
  ok_('no livePaid / due / invoiceStatus invented',
    !['livePaid', 'due', 'invoiceStatus', 'invoiceTotal', 'paid'].some(k => keys.has(k)), [...keys]);
  ok_('no balance field invented', ![...keys].some(k => /balance/i.test(k)), [...keys]);
}
for (const method of ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer']) {
  const rows = [{ ...SEEDED[0], id: 'PAY-0100', method }];
  const body = await (await call('/api/payments/PAY-0100', { DB: stubDB({ rows }) })).json();
  check(`method "${method}" round-trips`, body.data.method, method);
}
for (const status of ['Active', 'Void']) {
  const rows = [{ ...SEEDED[0], id: 'PAY-0101', status }];
  const body = await (await call('/api/payments/PAY-0101', { DB: stubDB({ rows }) })).json();
  check(`status "${status}" round-trips`, body.data.status, status);
}

/* ---------- 4. amount is reported, never normalised ---------- */
console.log('\n-- 4. Amount is a stored fact --');
for (const amount of [0.5, 1, 99.99, 1234.567, 8295, 1000000]) {
  const rows = [{ ...SEEDED[0], id: 'PAY-0102', amount }];
  const body = await (await call('/api/payments/PAY-0102', { DB: stubDB({ rows }) })).json();
  check(`amount ${amount} is returned exactly`, body.data.amount, amount);
}
{
  // A payment whose amount exceeds any plausible invoice total is still
  // reported: this route reconciles nothing.
  const rows = [{ ...SEEDED[0], id: 'PAY-0103', amount: 999999, invoice_id: 'INV-0001' }];
  const body = await (await call('/api/payments/PAY-0103', { DB: stubDB({ rows }) })).json();
  check('an implausibly large amount is not clamped', body.data.amount, 999999);
}

/* ---------- 5. nothing else is queried, nothing is mutated ---------- */
console.log('\n-- 5. No related table is touched --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/payments', { DB: db });
  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('invoices are never queried', !/\binvoices\b/i.test(sql), sql);
  ok_('job_cards are never queried', !/\bjob_cards\b/i.test(sql), sql);
  ok_('customers are never queried', !/\bcustomers\b/i.test(sql), sql);
  ok_('nothing is joined', !/\bJOIN\b/i.test(sql), sql);
  ok_('nothing is summed', !/\bSUM\s*\(/i.test(sql), sql);
  ok_('only the payments table is read',
    db.calls.every(c => /FROM\s+payments\b/.test(c.sql)), sql);
}
{
  // C-8 gave this module a write half, so these assertions are now scoped to
  // the READ half -- which is what they were always about. Their purpose is
  // unchanged and, with the split asserted below, strictly stronger: the read
  // path still reaches for no balance machinery and issues no write, and the
  // module still never imports the frontend engine.
  //
  // The split is made on the RAW source at the section marker and comments
  // stripped afterwards, for the reason the ledger suite gives: splitting the
  // stripped text would put the wrong code on the wrong side of the line.
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../../src/routes/payments.js', import.meta.url), 'utf8'));
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const code = strip(src);

  const writeAt = src.indexOf('   C-8 \u2014 the write half');
  ok_('the module marks where its write half begins', writeAt > 0, writeAt);
  const readHalf = strip(src.slice(0, writeAt));
  const writeHalf = strip(src.slice(writeAt));

  ok_('the read half does not import recomputeInvoiceBalance',
    !readHalf.match(/import[^;]*recomputeInvoiceBalance/), 'import found');
  ok_('the read half never calls it either',
    !readHalf.match(/recomputeInvoiceBalance\s*\(/), 'call found');
  ok_('recomputeInvoiceBalance appears only in prose, never in code',
    src.includes('recomputeInvoiceBalance') && !code.includes('recomputeInvoiceBalance'),
    'not documented, or present in code');
  ok_('the read half contains no UPDATE, INSERT or DELETE',
    !/\b(UPDATE|INSERT|DELETE)\b/.test(readHalf), readHalf.slice(-200));
  ok_('the header prose does discuss writes, so the strip matters',
    /write/i.test(src) && !/\bUPDATE\b/.test(readHalf));
  ok_('every write the module does contain is in the write half',
    /\b(UPDATE|INSERT|DELETE)\b/.test(writeHalf), 'no write found where the writes belong');

  // The read half still goes through the shared factory and nothing else; the
  // module as a whole may now import the shared write helpers too, but never
  // the frontend engine.
  ok_('the read half still goes through the shared collection factory',
    /from '\.\.\/lib\/collection\.js'/.test(src), 'factory import missing');
  const imports = [...code.matchAll(/^\s*import\s+[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  check('the module imports only shared libraries', imports.sort(),
    ['../lib/collection.js', '../lib/http.js', '../lib/write.js']);
  ok_('and never the frontend payment engine or utils', !/utils|Utils/.test(code), 'engine import found');
  ok_('the module never reads or writes a job card\'s money',
    !/job_cards/.test(code), 'job_cards referenced');
}
{
  // A GET must issue no statement that could change a row.
  const db = stubDB({ rows: SEEDED });
  await call('/api/payments', { DB: db });
  await call('/api/payments/PAY-0001', { DB: db });
  ok_('every statement issued is a SELECT',
    db.calls.every(c => /^\s*SELECT/i.test(c.sql.trim())), db.calls.map(c => c.sql.slice(0, 30)));
  ok_('no statement writes', !db.calls.some(c => /\b(UPDATE|INSERT|DELETE)\b/i.test(c.sql)),
    'write statement issued');
}

/* ---------- 6. query counts ---------- */
console.log('\n-- 6. Query counts --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/payments', { DB: db });
  check('list costs exactly 2 queries: page + count', db.calls.length, 2);
  ok_('one page query and one count query',
    db.calls.filter(c => c.sql.includes('count(*)')).length === 1, db.calls.map(c => c.sql.slice(0, 40)));
}
{
  const db = stubDB({ rows: [] });
  await call('/api/payments', { DB: db });
  check('an empty list still costs exactly 2 queries', db.calls.length, 2);
}
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/payments/PAY-0001', { DB: db });
  check('detail costs exactly 1 query', db.calls.length, 1);
}
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/payments/PAY-8888', { DB: db });
  check('a 404 also costs exactly 1 query', db.calls.length, 1);
}
{
  // No N+1: more rows must not mean more queries.
  const many = Array.from({ length: 200 }, (_, i) => ({ ...SEEDED[3], id: `PAY-${1000 + i}` }));
  const db = stubDB({ rows: many });
  const body = await (await call('/api/payments?limit=200', { DB: db })).json();
  check('200 rows returned', body.count, 200);
  check('still 2 queries — no N+1', db.calls.length, 2);
}

/* ---------- 7. pagination and parameter validation ---------- */
console.log('\n-- 7. Pagination and parameter validation --');
{
  const db = stubDB({ rows: [SEEDED[1]], total: 5 });
  const body = await (await call('/api/payments?limit=1&offset=1', { DB: db })).json();
  check('limit echoed', body.limit, 1);
  check('offset echoed', body.offset, 1);
  check('count is the page', body.count, 1);
  check('total is the table', body.total, 5);
  const q = db.calls.find(c => !c.sql.includes('count(*)'));
  ok_('limit/offset bound', JSON.stringify(q.binds) === '[1,1]', JSON.stringify(q.binds));
  ok_('numbered placeholders', q.sql.includes('?1') && q.sql.includes('?2'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('ordering is newest first with an id tie-break',
    /ORDER BY created_at DESC, id DESC/.test(q.sql), q.sql);
  ok_('the amount column is selected explicitly', q.sql.includes('amount'), q.sql);
}
{
  const body = await (await call('/api/payments', { DB: stubDB({ rows: [] }) })).json();
  check('default limit', body.limit, 500);
  check('default offset', body.offset, 0);
}
{
  check('limit at the maximum accepted',
    (await call('/api/payments?limit=1000', { DB: stubDB({ rows: [] }) })).status, 200);
  check('limit 500 accepted',
    (await call('/api/payments?limit=500', { DB: stubDB({ rows: [] }) })).status, 200);
}
for (const [q, why] of [
  ['limit=0', 'below minimum'], ['limit=1001', 'above maximum'], ['limit=-3', 'negative'],
  ['limit=abc', 'not a number'], ['limit=1.5', 'not an integer'],
  ['offset=-1', 'negative offset'], ['offset=abc', 'offset not a number'],
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/payments?' + q, { DB: db });
  const body = await res.json();
  ok_(`${q} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_parameter', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 8. failure modes ---------- */
console.log('\n-- 8. Failure modes --');
{
  const res = await call('/api/payments', { DB: stubDB({ rows: [], throwOn: 'FROM payments' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  check('message names the collection', body.error.message, 'Could not read payments.');
  ok_('no driver detail leaked', !JSON.stringify(body).includes('D1_ERROR'), JSON.stringify(body));
}
{
  const res = await call('/api/payments/PAY-0001', { DB: stubDB({ rows: SEEDED, throwOn: 'WHERE id' }) });
  const body = await res.json();
  check('detail D1 error -> 500', res.status, 500);
  check('message names the singular', body.error.message, 'Could not read payment.');
}
{
  const res = await call('/api/payments', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
{
  const res = await call('/api/payments/PAY-0001', {});
  const body = await res.json();
  check('detail missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
// C-8 made POST a list route and PUT/DELETE detail routes, so the methods
// still without a handler here are fewer than they were -- but the rule under
// test is unchanged: a method this path does not implement is a 405 whose Allow
// header names exactly what it does implement, and nothing more.
for (const m of ['PUT', 'DELETE', 'PATCH']) {
  const rl = await call('/api/payments', { DB: stubDB({ rows: SEEDED }) }, { method: m });
  ok_(`${m} list -> 405`, rl.status === 405, `got ${rl.status}`);
}
for (const m of ['POST', 'PATCH']) {
  const rd = await call('/api/payments/PAY-0001', { DB: stubDB({ rows: SEEDED }) }, { method: m });
  ok_(`${m} detail -> 405`, rd.status === 405, `got ${rd.status}`);
}
{
  const rl = await call('/api/payments', { DB: stubDB({ rows: SEEDED }) }, { method: 'PATCH' });
  check('405 sets Allow on the list', rl.headers.get('allow'), 'GET, POST');
  const rd = await call('/api/payments/PAY-0001', { DB: stubDB({ rows: SEEDED }) }, { method: 'PATCH' });
  check('405 sets Allow on the detail', rd.headers.get('allow'), 'GET, PUT, DELETE');
}
{
  // A method with no handler must not reach the database at all.
  const db = stubDB({ rows: SEEDED });
  await call('/api/payments', { DB: db }, { method: 'PATCH' });
  check('a rejected PATCH prepares no statement', db.calls.length, 0);
}

console.log('\n=== GET /api/payments/:id ===');

/* ---------- 9. detail and id handling ---------- */
console.log('\n-- 9. Valid, unknown and invalid ids --');
{
  const res = await call('/api/payments/PAY-0003', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  ok_('data is a single object', body.data && !Array.isArray(body.data), JSON.stringify(body.data));
  check('the requested payment is returned', body.data.id, 'PAY-0003');
  check('only a data key', Object.keys(body).sort(), ['data']);
  check('the advance shape survives detail', [body.data.invoiceId, body.data.jobCardId], [null, 'JOB-0003']);
}
{
  const listBody = await (await call('/api/payments', { DB: stubDB({ rows: SEEDED }) })).json();
  const detail = await (await call('/api/payments/PAY-0005', { DB: stubDB({ rows: SEEDED }) })).json();
  check('detail record matches the list record',
    JSON.stringify(detail.data), JSON.stringify(listBody.data.find(p => p.id === 'PAY-0005')));
}
{
  const res = await call('/api/payments/PAY-8888', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('unknown id -> 404', res.status, 404);
  check('error code', body.error.code, 'not_found');
  check('message', body.error.message, 'No payment with that id.');
  ok_('no table name or SQL leaked', !JSON.stringify(body).match(/SELECT|sqlite/i), JSON.stringify(body));
}
// Every id a payment actually references is well-formed but belongs elsewhere.
for (const other of ['INV-0001', 'JOB-0001', 'CUS-0001', 'VEH-0001', 'PRT-0001', 'APT-0001', 'SRV-0001', 'MEC-0001']) {
  const res = await call('/api/payments/' + other, { DB: stubDB({ rows: SEEDED }) });
  ok_(`${other} on the payments route -> 404, not 400`, res.status === 404, `got ${res.status}`);
}
for (const [path, why] of [
  ['/api/payments/', 'empty / trailing slash'],
  ['/api/payments/abc', 'no numeric part'],
  ['/api/payments/PAY0001', 'missing hyphen'],
  ['/api/payments/PAY-', 'no digits'],
  ['/api/payments/-0001', 'no prefix'],
  ['/api/payments/PAY-0001-extra', 'trailing junk'],
  ['/api/payments/PAYMENTS-1', 'prefix too long'],
  ['/api/payments/P-1', 'prefix too short'],
  ['/api/payments/' + 'P'.repeat(40) + '-1', 'too long'],
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call(path, { DB: db });
  const body = await res.json();
  ok_(`${path} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_id', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 10. injection ---------- */
console.log('\n-- 10. Injection-style ids --');
for (const raw of [
  "PAY-0001' OR '1'='1",
  "PAY-0001; DROP TABLE payments",
  "PAY-0001'; UPDATE payments SET status='Void' --",
  "PAY-0001'; UPDATE payments SET amount=0 --",
  "PAY-0001'; UPDATE invoices SET paid=0 --",
  "' UNION SELECT id,customer_id,amount FROM payments --",
  '../../etc/passwd',
  'PAY-0001%00',
  '<script>alert(1)</script>',
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/payments/' + encodeURIComponent(raw), { DB: db });
  ok_(`rejected: ${raw.slice(0, 40)}`, res.status === 400, `got ${res.status}`);
  ok_('   ...nothing reached the database', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/payments/%zz', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('malformed URL encoding -> 400', res.status, 400);
  check('error code', body.error.code, 'invalid_id');
}

/* ---------- 11. SQL safety ---------- */
console.log('\n-- 11. SQL safety --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/payments/PAY-0001', { DB: db });
  const q = db.calls[0];
  check('exactly one query', db.calls.length, 1);
  ok_('id bound', JSON.stringify(q.binds) === '["PAY-0001"]', JSON.stringify(q.binds));
  ok_('id absent from the SQL text', !q.sql.includes('PAY-0001'), q.sql);
  ok_('numbered placeholder', q.sql.includes('?1'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('bounded with LIMIT 1', q.sql.includes('LIMIT 1'), q.sql);
  ok_('all eleven columns selected explicitly',
    ['id', 'invoice_id', 'customer_id', 'job_card_id', 'date', 'amount', 'method',
      'status', 'notes', 'created_at', 'updated_at'].every(c => q.sql.includes(c)), q.sql);
}

/* ---------- 12. the shared factory keeps collections distinct ---------- */
console.log('\n-- 12. Shared factory: payments stays distinct --');
{
  const payDb = stubDB({ rows: [] });
  await call('/api/payments', { DB: payDb });
  const invDb = stubDB({ rows: [] });
  await call('/api/invoices', { DB: invDb });
  const custDb = stubDB({ rows: [] });
  await call('/api/customers', { DB: custDb });

  ok_('payments queries FROM payments', payDb.calls[0].sql.includes('FROM payments'), payDb.calls[0].sql);
  ok_('payments selects its own columns',
    payDb.calls[0].sql.includes('method') && payDb.calls[0].sql.includes('amount'), payDb.calls[0].sql);
  ok_('payments does not select another collection\'s columns',
    !payDb.calls[0].sql.includes('subtotal') && !payDb.calls[0].sql.includes('alt_phone'),
    payDb.calls[0].sql);
  ok_('no other collection selects payment columns',
    !invDb.calls[0].sql.includes('method') && !custDb.calls[0].sql.includes('amount'),
    'column lists leaked between collections');
}
{
  const pay = await (await call('/api/payments/PAY-9999', { DB: stubDB({ rows: [] }) })).json();
  const inv = await (await call('/api/invoices/INV-9999', { DB: stubDB({ rows: [] }) })).json();
  const job = await (await call('/api/job-cards/JOB-9999', { DB: stubDB({ rows: [] }) })).json();
  check('payments 404 message', pay.error.message, 'No payment with that id.');
  check('invoices 404 message', inv.error.message, 'No invoice with that id.');
  check('job cards 404 message', job.error.message, 'No job card with that id.');
}

/* ---------- 13. routing ---------- */
console.log('\n-- 13. Routing --');
{
  const res = await call('/api/health', { DB: stubDB({ rows: [{ name: 'customers' }], total: 17 }) });
  const body = await res.json();
  check('health 200', res.status, 200);
  ok_('health advertises the payments routes',
    body.data.routes.includes('GET /api/payments')
      && body.data.routes.includes('GET /api/payments/:id'),
    JSON.stringify(body.data.routes));
}
{
  const res = await call('/api/nope', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('unknown collection -> 404', res.status, 404);
  ok_('404 advertises the payments routes',
    body.error.available.includes('GET /api/payments')
      && body.error.available.includes('GET /api/payments/:id'),
    JSON.stringify(body.error.available));
}
{
  // Derived from what health advertises, not hardcoded, so a later phase that
  // ships these does not have to come back and edit this.
  const advertised = (await (await call('/api/health',
    { DB: stubDB({ rows: [{ name: 'customers' }] }) })).json()).data.routes;
  const unregistered = ['expenses', 'inventory-transactions', 'settings', 'payment', 'refunds']
    .filter(name => !advertised.includes(`GET /api/${name}`));
  ok_('at least one unregistered collection was found to probe',
    unregistered.length > 0, JSON.stringify(advertised));
  for (const name of unregistered) {
    const r = await call(`/api/${name}`, { DB: stubDB({ rows: [] }) });
    ok_(`/api/${name} is not a route -> 404`, r.status === 404, `got ${r.status}`);
  }
}

console.log(`\nGET /api/payments unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
