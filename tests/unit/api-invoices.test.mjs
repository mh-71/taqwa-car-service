/* GET /api/invoices and /api/invoices/:id — unit tests against the REAL Worker
   handler with a stubbed D1 binding.

   Invoices are the second collection with child line tables, so the stub
   dispatches by table as the job cards suite does. The weight here is on the
   three things that make the invoice route a decision rather than a mapping:
   that the stored money is reported and never re-derived from payments, that
   the lines are the billed snapshot and not the current catalogue, and that a
   Void invoice's frozen figures come back untouched. */
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

/* A binding that knows three tables. `throwOn` takes a SQL fragment so a
   failure can be aimed at the parent query or at either line query. */
function stubDB({ invoices = [], services = [], parts = [], total = null, throwOn = null }) {
  const calls = [];
  return {
    calls,
    get tables() {
      return calls.map(c =>
        c.sql.includes('invoice_services') ? 'services'
          : c.sql.includes('invoice_parts') ? 'parts'
            : c.sql.includes('count(*)') ? 'count' : 'invoices');
    },
    prepare(sql) {
      const entry = { sql, binds: null };
      calls.push(entry);
      const boom = () => { if (throwOn && sql.includes(throwOn)) throw new Error('D1_ERROR: simulated failure'); };
      const forChunk = (rows) => {
        const ids = entry.binds ?? [];
        return rows.filter(r => ids.includes(r.invoice_id));
      };
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async all() {
          boom();
          if (sql.includes('invoice_services')) return { results: forChunk(services) };
          if (sql.includes('invoice_parts')) return { results: forChunk(parts) };
          return { results: invoices };
        },
        async first() {
          boom();
          if (sql.includes('count(*)')) return { n: total === null ? invoices.length : total };
          if (sql.includes('WHERE id =') && entry.binds) {
            return invoices.find(i => i.id === entry.binds[0]) ?? null;
          }
          return invoices[0] ?? null;
        },
      };
      return stmt;
    },
  };
}
const call = (path, env, init) =>
  worker.fetch(new Request('http://worker.local' + path, init), env);

/* Modelled on seed-data.js:INV-0001.
   INV-0002 is Void with non-zero frozen figures and its job card link already
   cleared, which is the state voidInvoice() leaves an invoice in. */
const INVOICES = [
  { id: 'INV-0001', job_card_id: 'JOB-0001', customer_id: 'CUS-0001', vehicle_id: 'VEH-0001',
    date: '2026-09-12',
    labour_cost: 600, discount: 100, tax_rate: 5,
    subtotal: 4100, tax: 200, total: 4200, paid: 4200, due: 0,
    status: 'Paid', notes: 'Settled on collection',
    created_at: '2026-05-17T04:00:00.000Z', updated_at: null },
  { id: 'INV-0002', job_card_id: null, customer_id: 'CUS-0002', vehicle_id: 'VEH-0002',
    date: '2026-09-15',
    labour_cost: 0, discount: 0, tax_rate: 0,
    subtotal: 4935, tax: 0, total: 4935, paid: 3000, due: 1935,
    status: 'Void', notes: null,
    created_at: '2026-05-14T04:00:00.000Z', updated_at: '2026-09-18T04:00:00.000Z' },
];

/* The catalogue has since renamed and repriced SRV-0001, and relabelled
   PRT-0001. The invoice must still report what it billed. */
const SERVICES = [
  { invoice_id: 'INV-0001', service_id: 'SRV-0001', name: 'Premium Oil Change (2024)', qty: 1, unit_price: 1200, total: 1200 },
  { invoice_id: 'INV-0001', service_id: 'SRV-0004', name: 'AC Service', qty: 2, unit_price: 1450, total: 2900 },
];
const PARTS = [
  { invoice_id: 'INV-0001', part_id: 'PRT-0001', name: 'Engine Oil 5W-30 (2024 label)', part_no: 'LEGACY-EO-4L', qty: 1, unit_price: 2800, total: 2800 },
  // A manual line: no inventory record behind it.
  { invoice_id: 'INV-0001', part_id: null, name: 'Custom gasket (hand cut)', part_no: 'MANUAL-01', qty: 2, unit_price: 150, total: 300 },
];

console.log('=== GET /api/invoices (unit, stubbed D1) ===\n');

/* ---------- 1. populated list and parent mapping ---------- */
console.log('-- 1. Populated list and parent mapping --');
{
  const res = await call('/api/invoices', { DB: stubDB({ invoices: INVOICES, services: SERVICES, parts: PARTS }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('content-type JSON', res.headers.get('content-type'), 'application/json; charset=utf-8');
  ok_('data is an array', Array.isArray(body.data), JSON.stringify(body).slice(0, 80));
  check('count', body.count, 2);
  check('total', body.total, 2);
  check('meta keys match the other collections', Object.keys(body).sort(),
    ['count', 'data', 'limit', 'offset', 'total']);
  check('newest first', body.data.map(i => i.id), ['INV-0001', 'INV-0002']);

  const [full, voided] = body.data;
  check('job_card_id -> jobCardId', full.jobCardId, 'JOB-0001');
  check('customer_id -> customerId', full.customerId, 'CUS-0001');
  check('vehicle_id -> vehicleId', full.vehicleId, 'VEH-0001');
  check('date verbatim', full.date, '2026-09-12');
  check('labour_cost -> labourCost', full.labourCost, 600);
  check('discount', full.discount, 100);
  check('tax_rate -> taxRate', full.taxRate, 5);
  check('subtotal', full.subtotal, 4100);
  check('tax', full.tax, 200);
  check('total', full.total, 4200);
  check('paid', full.paid, 4200);
  check('due', full.due, 0);
  check('status', full.status, 'Paid');
  check('notes', full.notes, 'Settled on collection');
  check('createdAt', full.createdAt, '2026-05-17T04:00:00.000Z');
  check('updatedAt omitted when never updated', 'updatedAt' in full, false);
  check('record shape', Object.keys(full).sort(),
    ['createdAt', 'customerId', 'date', 'discount', 'due', 'id', 'jobCardId', 'labourCost',
      'notes', 'paid', 'partsUsed', 'services', 'status', 'subtotal', 'tax', 'taxRate',
      'total', 'vehicleId']);
  ok_('no snake_case leaked',
    !JSON.stringify(body).match(/job_card_id|customer_id|labour_cost|tax_rate|unit_price|part_no|invoice_id/),
    JSON.stringify(full).slice(0, 200));

  check('NULL job_card_id -> null', voided.jobCardId, null);
  check('NULL notes -> ""', voided.notes, '');
  check('updatedAt present when set', voided.updatedAt, '2026-09-18T04:00:00.000Z');
  check('money 0 stays 0, not null', [voided.labourCost, voided.tax, voided.due === 1935], [0, 0, true]);
  ok_('0 money is not turned into null', voided.tax !== null, JSON.stringify(voided.tax));
  ok_('the field is partsUsed, not parts',
    'partsUsed' in full && !('parts' in full), Object.keys(full));
}

/* ---------- 2. nested lines ---------- */
console.log('\n-- 2. Nested lines --');
{
  const res = await call('/api/invoices', { DB: stubDB({ invoices: INVOICES, services: SERVICES, parts: PARTS }) });
  const body = await res.json();
  const [full, voided] = body.data;

  check('two service lines', full.services.length, 2);
  check('two part lines', full.partsUsed.length, 2);
  check('service line shape', Object.keys(full.services[0]).sort(),
    ['name', 'qty', 'serviceId', 'total', 'unitPrice']);
  check('part line shape', Object.keys(full.partsUsed[0]).sort(),
    ['name', 'partId', 'partNo', 'qty', 'total', 'unitPrice']);
  ok_('child rows expose no surrogate id or line_no',
    !['id', 'lineNo', 'line_no'].some(k => k in full.services[0] || k in full.partsUsed[0]),
    Object.keys(full.services[0]));
  ok_('child rows do not carry invoiceId back',
    !('invoiceId' in full.services[0]) && !('invoiceId' in full.partsUsed[0]),
    Object.keys(full.services[0]));
  check('qty preserved', full.services[1].qty, 2);
  check('line total preserved', full.services[1].total, 2900);

  check('an invoice with no lines still has services []', voided.services, []);
  check('an invoice with no lines still has partsUsed []', voided.partsUsed, []);
  ok_('the empty arrays are arrays, not missing keys',
    Array.isArray(voided.services) && Array.isArray(voided.partsUsed), Object.keys(voided));
  ok_('lines are attached to the right parent',
    full.services.length === 2 && voided.services.length === 0, 'lines crossed between invoices');
}
{
  const db = stubDB({ invoices: [INVOICES[0]], services: SERVICES, parts: PARTS });
  await call('/api/invoices', { DB: db });
  const svc = db.calls.find(c => c.sql.includes('invoice_services'));
  const prt = db.calls.find(c => c.sql.includes('invoice_parts'));
  ok_('services ordered by invoice, line_no, id', /ORDER BY invoice_id, line_no, id/.test(svc.sql), svc.sql);
  ok_('parts ordered by invoice, line_no, id', /ORDER BY invoice_id, line_no, id/.test(prt.sql), prt.sql);
  ok_('the id tie-break is present because line_no is not unique',
    svc.sql.includes('line_no, id'), svc.sql);
}
{
  // Two lines sharing a line_no must come back in a deterministic order.
  const DUP = [
    { invoice_id: 'INV-0001', service_id: 'SRV-0009', name: 'Check A', qty: 1, unit_price: 100, total: 100 },
    { invoice_id: 'INV-0001', service_id: 'SRV-0010', name: 'Check B', qty: 1, unit_price: 100, total: 100 },
  ];
  const first = await (await call('/api/invoices/INV-0001', { DB: stubDB({ invoices: INVOICES, services: DUP }) })).json();
  const second = await (await call('/api/invoices/INV-0001', { DB: stubDB({ invoices: INVOICES, services: DUP }) })).json();
  check('duplicate line_no yields both lines', first.data.services.length, 2);
  check('duplicate line_no ordering is stable across requests',
    first.data.services.map(s => s.name), second.data.services.map(s => s.name));
}

/* ---------- 3. historical snapshots ---------- */
console.log('\n-- 3. Snapshots are never refreshed from the catalogue --');
{
  const db = stubDB({ invoices: [INVOICES[0]], services: SERVICES, parts: PARTS });
  const body = await (await call('/api/invoices/INV-0001', { DB: db })).json();
  const [s1] = body.data.services;
  check('service name is the billed snapshot', s1.name, 'Premium Oil Change (2024)');
  check('service unitPrice is the billed snapshot', s1.unitPrice, 1200);
  check('serviceId still points at the catalogue row', s1.serviceId, 'SRV-0001');
  const [p1] = body.data.partsUsed;
  check('part name is the billed snapshot', p1.name, 'Engine Oil 5W-30 (2024 label)');
  check('part number is the billed snapshot', p1.partNo, 'LEGACY-EO-4L');
  check('part unitPrice is the billed snapshot', p1.unitPrice, 2800);

  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('the services catalogue is never queried', !/FROM\s+services\b/i.test(sql), sql);
  ok_('the parts catalogue is never queried', !/FROM\s+parts\b/i.test(sql), sql);
  ok_('nothing is joined', !/\bJOIN\b/i.test(sql), sql);
  ok_('only the three invoice tables are read',
    db.tables.every(t => ['invoices', 'services', 'parts', 'count'].includes(t)), db.tables);
}
{
  const db = stubDB({ invoices: [INVOICES[0]], services: SERVICES, parts: PARTS });
  const body = await (await call('/api/invoices/INV-0001', { DB: db })).json();
  const manual = body.data.partsUsed.find(p => p.partId === null);
  ok_('a manual line is present', Boolean(manual), JSON.stringify(body.data.partsUsed));
  check('manual line keeps partId null', manual.partId, null);
  check('manual line keeps its name', manual.name, 'Custom gasket (hand cut)');
  check('manual line keeps its part number', manual.partNo, 'MANUAL-01');
  check('manual line keeps its price and total', [manual.unitPrice, manual.total], [150, 300]);
  check('manual line keeps its qty', manual.qty, 2);
  ok_('a manual line is not promoted to a catalogue part', manual.partId !== '', JSON.stringify(manual));
}

/* ---------- 4. financial values are stored, not computed ---------- */
console.log('\n-- 4. Financial values come back as stored --');
{
  // Deliberately inconsistent figures: anything that recomputed would "correct"
  // these and the assertions below would fail.
  const ODD = [{ ...INVOICES[0], id: 'INV-0099',
    labour_cost: 42, discount: 3, tax_rate: 17.5,
    subtotal: 9999, tax: 7, total: 12345, paid: 11, due: 12334, status: 'Partial' }];
  const body = await (await call('/api/invoices/INV-0099', { DB: stubDB({ invoices: ODD }) })).json();
  check('subtotal as stored', body.data.subtotal, 9999);
  check('tax as stored', body.data.tax, 7);
  check('total as stored', body.data.total, 12345);
  check('labourCost as stored', body.data.labourCost, 42);
  check('discount as stored', body.data.discount, 3);
  check('taxRate as stored', body.data.taxRate, 17.5);
  check('paid as stored', body.data.paid, 11);
  check('due as stored', body.data.due, 12334);
  check('status as stored, not re-derived from paid/total', body.data.status, 'Partial');
  ok_('subtotal was not rebuilt from the line totals', body.data.subtotal === 9999, `got ${body.data.subtotal}`);
  ok_('due was not recomputed as total - paid',
    body.data.due === 12334 && body.data.total - body.data.paid === 12334, 'due was recomputed');
}
{
  // A 'Paid' status on an invoice with money still due would be corrected by
  // any re-derivation. It is reported as stored.
  const MISMATCH = [{ ...INVOICES[0], id: 'INV-0098', total: 5000, paid: 1000, due: 4000, status: 'Paid' }];
  const body = await (await call('/api/invoices/INV-0098', { DB: stubDB({ invoices: MISMATCH }) })).json();
  check('a status that disagrees with paid/total is still reported', body.data.status, 'Paid');
  check('and its paid/due with it', [body.data.paid, body.data.due], [1000, 4000]);
}
{
  const db = stubDB({ invoices: INVOICES, services: SERVICES, parts: PARTS });
  const body = await (await call('/api/invoices/INV-0001', { DB: db })).json();
  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('payments are never queried', !/\bpayments\b/i.test(sql), sql);
  ok_('job_cards are never queried', !/\bjob_cards\b/i.test(sql), sql);
  const keys = Object.keys(body.data);
  ok_('no livePaid / liveDue invented', !keys.some(k => /^live/i.test(k)), keys);
  ok_('no balance field invented', !keys.some(k => /balance/i.test(k)), keys);
  ok_('no payments array embedded', !keys.includes('payments'), keys);
}

/* ---------- 5. void invoices ---------- */
console.log('\n-- 5. A Void invoice is reported exactly as stored --');
{
  const db = stubDB({ invoices: INVOICES, services: SERVICES, parts: PARTS });
  const body = await (await call('/api/invoices/INV-0002', { DB: db })).json();
  check('status Void', body.data.status, 'Void');
  // voidInvoice() freezes these rather than zeroing them; finding1.test.cjs
  // asserts the same 1935 on the client side.
  check('a Void invoice keeps its frozen paid', body.data.paid, 3000);
  check('a Void invoice keeps its frozen due', body.data.due, 1935);
  check('and its total', body.data.total, 4935);
  ok_('due was not forced to 0 because the invoice is Void',
    body.data.due === 1935, `got ${body.data.due}`);
  check('the job card link is null, as voidInvoice leaves it', body.data.jobCardId, null);
  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('no payment query was made to reconcile the void',
    !/\bpayments\b/i.test(sql), sql);
  ok_('released payments were not looked up', !sql.includes('invoice_id IS NULL'), sql);
}

/* ---------- 6. empty and pagination ---------- */
console.log('\n-- 6. Empty result and pagination --');
{
  const db = stubDB({ invoices: [] });
  const res = await call('/api/invoices', { DB: db });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('data empty', body.data, []);
  check('count 0', body.count, 0);
  check('total 0', body.total, 0);
  check('an empty page runs no line queries', db.calls.length, 2);
}
{
  const db = stubDB({ invoices: [INVOICES[1]], total: 2 });
  const body = await (await call('/api/invoices?limit=1&offset=1', { DB: db })).json();
  check('limit echoed', body.limit, 1);
  check('offset echoed', body.offset, 1);
  check('count is the page', body.count, 1);
  check('total is the table', body.total, 2);
  const q = db.calls.find(c => c.sql.includes('FROM invoices') && !c.sql.includes('count(*)'));
  ok_('limit/offset bound', JSON.stringify(q.binds) === '[1,1]', JSON.stringify(q.binds));
  ok_('numbered placeholders', q.sql.includes('?1') && q.sql.includes('?2'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('ordering is newest first with an id tie-break',
    /ORDER BY created_at DESC, id DESC/.test(q.sql), q.sql);
}
{
  const body = await (await call('/api/invoices', { DB: stubDB({ invoices: [] }) })).json();
  check('default limit', body.limit, 500);
  check('default offset', body.offset, 0);
}
{
  const res = await call('/api/invoices?limit=1000', { DB: stubDB({ invoices: [] }) });
  check('limit at the maximum accepted', res.status, 200);
  const r500 = await call('/api/invoices?limit=500', { DB: stubDB({ invoices: [] }) });
  check('limit 500 accepted', r500.status, 200);
}
for (const [q, why] of [
  ['limit=0', 'below minimum'], ['limit=1001', 'above maximum'], ['limit=-3', 'negative'],
  ['limit=abc', 'not a number'], ['limit=1.5', 'not an integer'],
  ['offset=-1', 'negative offset'], ['offset=abc', 'offset not a number'],
]) {
  const db = stubDB({ invoices: INVOICES });
  const res = await call('/api/invoices?' + q, { DB: db });
  const body = await res.json();
  ok_(`${q} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_parameter', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 7. query strategy: bounded, no N+1 ---------- */
console.log('\n-- 7. Query strategy --');
{
  const db = stubDB({ invoices: INVOICES, services: SERVICES, parts: PARTS });
  await call('/api/invoices', { DB: db });
  check('a 2-row page costs 4 queries', db.calls.length, 4);
  check('one of each kind', db.tables.sort(), ['count', 'invoices', 'parts', 'services']);
}
{
  const many = Array.from({ length: 40 }, (_, i) => ({ ...INVOICES[1], id: `INV-${1000 + i}` }));
  const db = stubDB({ invoices: many });
  const body = await (await call('/api/invoices?limit=40', { DB: db })).json();
  check('40 rows returned', body.count, 40);
  check('still 4 queries — no N+1', db.calls.length, 4);
  ok_('40 invoices did not cost 81 queries', db.calls.length < 81, `${db.calls.length} queries`);
  ok_('every row got its own empty line arrays',
    body.data.every(i => Array.isArray(i.services) && i.services.length === 0), 'lines leaked');
}
{
  const many = Array.from({ length: 500 }, (_, i) => ({ ...INVOICES[1], id: `INV-${3000 + i}` }));
  const db = stubDB({ invoices: many });
  await call('/api/invoices?limit=500', { DB: db });
  check('a 500-row page still costs 4 queries', db.calls.length, 4);
}
{
  const db = stubDB({ invoices: [INVOICES[0]], services: SERVICES, parts: PARTS });
  await call('/api/invoices/INV-0001', { DB: db });
  check('detail of an existing invoice costs 3 queries', db.calls.length, 3);
  check('parent, then the two line tables', db.tables, ['invoices', 'services', 'parts']);
}
{
  const db = stubDB({ invoices: INVOICES });
  const res = await call('/api/invoices/INV-8888', { DB: db });
  check('unknown id -> 404', res.status, 404);
  check('a 404 costs exactly one query', db.calls.length, 1);
  ok_('no line query ran after the 404',
    !db.calls.some(c => c.sql.includes('invoice_services') || c.sql.includes('invoice_parts')),
    db.tables);
}

/* ---------- 8. SQLite variable-limit safety ---------- */
console.log('\n-- 8. SQLite variable safety --');
{
  const many = Array.from({ length: 1000 }, (_, i) => ({ ...INVOICES[1], id: `INV-${2000 + i}` }));
  const db = stubDB({ invoices: many });
  const res = await call('/api/invoices?limit=1000', { DB: db });
  const body = await res.json();
  check('limit=1000 succeeds', res.status, 200);
  check('all 1000 rows returned', body.count, 1000);

  const lineCalls = db.calls.filter(c =>
    c.sql.includes('invoice_services') || c.sql.includes('invoice_parts'));
  check('the ids were split into two chunks per table', lineCalls.length, 4);
  check('total query count for a 1000-row page', db.calls.length, 6);
  const worst = Math.max(...lineCalls.map(c => (c.binds ?? []).length));
  ok_(`no query binds more than 500 variables (worst: ${worst})`, worst <= 500, String(worst));
  ok_('every chunk is non-empty', lineCalls.every(c => (c.binds ?? []).length > 0), 'empty chunk issued');
  const bound = new Set(lineCalls.flatMap(c => c.binds ?? []));
  check('every invoice id was bound exactly once across the chunks', bound.size, 1000);
  ok_('placeholders match the bind count in each query',
    lineCalls.every(c => (c.sql.match(/\?\d+/g) || []).length === (c.binds ?? []).length),
    'placeholder/bind mismatch');
  ok_('no invoice id appears literally in the generated SQL',
    !lineCalls.some(c => /INV-\d/.test(c.sql)), lineCalls[0].sql.slice(0, 140));
}
{
  const many = Array.from({ length: 500 }, (_, i) => ({ ...INVOICES[1], id: `INV-${4000 + i}` }));
  const db = stubDB({ invoices: many });
  await call('/api/invoices?limit=500', { DB: db });
  const lineCalls = db.calls.filter(c => c.sql.includes('invoice_'));
  check('500 ids fit in a single chunk per table', lineCalls.length, 2);
  check('and bind 500 variables each', lineCalls.map(c => c.binds.length), [500, 500]);
}
{
  const many = Array.from({ length: 501 }, (_, i) => ({ ...INVOICES[1], id: `INV-${5000 + i}` }));
  const db = stubDB({ invoices: many });
  await call('/api/invoices?limit=1000', { DB: db });
  const svc = db.calls.filter(c => c.sql.includes('invoice_services'));
  check('501 ids spill into a second chunk', svc.length, 2);
  check('chunk sizes', svc.map(c => c.binds.length), [500, 1]);
}

/* ---------- 9. failure modes ---------- */
console.log('\n-- 9. Failure modes --');
{
  const res = await call('/api/invoices', { DB: stubDB({ invoices: [], throwOn: 'FROM invoices' }) });
  const body = await res.json();
  check('parent query failure -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  check('message names the collection', body.error.message, 'Could not read invoices.');
  ok_('no driver detail leaked', !JSON.stringify(body).includes('D1_ERROR'), JSON.stringify(body));
}
{
  const res = await call('/api/invoices', { DB: stubDB({ invoices: INVOICES, throwOn: 'invoice_services' }) });
  const body = await res.json();
  check('service-line query failure -> 500', res.status, 500);
  ok_('no partial invoice returned', body.data === undefined, JSON.stringify(body).slice(0, 120));
}
{
  const res = await call('/api/invoices', { DB: stubDB({ invoices: INVOICES, throwOn: 'invoice_parts' }) });
  const body = await res.json();
  check('part-line query failure -> 500', res.status, 500);
  ok_('no partial invoice returned', body.data === undefined, JSON.stringify(body).slice(0, 120));
}
{
  const res = await call('/api/invoices/INV-0001', { DB: stubDB({ invoices: INVOICES, throwOn: 'invoice_parts' }) });
  const body = await res.json();
  check('detail line failure -> 500', res.status, 500);
  check('message names the singular', body.error.message, 'Could not read invoice.');
}
{
  const res = await call('/api/invoices', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
{
  const res = await call('/api/invoices/INV-0001', {});
  const body = await res.json();
  check('detail missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const rl = await call('/api/invoices', { DB: stubDB({ invoices: INVOICES }) }, { method: m });
  ok_(`${m} list -> 405`, rl.status === 405, `got ${rl.status}`);
  const rd = await call('/api/invoices/INV-0001', { DB: stubDB({ invoices: INVOICES }) }, { method: m });
  ok_(`${m} detail -> 405`, rd.status === 405, `got ${rd.status}`);
}
{
  const rl = await call('/api/invoices', { DB: stubDB({ invoices: INVOICES }) }, { method: 'POST' });
  check('405 sets Allow on the list', rl.headers.get('allow'), 'GET');
  const rd = await call('/api/invoices/INV-0001', { DB: stubDB({ invoices: INVOICES }) }, { method: 'POST' });
  check('405 sets Allow on the detail', rd.headers.get('allow'), 'GET');
}

console.log('\n=== GET /api/invoices/:id ===');

/* ---------- 10. detail and id handling ---------- */
console.log('\n-- 10. Valid, unknown and invalid ids --');
{
  const res = await call('/api/invoices/INV-0001', { DB: stubDB({ invoices: INVOICES, services: SERVICES, parts: PARTS }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  ok_('data is a single object', body.data && !Array.isArray(body.data), JSON.stringify(body.data).slice(0, 80));
  check('the requested invoice is returned', body.data.id, 'INV-0001');
  check('only a data key', Object.keys(body).sort(), ['data']);
  check('its lines came with it', [body.data.services.length, body.data.partsUsed.length], [2, 2]);
}
{
  const listBody = await (await call('/api/invoices', { DB: stubDB({ invoices: INVOICES, services: SERVICES, parts: PARTS }) })).json();
  const detail = await (await call('/api/invoices/INV-0001', { DB: stubDB({ invoices: INVOICES, services: SERVICES, parts: PARTS }) })).json();
  check('detail record matches the list record',
    JSON.stringify(detail.data), JSON.stringify(listBody.data.find(i => i.id === 'INV-0001')));
}
{
  const res = await call('/api/invoices/INV-8888', { DB: stubDB({ invoices: INVOICES }) });
  const body = await res.json();
  check('unknown id -> 404', res.status, 404);
  check('error code', body.error.code, 'not_found');
  check('message', body.error.message, 'No invoice with that id.');
  ok_('no table name or SQL leaked', !JSON.stringify(body).match(/SELECT|sqlite/i), JSON.stringify(body));
}
for (const other of ['JOB-9001', 'CUS-9001', 'PRT-9001', 'VEH-9001', 'APT-9001', 'SRV-9001', 'MEC-9001', 'PAY-9001']) {
  const res = await call('/api/invoices/' + other, { DB: stubDB({ invoices: INVOICES }) });
  ok_(`${other} on the invoices route -> 404, not 400`, res.status === 404, `got ${res.status}`);
}
for (const [path, why] of [
  ['/api/invoices/', 'empty / trailing slash'],
  ['/api/invoices/abc', 'no numeric part'],
  ['/api/invoices/INV0001', 'missing hyphen'],
  ['/api/invoices/INV-', 'no digits'],
  ['/api/invoices/-0001', 'no prefix'],
  ['/api/invoices/INV-0001-extra', 'trailing junk'],
  ['/api/invoices/INVOICES-1', 'prefix too long'],
  ['/api/invoices/I-1', 'prefix too short'],
  ['/api/invoices/' + 'I'.repeat(40) + '-1', 'too long'],
]) {
  const db = stubDB({ invoices: INVOICES });
  const res = await call(path, { DB: db });
  const body = await res.json();
  ok_(`${path} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_id', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 11. injection ---------- */
console.log('\n-- 11. Injection-style ids --');
for (const raw of [
  "INV-0001' OR '1'='1",
  "INV-0001; DROP TABLE invoices",
  "INV-0001'; DELETE FROM invoice_parts --",
  "INV-0001'; UPDATE invoices SET paid=0, due=0, status='Void' --",
  "' UNION SELECT id,customer_id,total FROM invoices --",
  '../../etc/passwd',
  'INV-0001%00',
  '<script>alert(1)</script>',
]) {
  const db = stubDB({ invoices: INVOICES });
  const res = await call('/api/invoices/' + encodeURIComponent(raw), { DB: db });
  ok_(`rejected: ${raw.slice(0, 40)}`, res.status === 400, `got ${res.status}`);
  ok_('   ...nothing reached the database', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/invoices/%zz', { DB: stubDB({ invoices: INVOICES }) });
  const body = await res.json();
  check('malformed URL encoding -> 400', res.status, 400);
  check('error code', body.error.code, 'invalid_id');
}

/* ---------- 12. SQL safety ---------- */
console.log('\n-- 12. SQL safety --');
{
  const db = stubDB({ invoices: [INVOICES[0]], services: SERVICES, parts: PARTS });
  await call('/api/invoices/INV-0001', { DB: db });
  const [parent, svc, prt] = db.calls;
  check('exactly three queries', db.calls.length, 3);
  ok_('id bound on the parent', JSON.stringify(parent.binds) === '["INV-0001"]', JSON.stringify(parent.binds));
  ok_('id absent from the parent SQL text', !parent.sql.includes('INV-0001'), parent.sql);
  ok_('parent bounded with LIMIT 1', parent.sql.includes('LIMIT 1'), parent.sql);
  ok_('id bound on the service query', JSON.stringify(svc.binds) === '["INV-0001"]', JSON.stringify(svc.binds));
  ok_('id bound on the part query', JSON.stringify(prt.binds) === '["INV-0001"]', JSON.stringify(prt.binds));
  ok_('id absent from the line SQL text',
    !svc.sql.includes('INV-0001') && !prt.sql.includes('INV-0001'), svc.sql);
  for (const c of db.calls) {
    const which = c.sql.includes('invoice_services') ? 'services'
      : c.sql.includes('invoice_parts') ? 'parts' : 'parent';
    ok_(`no SELECT * in the ${which} query`, !c.sql.includes('SELECT *'), c.sql.slice(0, 80));
  }
  ok_('the parent selects the money columns explicitly',
    parent.sql.includes('subtotal') && parent.sql.includes('paid') && parent.sql.includes('due')
      && parent.sql.includes('status'), parent.sql);
}

/* ---------- 13. relationships ---------- */
console.log('\n-- 13. Relationships are ids only --');
{
  const body = await (await call('/api/invoices/INV-0001',
    { DB: stubDB({ invoices: INVOICES, services: SERVICES, parts: PARTS }) })).json();
  const keys = Object.keys(body.data);
  check('all three references present',
    ['jobCardId', 'customerId', 'vehicleId'].every(k => k in body.data), true);
  ok_('no customer object', !keys.some(k => /^customer($|[A-Z])/.test(k) && k !== 'customerId'), keys);
  ok_('no vehicle object', !keys.some(k => /^vehicle($|[A-Z])/.test(k) && k !== 'vehicleId'), keys);
  ok_('no job card object', !keys.some(k => /^jobCard($|[A-Z])/.test(k) && k !== 'jobCardId'), keys);
  ok_('no customer name or vehicle reg leaked in',
    !['customerName', 'customerPhone', 'vehicleRegNo', 'jobCardStatus'].some(k => keys.includes(k)), keys);
  check('services and partsUsed are the only nested arrays',
    keys.filter(k => Array.isArray(body.data[k])).sort(), ['partsUsed', 'services']);
}

/* ---------- 14. routing ---------- */
console.log('\n-- 14. Routing --');
{
  const res = await call('/api/health', { DB: stubDB({ invoices: [{ name: 'customers' }], total: 17 }) });
  const body = await res.json();
  check('health 200', res.status, 200);
  ok_('health advertises the invoices routes',
    body.data.routes.includes('GET /api/invoices')
      && body.data.routes.includes('GET /api/invoices/:id'),
    JSON.stringify(body.data.routes));
}
{
  const res = await call('/api/nope', { DB: stubDB({ invoices: [] }) });
  const body = await res.json();
  check('unknown collection -> 404', res.status, 404);
  ok_('404 advertises the invoices routes',
    body.error.available.includes('GET /api/invoices')
      && body.error.available.includes('GET /api/invoices/:id'),
    JSON.stringify(body.error.available));
}
{
  // Derived from what health advertises, not hardcoded, so a later phase that
  // ships these does not have to come back and edit this.
  const advertised = (await (await call('/api/health',
    { DB: stubDB({ invoices: [{ name: 'customers' }] }) })).json()).data.routes;
  const unregistered = ['payments', 'expenses', 'inventory-transactions', 'invoice', 'settings']
    .filter(name => !advertised.includes(`GET /api/${name}`));
  ok_('at least one unregistered collection was found to probe',
    unregistered.length > 0, JSON.stringify(advertised));
  for (const name of unregistered) {
    const r = await call(`/api/${name}`, { DB: stubDB({ invoices: [] }) });
    ok_(`/api/${name} is not a route -> 404`, r.status === 404, `got ${r.status}`);
  }
}

console.log(`\nGET /api/invoices unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
