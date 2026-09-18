/* GET /api/appointments and /api/appointments/:id — unit tests against the
   REAL Worker handler with a stubbed D1 binding.

   Appointments is the collection with the most reference columns (five) and
   the first with a boolean and with stored date/time, so this suite pins down
   three things beyond the usual shape and safety checks: that nothing is
   joined, that all five canonical sources and all six statuses come back
   exactly as stored, and that date/time are never converted. */
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

const SOURCES = ['Admin', 'Phone', 'Walk-in', 'Facebook', 'Website'];
const STATUSES = ['Scheduled', 'Confirmed', 'In Progress', 'Completed', 'Cancelled', 'No Show'];

/* Modelled on seed-data.js:141-145.
   APT-0003 is fully populated and job-card-linked; APT-0002 leaves every
   nullable column NULL. */
const SEEDED = [
  { id: 'APT-0003', customer_id: 'CUS-0004', vehicle_id: 'VEH-0004', service_id: 'SRV-0010',
    mechanic_id: 'MEC-0001', job_card_id: 'JOB-0004',
    date: '2026-09-18', time: '09:00', duration: 120,
    status: 'Confirmed', source: 'Facebook',
    complaint: 'Full check before long trip', notes: 'Arrived on time',
    reminder_sent: 1, created_at: '2026-05-17T04:00:00.000Z', updated_at: null },
  { id: 'APT-0002', customer_id: 'CUS-0002', vehicle_id: 'VEH-0002', service_id: 'SRV-0005',
    mechanic_id: null, job_card_id: null,
    date: '2026-09-18', time: '12:30', duration: 60,
    status: 'Scheduled', source: 'Website',
    complaint: null, notes: null,
    reminder_sent: 0, created_at: '2026-05-14T04:00:00.000Z',
    updated_at: '2026-09-18T04:00:00.000Z' },
];

console.log('=== GET /api/appointments (unit, stubbed D1) ===\n');

/* ---------- 1. populated list ---------- */
console.log('-- 1. Populated list --');
{
  const res = await call('/api/appointments', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('content-type JSON', res.headers.get('content-type'), 'application/json; charset=utf-8');
  ok_('data is an array', Array.isArray(body.data), JSON.stringify(body).slice(0, 100));
  check('count', body.count, 2);
  check('total', body.total, 2);
  check('meta keys match the other collections', Object.keys(body).sort(),
    ['count', 'data', 'limit', 'offset', 'total']);
  check('newest first', body.data.map(a => a.id), ['APT-0003', 'APT-0002']);

  const [full, sparse] = body.data;
  check('customer_id -> customerId', full.customerId, 'CUS-0004');
  check('vehicle_id -> vehicleId', full.vehicleId, 'VEH-0004');
  check('service_id -> serviceId', full.serviceId, 'SRV-0010');
  check('mechanic_id -> mechanicId', full.mechanicId, 'MEC-0001');
  check('job_card_id -> jobCardId', full.jobCardId, 'JOB-0004');
  check('date mapped', full.date, '2026-09-18');
  check('time mapped', full.time, '09:00');
  check('duration mapped', full.duration, 120);
  check('status mapped', full.status, 'Confirmed');
  check('source mapped', full.source, 'Facebook');
  check('complaint mapped', full.complaint, 'Full check before long trip');
  check('notes mapped', full.notes, 'Arrived on time');
  check('reminder_sent 1 -> true', full.reminderSent, true);
  check('createdAt mapped', full.createdAt, '2026-05-17T04:00:00.000Z');
  check('updatedAt omitted when never updated', 'updatedAt' in full, false);

  check('NULL mechanic_id -> null, not ""', sparse.mechanicId, null);
  check('NULL job_card_id -> null, not ""', sparse.jobCardId, null);
  check('NULL complaint -> empty string', sparse.complaint, '');
  check('NULL notes -> empty string', sparse.notes, '');
  check('reminder_sent 0 -> false', sparse.reminderSent, false);
  ok_('reminderSent is a real boolean, not 0/1',
    typeof full.reminderSent === 'boolean' && typeof sparse.reminderSent === 'boolean',
    JSON.stringify([full.reminderSent, sparse.reminderSent]));
  ok_('reminderSent false is not null', sparse.reminderSent !== null, JSON.stringify(sparse.reminderSent));
  check('updatedAt present when set', sparse.updatedAt, '2026-09-18T04:00:00.000Z');

  check('record shape', Object.keys(full).sort(),
    ['complaint', 'createdAt', 'customerId', 'date', 'duration', 'id', 'jobCardId',
      'mechanicId', 'notes', 'reminderSent', 'serviceId', 'source', 'status', 'time',
      'vehicleId']);
  ok_('no snake_case leaked',
    !JSON.stringify(body).match(/customer_id|vehicle_id|service_id|mechanic_id|job_card_id|reminder_sent/),
    JSON.stringify(full));
}

/* ---------- 1b. relationships stay as ids, nothing is joined ---------- */
console.log('\n-- 1b. Relationships stay as ids --');
{
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/appointments', { DB: db });
  const body = await res.json();
  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('no JOIN', !/\bJOIN\b/i.test(sql), sql);
  ok_('only the appointments table is queried',
    !/FROM\s+(customers|vehicles|services|mechanics|job_cards)\b/i.test(sql), sql);
  check('exactly two queries: the page and its count', db.calls.length, 2);

  const keys = Object.keys(body.data[0]);
  ok_('no customer object or name embedded',
    !keys.some(k => /^customer($|[A-Z])/.test(k) && k !== 'customerId'), keys);
  ok_('no vehicle object or name embedded',
    !keys.some(k => /^vehicle($|[A-Z])/.test(k) && k !== 'vehicleId'), keys);
  ok_('no service or mechanic name embedded',
    !keys.some(k => /^(service|mechanic)($|[A-Z])/.test(k) && !['serviceId', 'mechanicId'].includes(k)), keys);
  ok_('no job card object embedded',
    !keys.some(k => /^jobCard($|[A-Z])/.test(k) && k !== 'jobCardId'), keys);
  ok_('all five reference columns are present',
    ['customerId', 'vehicleId', 'serviceId', 'mechanicId', 'jobCardId'].every(k => k in body.data[0]), keys);
}

/* ---------- 1c. every canonical source and status, exactly as stored ---------- */
console.log('\n-- 1c. Source and status are returned verbatim --');
{
  const rows = SOURCES.map((source, i) => ({
    ...SEEDED[1], id: `APT-10${i + 1}`, source,
    created_at: `2026-05-0${i + 1}T04:00:00.000Z`,
  }));
  const res = await call('/api/appointments', { DB: stubDB({ rows }) });
  const body = await res.json();
  for (const s of SOURCES) {
    const row = body.data.find(a => a.source === s);
    ok_(`source "${s}" survives the round trip`, Boolean(row), body.data.map(a => a.source));
  }
  check('all five canonical sources present, none rewritten',
    body.data.map(a => a.source).sort(), [...SOURCES].sort());
  ok_('Facebook is not turned into Website',
    body.data.filter(a => a.source === 'Facebook').length === 1, body.data.map(a => a.source));
  ok_('no source gained a suffix', body.data.every(a => SOURCES.includes(a.source)),
    body.data.map(a => a.source));
}
{
  // A value the CHECK would reject cannot reach D1, but if one ever did the
  // API must report it rather than quietly folding it to 'Admin' the way the
  // frontend's normSource() does for legacy localStorage records.
  const rows = [{ ...SEEDED[1], id: 'APT-1099', source: 'Legacy-Import' }];
  const res = await call('/api/appointments', { DB: stubDB({ rows }) });
  const body = await res.json();
  check('a non-canonical stored source is reported, not normalised', body.data[0].source, 'Legacy-Import');
}
{
  const rows = STATUSES.map((status, i) => ({
    ...SEEDED[1], id: `APT-20${i + 1}`, status,
    created_at: `2026-04-0${i + 1}T04:00:00.000Z`,
  }));
  const res = await call('/api/appointments', { DB: stubDB({ rows }) });
  const body = await res.json();
  check('all six statuses present, none rewritten',
    body.data.map(a => a.status).sort(), [...STATUSES].sort());
  ok_('"In Progress" keeps its space', body.data.some(a => a.status === 'In Progress'),
    body.data.map(a => a.status));
  ok_('"No Show" keeps its space', body.data.some(a => a.status === 'No Show'),
    body.data.map(a => a.status));
}
{
  // normStatus() maps these two legacy aliases at read time in the frontend.
  // The API does not: the CHECK makes them unstorable, and reporting a value
  // the row does not hold would hide a row that slipped past it.
  for (const legacy of ['Pending', 'In Service']) {
    const rows = [{ ...SEEDED[1], id: 'APT-2099', status: legacy }];
    const res = await call('/api/appointments', { DB: stubDB({ rows }) });
    const body = await res.json();
    check(`legacy status "${legacy}" is reported as stored`, body.data[0].status, legacy);
  }
}

/* ---------- 1d. date and time are never converted ---------- */
console.log('\n-- 1d. Date and time pass through untouched --');
{
  const rows = [
    { ...SEEDED[1], id: 'APT-3001', date: '2026-01-01', time: '00:00', created_at: '2026-01-01T04:00:00.000Z' },
    { ...SEEDED[1], id: 'APT-3002', date: '2026-12-31', time: '23:59', created_at: '2026-01-02T04:00:00.000Z' },
    { ...SEEDED[1], id: 'APT-3003', date: '2026-06-15', time: '05:30', created_at: '2026-01-03T04:00:00.000Z' },
  ];
  const res = await call('/api/appointments', { DB: stubDB({ rows }) });
  const body = await res.json();
  const byId = Object.fromEntries(body.data.map(a => [a.id, a]));
  // Midnight and 23:59 are where a UTC round trip would visibly move the day
  // for Dhaka (UTC+6) — the regression Audit Finding 2 fixed.
  check('midnight on new year stays put', [byId['APT-3001'].date, byId['APT-3001'].time], ['2026-01-01', '00:00']);
  check('last minute of the year stays put', [byId['APT-3002'].date, byId['APT-3002'].time], ['2026-12-31', '23:59']);
  check('an early-morning slot stays put', [byId['APT-3003'].date, byId['APT-3003'].time], ['2026-06-15', '05:30']);
  ok_('date is still a plain yyyy-mm-dd string',
    body.data.every(a => typeof a.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.date)),
    body.data.map(a => a.date));
  ok_('time is still a plain HH:MM string',
    body.data.every(a => typeof a.time === 'string' && /^\d{2}:\d{2}$/.test(a.time)),
    body.data.map(a => a.time));
  ok_('no ISO timestamp appeared in date',
    !body.data.some(a => a.date.includes('T') || a.date.endsWith('Z')), body.data.map(a => a.date));
}

/* ---------- 2. empty ---------- */
console.log('\n-- 2. Empty table --');
{
  const res = await call('/api/appointments', { DB: stubDB({ rows: [] }) });
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
  const res = await call('/api/appointments?limit=1&offset=1', { DB: db });
  const body = await res.json();
  check('limit echoed', body.limit, 1);
  check('offset echoed', body.offset, 1);
  check('count is the page', body.count, 1);
  check('total is the table', body.total, 2);

  const q = db.calls.find(c => c.sql.includes('FROM appointments') && !c.sql.includes('count(*)'));
  ok_('limit/offset bound', JSON.stringify(q.binds) === '[1,1]', JSON.stringify(q.binds));
  ok_('numbered placeholders', q.sql.includes('?1') && q.sql.includes('?2'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('ordering is newest first with an id tie-break',
    /ORDER BY created_at DESC, id DESC/.test(q.sql), q.sql);
  ok_('ordering is not by the appointment date — the UI sorts that itself',
    !/ORDER BY[^)]*\bdate\b/.test(q.sql), q.sql);
}
{
  const res = await call('/api/appointments', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('default limit', body.limit, 500);
  check('default offset', body.offset, 0);
}
{
  const res = await call('/api/appointments?limit=1000', { DB: stubDB({ rows: [] }) });
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
  const res = await call('/api/appointments?' + q, { DB: db });
  const body = await res.json();
  ok_(`${q} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_parameter', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 5. list failure modes ---------- */
console.log('\n-- 5. List failure modes --');
{
  const res = await call('/api/appointments', { DB: stubDB({ rows: [], throwOn: 'FROM appointments' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  check('message names the collection', body.error.message, 'Could not read appointments.');
  ok_('no driver detail leaked', !JSON.stringify(body).includes('D1_ERROR'), JSON.stringify(body));
}
{
  const res = await call('/api/appointments', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const res = await call('/api/appointments', { DB: stubDB({ rows: [] }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/appointments', { DB: stubDB({ rows: [] }) }, { method: 'POST' });
  check('405 sets Allow', res.headers.get('allow'), 'GET');
}

console.log('\n=== GET /api/appointments/:id ===');

/* ---------- 6. detail success ---------- */
console.log('\n-- 6. Valid id --');
{
  const res = await call('/api/appointments/APT-0002', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  ok_('data is a single object', body.data && !Array.isArray(body.data), JSON.stringify(body.data));
  check('the requested appointment is returned', body.data.id, 'APT-0002');
  check('only a data key', Object.keys(body).sort(), ['data']);
  check('detail keeps mechanicId null', body.data.mechanicId, null);
  check('detail keeps jobCardId null', body.data.jobCardId, null);
  check('detail keeps reminderSent false', body.data.reminderSent, false);
}
{
  const res = await call('/api/appointments/APT-0003', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('a different id returns a different record', body.data.id, 'APT-0003');
  check('the job-card-linked appointment reports its link', body.data.jobCardId, 'JOB-0004');
  check('and its source', body.data.source, 'Facebook');
}
{
  const listBody = await (await call('/api/appointments', { DB: stubDB({ rows: SEEDED }) })).json();
  const detail = await (await call('/api/appointments/APT-0003', { DB: stubDB({ rows: SEEDED }) })).json();
  check('detail record matches the list record',
    JSON.stringify(detail.data), JSON.stringify(listBody.data.find(a => a.id === 'APT-0003')));
}

/* ---------- 7. unknown / invalid ---------- */
console.log('\n-- 7. Unknown and invalid ids --');
{
  const res = await call('/api/appointments/APT-9999', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('unknown id -> 404', res.status, 404);
  check('error code', body.error.code, 'not_found');
  check('message', body.error.message, 'No appointment with that id.');
  ok_('no table name or SQL leaked', !JSON.stringify(body).match(/SELECT|sqlite/i), JSON.stringify(body));
}
// Every id this appointment references is well-formed but belongs elsewhere.
for (const other of ['CUS-0004', 'VEH-0004', 'SRV-0010', 'MEC-0001', 'JOB-0004', 'PRT-0001']) {
  const res = await call('/api/appointments/' + other, { DB: stubDB({ rows: SEEDED }) });
  ok_(`${other} on the appointments route -> 404, not 400`, res.status === 404, `got ${res.status}`);
}
for (const [path, why] of [
  ['/api/appointments/', 'empty'],
  ['/api/appointments/abc', 'no numeric part'],
  ['/api/appointments/APT0001', 'missing hyphen'],
  ['/api/appointments/APT-', 'no digits'],
  ['/api/appointments/-0001', 'no prefix'],
  ['/api/appointments/APT-0001-extra', 'trailing junk'],
  ['/api/appointments/' + 'A'.repeat(40) + '-1', 'too long'],
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
  "APT-0001' OR '1'='1",
  "APT-0001; DROP TABLE appointments",
  "APT-0001'; UPDATE appointments SET status='Cancelled' --",
  "APT-0001'; UPDATE appointments SET source='Website' --",
  "' UNION SELECT id,customer_id,date FROM appointments --",
  '../../etc/passwd',
  'APT-0001%00',
  '<script>alert(1)</script>',
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/appointments/' + encodeURIComponent(raw), { DB: db });
  ok_(`rejected: ${raw.slice(0, 40)}`, res.status === 400, `got ${res.status}`);
  ok_('   ...nothing reached the database', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/appointments/%zz', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('malformed URL encoding -> 400', res.status, 400);
  check('error code', body.error.code, 'invalid_id');
}

/* ---------- 9. detail SQL safety and failures ---------- */
console.log('\n-- 9. Detail SQL safety and failure modes --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/appointments/APT-0003', { DB: db });
  const q = db.calls[0];
  check('exactly one query', db.calls.length, 1);
  ok_('id bound', JSON.stringify(q.binds) === '["APT-0003"]', JSON.stringify(q.binds));
  ok_('id absent from the SQL text', !q.sql.includes('APT-0003'), q.sql);
  ok_('numbered placeholder', q.sql.includes('?1'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('bounded with LIMIT 1', q.sql.includes('LIMIT 1'), q.sql);
  ok_('detail joins nothing either', !/\bJOIN\b/i.test(q.sql), q.sql);
}
{
  const res = await call('/api/appointments/APT-0003', { DB: stubDB({ rows: SEEDED, throwOn: 'WHERE id' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('message names the singular', body.error.message, 'Could not read appointment.');
}
{
  const res = await call('/api/appointments/APT-0003', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const res = await call('/api/appointments/APT-0003', { DB: stubDB({ rows: SEEDED }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/appointments/APT-0003', { DB: stubDB({ rows: SEEDED }) }, { method: 'POST' });
  check('405 sets Allow', res.headers.get('allow'), 'GET');
}

/* ---------- 10. the shared factory still keeps collections distinct ---------- */
console.log('\n-- 10. Shared factory: appointments stays distinct --');
{
  const aDb = stubDB({ rows: [] });
  await call('/api/appointments', { DB: aDb });
  const pDb = stubDB({ rows: [] });
  await call('/api/parts', { DB: pDb });
  const mDb = stubDB({ rows: [] });
  await call('/api/mechanics', { DB: mDb });

  ok_('appointments queries FROM appointments', aDb.calls[0].sql.includes('FROM appointments'), aDb.calls[0].sql);
  ok_('appointments selects its own columns',
    aDb.calls[0].sql.includes('reminder_sent') && aDb.calls[0].sql.includes('job_card_id'),
    aDb.calls[0].sql);
  ok_('appointments does not select another collection\'s columns',
    !aDb.calls[0].sql.includes('reorder_qty') && !aDb.calls[0].sql.includes('commission_rate'),
    aDb.calls[0].sql);
  ok_('no other collection selects appointment columns',
    !pDb.calls[0].sql.includes('reminder_sent') && !mDb.calls[0].sql.includes('job_card_id'),
    'column lists leaked between collections');
}
{
  const a = await (await call('/api/appointments/APT-9999', { DB: stubDB({ rows: [] }) })).json();
  const p = await (await call('/api/parts/PRT-9999', { DB: stubDB({ rows: [] }) })).json();
  const m = await (await call('/api/mechanics/MEC-9999', { DB: stubDB({ rows: [] }) })).json();
  const s = await (await call('/api/services/SRV-9999', { DB: stubDB({ rows: [] }) })).json();
  const v = await (await call('/api/vehicles/VEH-9999', { DB: stubDB({ rows: [] }) })).json();
  const c = await (await call('/api/customers/CUS-9999', { DB: stubDB({ rows: [] }) })).json();
  check('appointments 404 message', a.error.message, 'No appointment with that id.');
  check('parts 404 message', p.error.message, 'No part with that id.');
  check('mechanics 404 message', m.error.message, 'No mechanic with that id.');
  check('services 404 message', s.error.message, 'No service with that id.');
  check('vehicles 404 message', v.error.message, 'No vehicle with that id.');
  check('customers 404 message', c.error.message, 'No customer with that id.');
}

/* ---------- 11. routing ---------- */
console.log('\n-- 11. Routing --');
{
  const res = await call('/api/health', { DB: stubDB({ rows: [{ name: 'customers' }], total: 15 }) });
  const body = await res.json();
  check('health 200', res.status, 200);
  ok_('health advertises the appointments routes',
    body.data.routes.includes('GET /api/appointments')
      && body.data.routes.includes('GET /api/appointments/:id'),
    JSON.stringify(body.data.routes));
}
{
  const res = await call('/api/nope', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('unknown collection -> 404', res.status, 404);
  ok_('404 advertises the appointments routes',
    body.error.available.includes('GET /api/appointments')
      && body.error.available.includes('GET /api/appointments/:id'),
    JSON.stringify(body.error.available));
}
{
  // Collections the router does not know must 404. The names are derived from
  // what health advertises rather than hardcoded: B-7 hardcoded /api/job-cards
  // here and B-8 turned it into a real route, so the assertion started failing
  // for the wrong reason. Deriving it means the next phase inherits this
  // unchanged.
  const advertised = (await (await call('/api/health',
    { DB: stubDB({ rows: [{ name: 'customers' }] }) })).json()).data.routes;
  const unregistered = ['invoices', 'payments', 'expenses', 'bookings', 'appointment']
    .filter(name => !advertised.includes(`GET /api/${name}`));
  ok_('at least one unregistered collection was found to probe',
    unregistered.length > 0, JSON.stringify(advertised));
  for (const name of unregistered) {
    const res = await call(`/api/${name}`, { DB: stubDB({ rows: [] }) });
    ok_(`/api/${name} is not a route -> 404`, res.status === 404, `got ${res.status}`);
  }
}

console.log(`\nGET /api/appointments unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
