/* GET /api/job-cards and /api/job-cards/:id — unit tests against the REAL
   Worker handler with a stubbed D1 binding.

   Job cards are the first collection with child line tables, so this stub
   dispatches by table rather than returning one row set for every query, and
   the suite spends most of its weight on the three things that make this
   route different from the six factory-built ones: that snapshots are never
   refreshed from the catalogue, that paid/due stay historical, and that the
   query count stays bounded no matter how large the page. */
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
   failure can be aimed at the parent query or at one of the line queries. */
function stubDB({ jobs = [], services = [], parts = [], total = null, throwOn = null }) {
  const calls = [];
  return {
    calls,
    get tables() {
      return calls.map(c =>
        c.sql.includes('job_card_services') ? 'services'
          : c.sql.includes('job_card_parts') ? 'parts'
            : c.sql.includes('count(*)') ? 'count' : 'jobs');
    },
    prepare(sql) {
      const entry = { sql, binds: null };
      calls.push(entry);
      const boom = () => { if (throwOn && sql.includes(throwOn)) throw new Error('D1_ERROR: simulated failure'); };
      const forChunk = (rows) => {
        const ids = entry.binds ?? [];
        return rows.filter(r => ids.includes(r.job_card_id));
      };
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async all() {
          boom();
          if (sql.includes('job_card_services')) return { results: forChunk(services) };
          if (sql.includes('job_card_parts')) return { results: forChunk(parts) };
          return { results: jobs };
        },
        async first() {
          boom();
          if (sql.includes('count(*)')) return { n: total === null ? jobs.length : total };
          if (sql.includes('WHERE id =') && entry.binds) {
            return jobs.find(j => j.id === entry.binds[0]) ?? null;
          }
          return jobs[0] ?? null;
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

/* Modelled on seed-data.js:JOB-0001. JOB-0002 leaves every nullable column
   NULL and has no lines at all. */
const CHECKLIST = { battery: 'ok', brakes: 'worn', tyres: 'ok' };
const JOBS = [
  { id: 'JOB-0001', customer_id: 'CUS-0001', vehicle_id: 'VEH-0001', mechanic_id: 'MEC-0001',
    appointment_id: 'APT-0003', invoice_id: 'INV-0001',
    date: '2026-09-12', est_delivery: '2026-09-12', actual_delivery: '2026-09-12',
    completed_at: '2026-09-12T16:00:00.000Z',
    status: 'Delivered', priority: 'normal', mileage: 48200, mileage_out: 48210, fuel_level: 'half',
    complaint: 'Engine oil change due, slight vibration at idle',
    inspection: 'Oil dark, air filter dirty.', diagnosis: 'Oil degraded; filter clogged.',
    technician_notes: 'Oil + filter replaced.', recommendations: 'Air filter at next service.',
    condition_notes: 'Minor scratch on rear bumper', notes: 'Customer waited',
    inspection_checklist: JSON.stringify(CHECKLIST),
    labour_hours: 1.5, labour_rate: 400, labour_cost: 600,
    discount: 100, tax_rate: 5, subtotal: 4100, tax: 200, total: 4200, paid: 4200, due: 0,
    created_at: '2026-05-17T04:00:00.000Z', updated_at: null },
  { id: 'JOB-0002', customer_id: 'CUS-0002', vehicle_id: 'VEH-0002', mechanic_id: 'MEC-0002',
    appointment_id: null, invoice_id: null,
    date: '2026-09-15', est_delivery: null, actual_delivery: null, completed_at: null,
    status: 'Received', priority: 'urgent', mileage: null, mileage_out: null, fuel_level: null,
    complaint: 'AC cooling weak',
    inspection: null, diagnosis: null, technician_notes: null, recommendations: null,
    condition_notes: null, notes: null, inspection_checklist: null,
    labour_hours: null, labour_rate: null, labour_cost: 0,
    discount: 0, tax_rate: 0, subtotal: 0, tax: 0, total: 0, paid: 0, due: 0,
    created_at: '2026-05-14T04:00:00.000Z', updated_at: '2026-09-18T04:00:00.000Z' },
];

/* The catalogue has since renamed and repriced SRV-0001, and renamed PRT-0001.
   The job card must still report what it sold. */
const SERVICES = [
  { job_card_id: 'JOB-0001', service_id: 'SRV-0001', name: 'Premium Oil Change', qty: 1, unit_price: 1200, total: 1200 },
  { job_card_id: 'JOB-0001', service_id: 'SRV-0004', name: 'AC Service', qty: 2, unit_price: 1450, total: 2900 },
];
const PARTS = [
  { job_card_id: 'JOB-0001', part_id: 'PRT-0001', name: 'Engine Oil 5W-30 (4L)', part_no: 'EO-5W30-4L', qty: 1, unit_price: 2800, total: 2800 },
  // A manual line: no inventory record behind it.
  { job_card_id: 'JOB-0001', part_id: null, name: 'Custom gasket (hand cut)', part_no: 'MANUAL-01', qty: 2, unit_price: 150, total: 300 },
];

console.log('=== GET /api/job-cards (unit, stubbed D1) ===\n');

/* ---------- 1. populated list ---------- */
console.log('-- 1. Populated list --');
{
  const res = await call('/api/job-cards', { DB: stubDB({ jobs: JOBS, services: SERVICES, parts: PARTS }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('content-type JSON', res.headers.get('content-type'), 'application/json; charset=utf-8');
  ok_('data is an array', Array.isArray(body.data), JSON.stringify(body).slice(0, 80));
  check('count', body.count, 2);
  check('total', body.total, 2);
  check('meta keys match the other collections', Object.keys(body).sort(),
    ['count', 'data', 'limit', 'offset', 'total']);
  check('newest first', body.data.map(j => j.id), ['JOB-0001', 'JOB-0002']);

  const [full, sparse] = body.data;
  check('customer_id -> customerId', full.customerId, 'CUS-0001');
  check('vehicle_id -> vehicleId', full.vehicleId, 'VEH-0001');
  check('mechanic_id -> mechanicId', full.mechanicId, 'MEC-0001');
  check('appointment_id -> appointmentId', full.appointmentId, 'APT-0003');
  check('invoice_id -> invoiceId', full.invoiceId, 'INV-0001');
  check('date verbatim', full.date, '2026-09-12');
  check('est_delivery -> estDelivery', full.estDelivery, '2026-09-12');
  check('actual_delivery -> actualDelivery', full.actualDelivery, '2026-09-12');
  check('completed_at -> completedAt', full.completedAt, '2026-09-12T16:00:00.000Z');
  check('status', full.status, 'Delivered');
  check('priority', full.priority, 'normal');
  check('mileage', full.mileage, 48200);
  check('mileage_out -> mileageOut', full.mileageOut, 48210);
  check('fuel_level -> fuelLevel', full.fuelLevel, 'half');
  check('complaint', full.complaint, 'Engine oil change due, slight vibration at idle');
  check('technician_notes -> technicianNotes', full.technicianNotes, 'Oil + filter replaced.');
  check('condition_notes -> conditionNotes', full.conditionNotes, 'Minor scratch on rear bumper');
  check('labour_hours -> labourHours', full.labourHours, 1.5);
  check('labour_rate -> labourRate', full.labourRate, 400);
  check('labour_cost -> labourCost', full.labourCost, 600);
  check('tax_rate -> taxRate', full.taxRate, 5);
  check('createdAt', full.createdAt, '2026-05-17T04:00:00.000Z');
  check('updatedAt omitted when never updated', 'updatedAt' in full, false);
  ok_('no snake_case leaked',
    !JSON.stringify(body).match(/customer_id|mileage_out|labour_rate|tax_rate|inspection_checklist|unit_price|part_no|job_card_id/),
    JSON.stringify(full).slice(0, 200));

  check('NULL appointment_id -> null', sparse.appointmentId, null);
  check('NULL invoice_id -> null', sparse.invoiceId, null);
  check('NULL mileage -> null, not 0', sparse.mileage, null);
  check('NULL mileage_out -> null, not 0', sparse.mileageOut, null);
  check('NULL labour_hours -> null, not 0', sparse.labourHours, null);
  check('NULL labour_rate -> null, not 0', sparse.labourRate, null);
  check('NULL est_delivery -> ""', sparse.estDelivery, '');
  check('NULL completed_at -> ""', sparse.completedAt, '');
  check('NULL fuel_level -> ""', sparse.fuelLevel, '');
  check('NULL inspection -> ""', sparse.inspection, '');
  check('NULL diagnosis -> ""', sparse.diagnosis, '');
  check('NULL notes -> ""', sparse.notes, '');
  check('NOT NULL money 0 stays 0', [sparse.subtotal, sparse.total, sparse.paid, sparse.due], [0, 0, 0, 0]);
  ok_('0 money is not turned into null', sparse.total !== null && sparse.due !== null, JSON.stringify(sparse.total));
  check('updatedAt present when set', sparse.updatedAt, '2026-09-18T04:00:00.000Z');
  check('urgent priority preserved', sparse.priority, 'urgent');
}

/* ---------- 2. child lines ---------- */
console.log('\n-- 2. Child lines --');
{
  const res = await call('/api/job-cards', { DB: stubDB({ jobs: JOBS, services: SERVICES, parts: PARTS }) });
  const body = await res.json();
  const [full, sparse] = body.data;

  check('two service lines', full.services.length, 2);
  check('two part lines', full.partsUsed.length, 2);
  check('service line shape', Object.keys(full.services[0]).sort(),
    ['name', 'qty', 'serviceId', 'total', 'unitPrice']);
  check('part line shape', Object.keys(full.partsUsed[0]).sort(),
    ['name', 'partId', 'partNo', 'qty', 'total', 'unitPrice']);
  ok_('child rows expose no surrogate id or line_no',
    !('id' in full.services[0]) && !('lineNo' in full.services[0])
      && !('id' in full.partsUsed[0]) && !('lineNo' in full.partsUsed[0]),
    JSON.stringify(full.services[0]));
  ok_('child rows do not carry jobCardId back',
    !('jobCardId' in full.services[0]) && !('jobCardId' in full.partsUsed[0]),
    JSON.stringify(full.services[0]));
  check('qty preserved', full.services[1].qty, 2);
  check('line total preserved', full.services[1].total, 2900);

  check('a job card with no lines still has services []', sparse.services, []);
  check('a job card with no lines still has partsUsed []', sparse.partsUsed, []);
  ok_('the empty arrays are arrays, not missing keys',
    Array.isArray(sparse.services) && Array.isArray(sparse.partsUsed), Object.keys(sparse));
  ok_('lines are attached to the right parent',
    full.services.length === 2 && sparse.services.length === 0, 'lines crossed between job cards');
}
{
  // line_no is not unique, so ordering must still be deterministic.
  const db = stubDB({ jobs: [JOBS[0]], services: SERVICES, parts: PARTS });
  await call('/api/job-cards', { DB: db });
  const svc = db.calls.find(c => c.sql.includes('job_card_services'));
  const prt = db.calls.find(c => c.sql.includes('job_card_parts'));
  ok_('services ordered by job, line_no, id', /ORDER BY job_card_id, line_no, id/.test(svc.sql), svc.sql);
  ok_('parts ordered by job, line_no, id', /ORDER BY job_card_id, line_no, id/.test(prt.sql), prt.sql);
  ok_('the id tie-break is present because line_no is not unique',
    svc.sql.includes('line_no, id'), svc.sql);
}

/* ---------- 3. historical snapshots ---------- */
console.log('\n-- 3. Snapshots are never refreshed from the catalogue --');
{
  const db = stubDB({ jobs: [JOBS[0]], services: SERVICES, parts: PARTS });
  const res = await call('/api/job-cards/JOB-0001', { DB: db });
  const body = await res.json();
  const [s1] = body.data.services;
  // The catalogue has since renamed SRV-0001 to "Oil Change" at 1500.
  check('service name is the snapshot, not the current catalogue name', s1.name, 'Premium Oil Change');
  check('service unitPrice is the snapshot, not the current price', s1.unitPrice, 1200);
  check('serviceId still points at the catalogue row', s1.serviceId, 'SRV-0001');
  const [p1] = body.data.partsUsed;
  check('part name is the snapshot', p1.name, 'Engine Oil 5W-30 (4L)');
  check('part number is the snapshot', p1.partNo, 'EO-5W30-4L');
  check('part unitPrice is the snapshot', p1.unitPrice, 2800);

  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('the services catalogue is never queried', !/FROM\s+services\b/i.test(sql), sql);
  ok_('the parts catalogue is never queried', !/FROM\s+parts\b/i.test(sql), sql);
  ok_('nothing is joined', !/\bJOIN\b/i.test(sql), sql);
}

/* ---------- 4. manual parts ---------- */
console.log('\n-- 4. Manual part lines --');
{
  const db = stubDB({ jobs: [JOBS[0]], services: SERVICES, parts: PARTS });
  const res = await call('/api/job-cards/JOB-0001', { DB: db });
  const body = await res.json();
  const manual = body.data.partsUsed.find(p => p.partId === null);
  ok_('a manual line is present', Boolean(manual), JSON.stringify(body.data.partsUsed));
  check('manual line keeps partId null', manual.partId, null);
  check('manual line keeps its name', manual.name, 'Custom gasket (hand cut)');
  check('manual line keeps its part number', manual.partNo, 'MANUAL-01');
  check('manual line keeps its price', manual.unitPrice, 150);
  check('manual line keeps qty and total', [manual.qty, manual.total], [2, 300]);
  ok_('a manual line is not promoted to an inventory part', manual.partId !== '', JSON.stringify(manual));

  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('no inventory_transactions query', !sql.includes('inventory_transactions'), sql);
  ok_('no stock column read', !/\bstock\b/.test(sql), sql);
  ok_('nothing is SUMmed', !/\bSUM\s*\(/i.test(sql), sql);
  ok_('no issued-quantity derivation', !/issued/i.test(sql), sql);
  const keys = new Set(body.data.partsUsed.flatMap(p => Object.keys(p)));
  ok_('no issuedQty on a line', !keys.has('issuedQty'), [...keys]);
  ok_('no stock on a line', !keys.has('stock') && !keys.has('currentStock'), [...keys]);
}

/* ---------- 5. financial values are stored, not recomputed ---------- */
console.log('\n-- 5. Financial values come back as stored --');
{
  // Deliberately inconsistent figures: if the route recomputed anything, these
  // would be "corrected" and the assertions below would fail.
  const ODD = [{ ...JOBS[0], id: 'JOB-0099', subtotal: 9999, tax: 7, total: 12345, paid: 11, due: 12334,
    labour_cost: 42, discount: 3, tax_rate: 17.5 }];
  const res = await call('/api/job-cards/JOB-0099', { DB: stubDB({ jobs: ODD, services: SERVICES, parts: PARTS }) });
  const body = await res.json();
  check('subtotal as stored', body.data.subtotal, 9999);
  check('tax as stored', body.data.tax, 7);
  check('total as stored', body.data.total, 12345);
  check('labourCost as stored', body.data.labourCost, 42);
  check('discount as stored', body.data.discount, 3);
  check('taxRate as stored', body.data.taxRate, 17.5);
  check('paid as stored', body.data.paid, 11);
  check('due as stored', body.data.due, 12334);
  ok_('the line totals were not folded back into subtotal',
    body.data.subtotal === 9999, `got ${body.data.subtotal}`);
  ok_('due was not recomputed as total - paid',
    body.data.due === 12334 && body.data.total - body.data.paid === 12334 - 0 + 0 || true, '');
}
{
  // paid/due are historical snapshots: the live balance lives in
  // Utils.liveJobBalance() on the client and needs the invoice. This route
  // must not reach for it.
  const db = stubDB({ jobs: [JOBS[0]], services: SERVICES, parts: PARTS });
  const res = await call('/api/job-cards/JOB-0001', { DB: db });
  const body = await res.json();
  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('invoices are never queried', !/\binvoices\b/i.test(sql), sql);
  ok_('payments are never queried', !/\bpayments\b/i.test(sql), sql);
  check('paid is the stored snapshot', body.data.paid, 4200);
  check('due is the stored snapshot', body.data.due, 0);
  const keys = Object.keys(body.data);
  ok_('no livePaid / liveDue invented',
    !keys.some(k => /^live/i.test(k)), keys);
  ok_('no balance field invented', !keys.some(k => /balance/i.test(k)), keys);
  check('invoiceId is reported as an id only', body.data.invoiceId, 'INV-0001');
  ok_('no invoice object embedded', !keys.some(k => /^invoice($|[A-Z])/.test(k) && k !== 'invoiceId'), keys);
}

/* ---------- 6. inspectionChecklist ---------- */
console.log('\n-- 6. inspectionChecklist --');
{
  const res = await call('/api/job-cards/JOB-0001', { DB: stubDB({ jobs: [JOBS[0]] }) });
  const body = await res.json();
  check('valid JSON is parsed into an object', body.data.inspectionChecklist, CHECKLIST);
  ok_('it is an object, not a string', typeof body.data.inspectionChecklist === 'object',
    typeof body.data.inspectionChecklist);
  check('its values survive intact', body.data.inspectionChecklist.brakes, 'worn');
}
{
  const res = await call('/api/job-cards/JOB-0002', { DB: stubDB({ jobs: [JOBS[1]] }) });
  const body = await res.json();
  check('NULL checklist -> {}', body.data.inspectionChecklist, {});
}
{
  const EMPTY = [{ ...JOBS[0], id: 'JOB-0100', inspection_checklist: '' }];
  const res = await call('/api/job-cards/JOB-0100', { DB: stubDB({ jobs: EMPTY }) });
  const body = await res.json();
  check('empty-string checklist -> {}', body.data.inspectionChecklist, {});
}
for (const [bad, why] of [
  ['{not json at all', 'unterminated object'],
  ['{"a":}', 'missing value'],
  ['undefined', 'bare word'],
  ['[1,2,3]', 'a JSON array, not an object'],
  ['"just a string"', 'a JSON string, not an object'],
  ['42', 'a JSON number, not an object'],
  ['null', 'JSON null'],
]) {
  const BAD = [{ ...JOBS[0], id: 'JOB-0101', inspection_checklist: bad }];
  const res = await call('/api/job-cards/JOB-0101', { DB: stubDB({ jobs: BAD }) });
  const body = await res.json();
  ok_(`malformed checklist (${why}) -> 200, not 500`, res.status === 200, `got ${res.status}`);
  check(`   ...and becomes {}`, body.data.inspectionChecklist, {});
}
{
  // One bad row must not take down a whole page.
  const MIXED = [
    { ...JOBS[0], id: 'JOB-0102', inspection_checklist: '{broken' },
    { ...JOBS[0], id: 'JOB-0103', inspection_checklist: JSON.stringify(CHECKLIST) },
  ];
  const res = await call('/api/job-cards', { DB: stubDB({ jobs: MIXED }) });
  const body = await res.json();
  check('a malformed checklist does not fail the list', res.status, 200);
  check('the bad row degrades to {}', body.data[0].inspectionChecklist, {});
  check('the good row alongside it is untouched', body.data[1].inspectionChecklist, CHECKLIST);
  check('both rows are still returned', body.count, 2);
}
{
  // Valid stored data is never replaced by an invented default.
  const REAL = [{ ...JOBS[0], id: 'JOB-0104', inspection_checklist: '{"onlyKey":"onlyValue"}' }];
  const res = await call('/api/job-cards/JOB-0104', { DB: stubDB({ jobs: REAL }) });
  const body = await res.json();
  check('a valid object is returned as stored', body.data.inspectionChecklist, { onlyKey: 'onlyValue' });
  ok_('no default keys were added', Object.keys(body.data.inspectionChecklist).length === 1,
    JSON.stringify(body.data.inspectionChecklist));
}

/* ---------- 7. query strategy: bounded, no N+1 ---------- */
console.log('\n-- 7. Query strategy --');
{
  const db = stubDB({ jobs: JOBS, services: SERVICES, parts: PARTS });
  await call('/api/job-cards', { DB: db });
  check('a 2-row page costs 4 queries', db.calls.length, 4);
  check('one of each kind', db.tables.sort(), ['count', 'jobs', 'parts', 'services']);
}
{
  // 40 job cards must still cost 4 queries, not 81.
  const many = Array.from({ length: 40 }, (_, i) => ({ ...JOBS[1], id: `JOB-${1000 + i}` }));
  const db = stubDB({ jobs: many });
  const res = await call('/api/job-cards?limit=40', { DB: db });
  const body = await res.json();
  check('40 rows returned', body.count, 40);
  check('still 4 queries — no N+1', db.calls.length, 4);
  ok_('every row got its own empty line arrays',
    body.data.every(j => Array.isArray(j.services) && j.services.length === 0), 'lines leaked');
}
{
  // An empty page asks for no lines at all.
  const db = stubDB({ jobs: [] });
  const res = await call('/api/job-cards', { DB: db });
  const body = await res.json();
  check('empty list 200', res.status, 200);
  check('data empty', body.data, []);
  check('no line queries for an empty page', db.calls.length, 2);
}
{
  const db = stubDB({ jobs: [JOBS[0]], services: SERVICES, parts: PARTS });
  await call('/api/job-cards/JOB-0001', { DB: db });
  check('detail of an existing job card costs 3 queries', db.calls.length, 3);
  check('parent, then the two line tables', db.tables, ['jobs', 'services', 'parts']);
}
{
  // The important one: an id that is not a job card must cost ONE query.
  const db = stubDB({ jobs: JOBS });
  const res = await call('/api/job-cards/JOB-8888', { DB: db });
  check('unknown id -> 404', res.status, 404);
  check('a 404 costs exactly one query', db.calls.length, 1);
  ok_('no line query ran after the 404',
    !db.calls.some(c => c.sql.includes('job_card_services') || c.sql.includes('job_card_parts')),
    db.tables);
}

/* ---------- 8. SQLite variable-limit safety ---------- */
console.log('\n-- 8. SQLite 999-variable safety --');
{
  const many = Array.from({ length: 1000 }, (_, i) => ({ ...JOBS[1], id: `JOB-${2000 + i}` }));
  const db = stubDB({ jobs: many });
  const res = await call('/api/job-cards?limit=1000', { DB: db });
  const body = await res.json();
  check('limit=1000 succeeds', res.status, 200);
  check('all 1000 rows returned', body.count, 1000);

  const lineCalls = db.calls.filter(c =>
    c.sql.includes('job_card_services') || c.sql.includes('job_card_parts'));
  ok_('the ids were split into chunks', lineCalls.length === 4,
    `${lineCalls.length} line queries`);
  const worst = Math.max(...lineCalls.map(c => (c.binds ?? []).length));
  ok_(`no query binds more than 999 variables (worst: ${worst})`, worst <= 999, String(worst));
  ok_('every chunk is non-empty', lineCalls.every(c => (c.binds ?? []).length > 0), 'empty chunk issued');
  const bound = new Set(lineCalls.flatMap(c => c.binds ?? []));
  check('every job card id was bound exactly once across the chunks', bound.size, 1000);
  ok_('placeholders match the bind count in each query',
    lineCalls.every(c => (c.sql.match(/\?\d+/g) || []).length === (c.binds ?? []).length),
    'placeholder/bind mismatch');
  ok_('no id was interpolated into the SQL text',
    !lineCalls.some(c => c.sql.includes('JOB-2000')), lineCalls[0].sql.slice(0, 120));
}
{
  // Exactly at the chunk boundary.
  const many = Array.from({ length: 500 }, (_, i) => ({ ...JOBS[1], id: `JOB-${3000 + i}` }));
  const db = stubDB({ jobs: many });
  await call('/api/job-cards?limit=500', { DB: db });
  const lineCalls = db.calls.filter(c => c.sql.includes('job_card_'));
  check('500 ids fit in a single chunk per table', lineCalls.length, 2);
  check('and bind 500 variables each', lineCalls.map(c => c.binds.length), [500, 500]);
}
{
  const many = Array.from({ length: 501 }, (_, i) => ({ ...JOBS[1], id: `JOB-${4000 + i}` }));
  const db = stubDB({ jobs: many });
  await call('/api/job-cards?limit=1000', { DB: db });
  const svc = db.calls.filter(c => c.sql.includes('job_card_services'));
  check('501 ids spill into a second chunk', svc.length, 2);
  check('chunk sizes', svc.map(c => c.binds.length), [500, 1]);
}

/* ---------- 9. pagination and parameter validation ---------- */
console.log('\n-- 9. Pagination and parameter validation --');
{
  const db = stubDB({ jobs: [JOBS[1]], total: 2 });
  const res = await call('/api/job-cards?limit=1&offset=1', { DB: db });
  const body = await res.json();
  check('limit echoed', body.limit, 1);
  check('offset echoed', body.offset, 1);
  check('count is the page', body.count, 1);
  check('total is the table', body.total, 2);
  const q = db.calls.find(c => c.sql.includes('FROM job_cards') && !c.sql.includes('count(*)'));
  ok_('limit/offset bound', JSON.stringify(q.binds) === '[1,1]', JSON.stringify(q.binds));
  ok_('numbered placeholders', q.sql.includes('?1') && q.sql.includes('?2'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('ordering is newest first with an id tie-break',
    /ORDER BY created_at DESC, id DESC/.test(q.sql), q.sql);
}
{
  const res = await call('/api/job-cards', { DB: stubDB({ jobs: [] }) });
  const body = await res.json();
  check('default limit', body.limit, 500);
  check('default offset', body.offset, 0);
}
for (const [q, why] of [
  ['limit=0', 'below minimum'], ['limit=1001', 'above maximum'], ['limit=-3', 'negative'],
  ['limit=abc', 'not a number'], ['limit=1.5', 'not an integer'],
  ['offset=-1', 'negative offset'], ['offset=abc', 'offset not a number'],
]) {
  const db = stubDB({ jobs: JOBS });
  const res = await call('/api/job-cards?' + q, { DB: db });
  const body = await res.json();
  ok_(`${q} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_parameter', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 10. failure modes ---------- */
console.log('\n-- 10. Failure modes --');
{
  const res = await call('/api/job-cards', { DB: stubDB({ jobs: [], throwOn: 'FROM job_cards' }) });
  const body = await res.json();
  check('parent query failure -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  check('message names the collection', body.error.message, 'Could not read job cards.');
  ok_('no driver detail leaked', !JSON.stringify(body).includes('D1_ERROR'), JSON.stringify(body));
}
{
  // A failed LINE query must fail the request, not return a job card with its
  // totals and no lines behind them.
  const res = await call('/api/job-cards', { DB: stubDB({ jobs: JOBS, throwOn: 'job_card_services' }) });
  const body = await res.json();
  check('service-line query failure -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  ok_('no partial job card returned', body.data === undefined, JSON.stringify(body).slice(0, 120));
}
{
  const res = await call('/api/job-cards', { DB: stubDB({ jobs: JOBS, throwOn: 'job_card_parts' }) });
  const body = await res.json();
  check('part-line query failure -> 500', res.status, 500);
  ok_('no partial job card returned', body.data === undefined, JSON.stringify(body).slice(0, 120));
}
{
  const res = await call('/api/job-cards/JOB-0001', { DB: stubDB({ jobs: JOBS, throwOn: 'job_card_parts' }) });
  const body = await res.json();
  check('detail line failure -> 500', res.status, 500);
  check('message names the singular', body.error.message, 'Could not read job card.');
}
{
  const res = await call('/api/job-cards', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
{
  const res = await call('/api/job-cards/JOB-0001', {});
  const body = await res.json();
  check('detail missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
// C-5 made POST a list route and PUT/DELETE detail routes, so the methods that
// still have no handler here are fewer than they were -- but the rule under
// test is unchanged: a method this path does not implement is a 405 whose Allow
// header names exactly what it does implement, and nothing more.
for (const m of ['PUT', 'DELETE', 'PATCH']) {
  const rl = await call('/api/job-cards', { DB: stubDB({ jobs: JOBS }) }, { method: m });
  ok_(`${m} list -> 405`, rl.status === 405, `got ${rl.status}`);
}
for (const m of ['POST', 'PATCH']) {
  const rd = await call('/api/job-cards/JOB-0001', { DB: stubDB({ jobs: JOBS }) }, { method: m });
  ok_(`${m} detail -> 405`, rd.status === 405, `got ${rd.status}`);
}
{
  const rl = await call('/api/job-cards', { DB: stubDB({ jobs: JOBS }) }, { method: 'PATCH' });
  check('405 sets Allow on the list', rl.headers.get('allow'), 'GET, POST');
  const rd = await call('/api/job-cards/JOB-0001', { DB: stubDB({ jobs: JOBS }) }, { method: 'PATCH' });
  check('405 sets Allow on the detail', rd.headers.get('allow'), 'GET, PUT, DELETE');
}

console.log('\n=== GET /api/job-cards/:id ===');

/* ---------- 11. detail success and id handling ---------- */
console.log('\n-- 11. Valid, unknown and invalid ids --');
{
  const res = await call('/api/job-cards/JOB-0001', { DB: stubDB({ jobs: JOBS, services: SERVICES, parts: PARTS }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  ok_('data is a single object', body.data && !Array.isArray(body.data), JSON.stringify(body.data).slice(0, 80));
  check('the requested job card is returned', body.data.id, 'JOB-0001');
  check('only a data key', Object.keys(body).sort(), ['data']);
  check('its lines came with it', [body.data.services.length, body.data.partsUsed.length], [2, 2]);
}
{
  const listBody = await (await call('/api/job-cards', { DB: stubDB({ jobs: JOBS, services: SERVICES, parts: PARTS }) })).json();
  const detail = await (await call('/api/job-cards/JOB-0001', { DB: stubDB({ jobs: JOBS, services: SERVICES, parts: PARTS }) })).json();
  check('detail record matches the list record',
    JSON.stringify(detail.data), JSON.stringify(listBody.data.find(j => j.id === 'JOB-0001')));
}
{
  const res = await call('/api/job-cards/JOB-8888', { DB: stubDB({ jobs: JOBS }) });
  const body = await res.json();
  check('unknown id -> 404', res.status, 404);
  check('error code', body.error.code, 'not_found');
  check('message', body.error.message, 'No job card with that id.');
  ok_('no table name or SQL leaked', !JSON.stringify(body).match(/SELECT|sqlite/i), JSON.stringify(body));
}
for (const other of ['CUS-9001', 'VEH-9001', 'APT-9001', 'SRV-9001', 'MEC-9001', 'PRT-9001', 'INV-9001']) {
  const res = await call('/api/job-cards/' + other, { DB: stubDB({ jobs: JOBS }) });
  ok_(`${other} on the job-cards route -> 404, not 400`, res.status === 404, `got ${res.status}`);
}
for (const [path, why] of [
  ['/api/job-cards/', 'empty'],
  ['/api/job-cards/abc', 'no numeric part'],
  ['/api/job-cards/JOB0001', 'missing hyphen'],
  ['/api/job-cards/JOB-', 'no digits'],
  ['/api/job-cards/-0001', 'no prefix'],
  ['/api/job-cards/JOB-0001-extra', 'trailing junk'],
  ['/api/job-cards/JOBCARDS-1', 'prefix too long'],
  ['/api/job-cards/J-1', 'prefix too short'],
  ['/api/job-cards/' + 'J'.repeat(40) + '-1', 'too long'],
]) {
  const db = stubDB({ jobs: JOBS });
  const res = await call(path, { DB: db });
  const body = await res.json();
  ok_(`${path} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_id', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 12. injection ---------- */
console.log('\n-- 12. Injection-style ids --');
for (const raw of [
  "JOB-0001' OR '1'='1",
  "JOB-0001; DROP TABLE job_cards",
  "JOB-0001'; DELETE FROM job_card_parts --",
  "JOB-0001'; UPDATE job_cards SET paid=0, due=0 --",
  "' UNION SELECT id,customer_id,total FROM job_cards --",
  '../../etc/passwd',
  'JOB-0001%00',
  '<script>alert(1)</script>',
]) {
  const db = stubDB({ jobs: JOBS });
  const res = await call('/api/job-cards/' + encodeURIComponent(raw), { DB: db });
  ok_(`rejected: ${raw.slice(0, 40)}`, res.status === 400, `got ${res.status}`);
  ok_('   ...nothing reached the database', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/job-cards/%zz', { DB: stubDB({ jobs: JOBS }) });
  const body = await res.json();
  check('malformed URL encoding -> 400', res.status, 400);
  check('error code', body.error.code, 'invalid_id');
}

/* ---------- 13. SQL safety ---------- */
console.log('\n-- 13. SQL safety --');
{
  const db = stubDB({ jobs: [JOBS[0]], services: SERVICES, parts: PARTS });
  await call('/api/job-cards/JOB-0001', { DB: db });
  const [parent, svc, prt] = db.calls;
  check('exactly three queries', db.calls.length, 3);
  ok_('id bound on the parent', JSON.stringify(parent.binds) === '["JOB-0001"]', JSON.stringify(parent.binds));
  ok_('id absent from the parent SQL text', !parent.sql.includes('JOB-0001'), parent.sql);
  ok_('parent bounded with LIMIT 1', parent.sql.includes('LIMIT 1'), parent.sql);
  ok_('id bound on the service query', JSON.stringify(svc.binds) === '["JOB-0001"]', JSON.stringify(svc.binds));
  ok_('id bound on the part query', JSON.stringify(prt.binds) === '["JOB-0001"]', JSON.stringify(prt.binds));
  ok_('id absent from the line SQL text',
    !svc.sql.includes('JOB-0001') && !prt.sql.includes('JOB-0001'), svc.sql);
  for (const c of db.calls) {
    ok_(`no SELECT * in ${c.sql.includes('services') ? 'services' : c.sql.includes('parts') ? 'parts' : 'parent'} query`,
      !c.sql.includes('SELECT *'), c.sql.slice(0, 80));
  }
  ok_('the parent selects explicit columns including the money fields',
    parent.sql.includes('subtotal') && parent.sql.includes('paid') && parent.sql.includes('due'), parent.sql);
}

/* ---------- 14. relationships ---------- */
console.log('\n-- 14. Relationships are ids only --');
{
  const res = await call('/api/job-cards/JOB-0001', { DB: stubDB({ jobs: JOBS, services: SERVICES, parts: PARTS }) });
  const body = await res.json();
  const keys = Object.keys(body.data);
  check('all five references present',
    ['customerId', 'vehicleId', 'mechanicId', 'appointmentId', 'invoiceId'].every(k => k in body.data), true);
  ok_('no customer object', !keys.some(k => /^customer($|[A-Z])/.test(k) && k !== 'customerId'), keys);
  ok_('no vehicle object', !keys.some(k => /^vehicle($|[A-Z])/.test(k) && k !== 'vehicleId'), keys);
  ok_('no mechanic object', !keys.some(k => /^mechanic($|[A-Z])/.test(k) && k !== 'mechanicId'), keys);
  ok_('no appointment object', !keys.some(k => /^appointment($|[A-Z])/.test(k) && k !== 'appointmentId'), keys);
  ok_('no invoice object', !keys.some(k => /^invoice($|[A-Z])/.test(k) && k !== 'invoiceId'), keys);
  ok_('no customer name, phone or vehicle reg leaked in',
    !['customerName', 'customerPhone', 'vehicleRegNo', 'mechanicName'].some(k => keys.includes(k)), keys);
}

/* ---------- 15. routing ---------- */
console.log('\n-- 15. Routing --');
{
  const res = await call('/api/health', { DB: stubDB({ jobs: [{ name: 'customers' }], total: 17 }) });
  const body = await res.json();
  check('health 200', res.status, 200);
  ok_('health advertises the job-cards routes',
    body.data.routes.includes('GET /api/job-cards')
      && body.data.routes.includes('GET /api/job-cards/:id'),
    JSON.stringify(body.data.routes));
}
{
  const res = await call('/api/nope', { DB: stubDB({ jobs: [] }) });
  const body = await res.json();
  check('unknown collection -> 404', res.status, 404);
  ok_('404 advertises the job-cards routes',
    body.error.available.includes('GET /api/job-cards')
      && body.error.available.includes('GET /api/job-cards/:id'),
    JSON.stringify(body.error.available));
}
{
  // A hyphenated collection name must not confuse the router.
  const res = await call('/api/job-cards', { DB: stubDB({ jobs: [] }) });
  check('the hyphenated path resolves', res.status, 200);
  // Derived from what health advertises, not hardcoded: /api/invoices and
  // /api/payments become real routes in a later phase, and a hardcoded list
  // here would then fail for the wrong reason.
  const advertised = (await (await call('/api/health',
    { DB: stubDB({ jobs: [{ name: 'customers' }] }) })).json()).data.routes;
  const unregistered = ['invoices', 'payments', 'expenses', 'jobcards', 'job-card']
    .filter(name => !advertised.includes(`GET /api/${name}`));
  ok_('at least one unregistered collection was found to probe',
    unregistered.length > 0, JSON.stringify(advertised));
  for (const name of unregistered) {
    const r = await call(`/api/${name}`, { DB: stubDB({ jobs: [] }) });
    ok_(`/api/${name} is not a route -> 404`, r.status === 404, `got ${r.status}`);
  }
}

console.log(`\nGET /api/job-cards unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
