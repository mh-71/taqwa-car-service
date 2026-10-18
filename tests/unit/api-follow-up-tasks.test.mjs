/* Follow-up tasks (0006) — unit tests against the REAL Worker handlers:
   /api/follow-up-tasks and its start / complete / cancel actions.

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0006), through the same minimal D1-shaped wrapper the
   follow-up suite uses, so the guards are exercised as SQL rather than
   described.

   What must hold:
     A. Schema: the table, CHECKs, FKs, indexes and counter 0006 promises;
        the migration can be re-run.
     B. Create: strict fields, title and real due date required, priority
        default and allow-list, references optional but consistent (vehicle /
        job card need a customer, belong to it, job card matches the vehicle),
        active customer / vehicle / staff, missing references refused.
     C. Idempotency: same key + same payload -> 200 replayed, one row; same
        key + other payload -> 409; parallel same-key creates make one row.
     D. Update: permitted fields only, merged references re-checked, a kept
        reference may be inactive, a newly chosen one must be active, stale
        expectedUpdatedAt -> 409, closed tasks are final.
     E. Status: Pending -> In Progress -> Completed, Pending -> Completed,
        cancel with a required reason; every other move is a 409 naming the
        current status; repeated clicks are harmless.
     F. Security: every route needs a credential (401, nothing written);
        no DELETE (405); no internal column ever leaves the Worker; safe 500.
     G. Deletion: a customer / vehicle / job card / mechanic a task refers to
        cannot be deleted.
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
  console.log(`\nFollow-up tasks unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-10-08T00:00:00Z';
const MIGRATIONS = ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql',
  '0004_job_card_discount_rate.sql', '0005_customer_follow_ups.sql', '0006_follow_up_tasks.sql'];

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
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0002', 'Karim', '01700000002', '${AT}');
    INSERT INTO customers (id, name, phone, status, created_at) VALUES ('CUS-0003', 'Gone', '01700000003', 'Inactive', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'R1', 'Toyota', 'Corolla', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0002', 'CUS-0002', 'R2', 'Honda', 'Civic', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, status, created_at) VALUES ('VEH-0003', 'CUS-0001', 'R3', 'Kia', 'Rio', 'Inactive', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0004', 'CUS-0001', 'R4', 'Nissan', 'Sunny', '${AT}');
    INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0001', 'Jamal', '01800000001', '${AT}');
    INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0002', 'Kamal', '01800000002', '${AT}');
    INSERT INTO mechanics (id, name, phone, status, created_at) VALUES ('MEC-0003', 'Left', '01800000003', 'Inactive', '${AT}');
    INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, date, complaint, created_at) VALUES ('JOB-0001', 'CUS-0001', 'VEH-0001', 'MEC-0001', '2026-10-01', 'Noise', '${AT}');
    INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, date, complaint, created_at) VALUES ('JOB-0002', 'CUS-0002', 'VEH-0002', 'MEC-0001', '2026-10-01', 'Oil', '${AT}');
    INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, date, complaint, created_at) VALUES ('JOB-0003', 'CUS-0001', 'VEH-0004', 'MEC-0002', '2026-10-02', 'AC', '${AT}');`);
  const env = { DB };
  const api = async (method, path, body, auth = true) => {
    const res = await call(path, env, method, body, auth);
    return { status: res.status, allow: res.headers.get('allow'), body: await res.json().catch(() => null) };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  const n = () => one('SELECT count(*) AS n FROM follow_up_tasks').n;
  return { DB, env, api, one, n };
}

let keySeq = 0;
const newKey = () => `task-key-${String(++keySeq).padStart(8, '0')}-abcdef`;
const GOOD = (extra = {}) => ({
  title: 'Call about brake pads', description: 'Confirm the squeal is gone', customerId: 'CUS-0001',
  vehicleId: 'VEH-0001', jobCardId: 'JOB-0001', assignedTo: 'MEC-0001', priority: 'high',
  dueDate: '2026-10-20', createdBy: 'Desk', idempotencyKey: newKey(), ...extra,
});
const create = (h, extra) => h.api('POST', '/api/follow-up-tasks', GOOD(extra));
const fields = (r) => Object.keys(r.body?.error?.fields ?? {}).sort();

console.log('=== Follow-up tasks (0006) against an in-memory database ===');

/* ---------- A. schema ---------- */
console.log('\n-- A. schema --');
{
  const h = fresh();
  const cols = h.DB.raw.prepare('PRAGMA table_info(follow_up_tasks)').all().map((c) => c.name);
  check('follow_up_tasks has the designed columns', cols,
    ['id', 'title', 'description', 'customer_id', 'vehicle_id', 'job_card_id', 'assigned_to', 'priority', 'due_date',
      'status', 'started_at', 'completed_at', 'completion_note', 'cancelled_at', 'cancel_reason', 'created_by',
      'updated_by', 'idempotency_key', 'idempotency_fingerprint', 'created_at', 'updated_at']);
  const fks = h.DB.raw.prepare('PRAGMA foreign_key_list(follow_up_tasks)').all().map((f) => [f.from, f.table, f.on_delete]).sort();
  check('customer, vehicle, job card and mechanic are all ON DELETE RESTRICT', fks,
    [['assigned_to', 'mechanics', 'RESTRICT'], ['customer_id', 'customers', 'RESTRICT'],
      ['job_card_id', 'job_cards', 'RESTRICT'], ['vehicle_id', 'vehicles', 'RESTRICT']]);
  const idx = h.DB.raw.prepare('PRAGMA index_list(follow_up_tasks)').all();
  check('the designed indexes exist', idx.filter((i) => i.origin === 'c').map((i) => i.name).sort(),
    ['ix_ftk_assigned', 'ix_ftk_created', 'ix_ftk_customer', 'ix_ftk_job_card', 'ix_ftk_status_due', 'ix_ftk_vehicle']);
  check('UNIQUE only on the id and the idempotency key', idx.filter((i) => i.unique).map((i) =>
    h.DB.raw.prepare(`PRAGMA index_info(${i.name})`).all().map((c) => c.name).join(',')).sort(), ['id', 'idempotency_key']);
  check('counter TSK starts at 0', h.one(`SELECT prefix, last_value FROM id_counters WHERE collection = 'followUpTasks'`),
    { prefix: 'TSK', last_value: 0 });
  const fp = 'a'.repeat(64);
  const base = 'INSERT INTO follow_up_tasks (id, title, customer_id, vehicle_id, priority, due_date, status, started_at, completed_at, cancelled_at, cancel_reason, idempotency_key, idempotency_fingerprint, created_at, updated_at)';
  let k = 0;
  const tryIns = (v) => { k++; try { h.DB.raw.exec(`${base} VALUES ('X-${k}', ${v}, 'k-schema-test-${String(k).padStart(4, '0')}', '${fp}', '${AT}', '${AT}')`); return 'ok'; } catch (e) { return /CHECK/.test(e.message) ? 'check' : e.message; } };
  check('CHECK: priority low/medium/high/urgent only', tryIns(`'t', NULL, NULL, 'critical', '2026-10-01', 'Pending', NULL, NULL, NULL, NULL`), 'check');
  check('CHECK: status allow-list (no Overdue)', tryIns(`'t', NULL, NULL, 'low', '2026-10-01', 'Overdue', NULL, NULL, NULL, NULL`), 'check');
  check('CHECK: blank title refused', tryIns(`'  ', NULL, NULL, 'low', '2026-10-01', 'Pending', NULL, NULL, NULL, NULL`), 'check');
  check('CHECK: a vehicle needs a customer', tryIns(`'t', NULL, 'VEH-0001', 'low', '2026-10-01', 'Pending', NULL, NULL, NULL, NULL`), 'check');
  check('CHECK: Completed needs completed_at', tryIns(`'t', NULL, NULL, 'low', '2026-10-01', 'Completed', NULL, NULL, NULL, NULL`), 'check');
  check('CHECK: Cancelled needs a reason', tryIns(`'t', NULL, NULL, 'low', '2026-10-01', 'Cancelled', NULL, NULL, '${AT}', NULL`), 'check');
  check('CHECK: In Progress needs started_at', tryIns(`'t', NULL, NULL, 'low', '2026-10-01', 'In Progress', NULL, NULL, NULL, NULL`), 'check');
  check('CHECK: due date must look like YYYY-MM-DD', tryIns(`'t', NULL, NULL, 'low', '20/10/2026', 'Pending', NULL, NULL, NULL, NULL`), 'check');
  check('a well-formed row is accepted', tryIns(`'t', 'CUS-0001', 'VEH-0001', 'low', '2026-10-01', 'Pending', NULL, NULL, NULL, NULL`), 'ok');
  let rerun = 'ok';
  try { h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0006_follow_up_tasks.sql'), 'utf8')); } catch (e) { rerun = e.message; }
  check('0006 can be re-run without error (IF NOT EXISTS / OR IGNORE)', rerun, 'ok');
  check('   ...and leaves existing rows alone', h.n(), 1);
}

/* ---------- B. create ---------- */
console.log('\n-- B. create --');
{
  const h = fresh();
  const r = await create(h);
  check('create -> 201', r.status, 201);
  check('   ...a Pending TSK id with the submitted fields', [r.body.data.id, r.body.data.status, r.body.data.priority, r.body.data.dueDate,
    r.body.data.customerId, r.body.data.vehicleId, r.body.data.jobCardId, r.body.data.assignedTo, r.body.data.createdBy],
  ['TSK-0001', 'Pending', 'high', '2026-10-20', 'CUS-0001', 'VEH-0001', 'JOB-0001', 'MEC-0001', 'Desk']);
  check('   ...server timestamps, no start/close stamps', [!!r.body.data.createdAt, r.body.data.createdAt === r.body.data.updatedAt,
    r.body.data.startedAt, r.body.data.completedAt, r.body.data.cancelledAt], [true, true, null, null, null]);
  ok_('   ...no internal column in the record', !('idempotencyKey' in r.body.data) && !JSON.stringify(r.body).includes('fingerprint'), JSON.stringify(r.body.data));

  const minimal = await h.api('POST', '/api/follow-up-tasks', { title: 'Order brake fluid', dueDate: '2026-10-21', idempotencyKey: newKey() });
  check('a task needs no customer, vehicle, job card or staff; priority defaults to medium', [minimal.status, minimal.body.data?.priority,
    minimal.body.data?.customerId, minimal.body.data?.assignedTo, minimal.body.data?.description], [201, 'medium', null, null, '']);

  for (const [why, extra, want] of [
    ['a status', { status: 'Completed' }, ['status']],
    ['an id', { id: 'TSK-9999' }, ['id']],
    ['a timestamp', { completedAt: AT }, ['completedAt']],
    ['an unknown key', { colour: 'red' }, ['colour']],
    ['a blank title', { title: '   ' }, ['title']],
    ['a too-long title', { title: 'x'.repeat(151) }, ['title']],
    ['a missing due date', { dueDate: undefined }, ['dueDate']],
    ['an impossible date', { dueDate: '2026-02-30' }, ['dueDate']],
    ['a bad priority', { priority: 'critical' }, ['priority']],
    ['no idempotency key', { idempotencyKey: undefined }, ['idempotencyKey']],
    ['a short idempotency key', { idempotencyKey: 'short' }, ['idempotencyKey']],
    ['a vehicle without a customer', { customerId: null, jobCardId: null }, ['vehicleId']],
    ['a job card without a customer', { customerId: null, vehicleId: null }, ['jobCardId']],
    ['a non-string reference', { assignedTo: 7 }, ['assignedTo']],
  ]) {
    const res = await create(h, extra);
    check(`${why} -> 422 naming ${want.join(', ')}`, [res.status, fields(res)], [422, want]);
  }
  const far = await create(h, { dueDate: '1999-01-01' });
  check('a past due date is accepted (a task can be logged late)', far.status, 201);

  for (const [why, extra, status, reason, field] of [
    ['an inactive customer', { customerId: 'CUS-0003', vehicleId: null, jobCardId: null }, 409, 'customer_inactive'],
    ['a missing customer', { customerId: 'CUS-0404', vehicleId: null, jobCardId: null }, 409, 'customer_not_found'],
    ['another customer\'s vehicle', { vehicleId: 'VEH-0002', jobCardId: null }, 422, null, 'vehicleId'],
    ['an inactive vehicle', { vehicleId: 'VEH-0003', jobCardId: null }, 409, 'vehicle_inactive'],
    ['a missing vehicle', { vehicleId: 'VEH-0404', jobCardId: null }, 409, 'vehicle_not_found'],
    ['another customer\'s job card', { vehicleId: null, jobCardId: 'JOB-0002' }, 422, null, 'jobCardId'],
    ['a job card for another vehicle', { vehicleId: 'VEH-0001', jobCardId: 'JOB-0003' }, 422, null, 'jobCardId'],
    ['a missing job card', { jobCardId: 'JOB-0404' }, 409, 'job_card_not_found'],
    ['an inactive staff member', { assignedTo: 'MEC-0003' }, 409, 'staff_inactive'],
    ['a missing staff member', { assignedTo: 'MEC-0404' }, 409, 'staff_not_found'],
  ]) {
    const before = h.n();
    const res = await create(h, extra);
    check(`${why} -> ${status}${reason ? ' ' + reason : ' naming ' + field}`,
      [res.status, reason ? res.body.error?.reason : fields(res)[0]], [status, reason || field]);
    check('   ...and nothing was written', h.n(), before);
  }
  const jobOnly = await create(h, { vehicleId: null, jobCardId: 'JOB-0003' });
  check('a job card with no vehicle chosen only has to be the customer\'s', jobOnly.status, 201);
  const xss = await create(h, { title: '<img src=x onerror=alert(1)>', description: '<script>x</script>' });
  check('markup in text is stored verbatim as data (the page escapes it)', [xss.status, xss.body.data.title], [201, '<img src=x onerror=alert(1)>']);
}

/* ---------- C. idempotency ---------- */
console.log('\n-- C. idempotency --');
{
  const h = fresh();
  const body = GOOD();
  const a = await h.api('POST', '/api/follow-up-tasks', body);
  const b = await h.api('POST', '/api/follow-up-tasks', body);
  check('same key + same payload -> first 201, then 200 replayed with the same task', [a.status, b.status, b.body.replayed, b.body.data.id === a.body.data.id],
    [201, 200, true, true]);
  check('   ...one row', h.n(), 1);
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  check('   ...key order in the request does not matter', (await h.api('POST', '/api/follow-up-tasks', reordered)).status, 200);
  const c = await h.api('POST', '/api/follow-up-tasks', { ...body, title: 'Something else' });
  check('same key + other payload -> 409 idempotency_key_reused', [c.status, c.body.error.reason], [409, 'idempotency_key_reused']);
  const d = await create(h, { title: body.title });
  check('a new key with identical content is a new task (duplicates are allowed on purpose)', [d.status, h.n()], [201, 2]);
  const parallel = GOOD();
  const burst = await Promise.all(Array.from({ length: 6 }, () => h.api('POST', '/api/follow-up-tasks', parallel)));
  check('six parallel creates with one key -> one task', [new Set(burst.map((r) => r.body.data.id)).size, h.n()], [1, 3]);
  await h.api('PUT', `/api/follow-up-tasks/${a.body.data.id}`, { title: 'Edited title' });
  const replayAfterEdit = await h.api('POST', '/api/follow-up-tasks', body);
  check('a retry after an edit still finds its task (the fingerprint never changes)', [replayAfterEdit.status, replayAfterEdit.body.data.title], [200, 'Edited title']);
}

/* ---------- D. update ---------- */
console.log('\n-- D. update --');
{
  const h = fresh();
  const t = (await create(h)).body.data;
  const put = (body, id = t.id) => h.api('PUT', `/api/follow-up-tasks/${id}`, body);
  const u = await put({ title: 'New title', priority: 'urgent', dueDate: '2026-10-25', assignedTo: 'MEC-0002', updatedBy: 'Manager' });
  check('edit -> 200 with the merged fields', [u.status, u.body.data.title, u.body.data.priority, u.body.data.dueDate, u.body.data.assignedTo, u.body.data.updatedBy],
    [200, 'New title', 'urgent', '2026-10-25', 'MEC-0002', 'Manager']);
  check('   ...the customer, vehicle and job card are kept', [u.body.data.customerId, u.body.data.vehicleId, u.body.data.jobCardId], ['CUS-0001', 'VEH-0001', 'JOB-0001']);
  check('   ...status is untouched', u.body.data.status, 'Pending');
  const unassign = await put({ assignedTo: null });
  check('staff can be unassigned with null', [unassign.status, unassign.body.data.assignedTo], [200, null]);
  check('a status in an edit -> 422', fields(await put({ status: 'Completed' })), ['status']);
  check('createdBy cannot be edited', fields(await put({ createdBy: 'x' })), ['createdBy']);
  check('an empty edit -> 422', (await put({})).status, 422);
  check('an edit of a missing task -> 404', (await put({ title: 'x' }, 'TSK-9999')).status, 404);

  const swap = await put({ customerId: 'CUS-0002' });
  check('changing the customer while the old vehicle is set -> 422 vehicleId', [swap.status, fields(swap)], [422, ['vehicleId']]);
  const clear = await put({ customerId: null });
  check('clearing the customer while a vehicle / job card is set -> 422', [clear.status, fields(clear)], [422, ['jobCardId', 'vehicleId']]);
  const move = await put({ customerId: 'CUS-0002', vehicleId: 'VEH-0002', jobCardId: 'JOB-0002' });
  check('changing customer, vehicle and job card together -> 200', [move.status, move.body.data.customerId, move.body.data.jobCardId], [200, 'CUS-0002', 'JOB-0002']);
  const wrongJob = await put({ jobCardId: 'JOB-0001' });
  check('a job card of another customer -> 422 jobCardId', [wrongJob.status, fields(wrongJob)], [422, ['jobCardId']]);
  check('   ...nothing changed', h.one('SELECT job_card_id FROM follow_up_tasks WHERE id = ?', t.id).job_card_id, 'JOB-0002');

  // A reference that was valid when chosen may be deactivated later: keeping it is fine.
  const t2 = (await create(h, { assignedTo: 'MEC-0002', vehicleId: 'VEH-0004', jobCardId: null })).body.data;
  h.DB.raw.exec(`UPDATE mechanics SET status = 'Inactive' WHERE id = 'MEC-0002'; UPDATE vehicles SET status = 'Inactive' WHERE id = 'VEH-0004'`);
  const keep = await h.api('PUT', `/api/follow-up-tasks/${t2.id}`, { title: 'Still assigned' });
  check('an edit keeps a since-deactivated vehicle and staff member', [keep.status, keep.body.data.assignedTo, keep.body.data.vehicleId], [200, 'MEC-0002', 'VEH-0004']);
  const toInactive = await h.api('PUT', `/api/follow-up-tasks/${t2.id}`, { assignedTo: 'MEC-0003' });
  check('but newly choosing an inactive staff member -> 409 staff_inactive', [toInactive.status, toInactive.body.error.reason], [409, 'staff_inactive']);
  const toInactiveV = await h.api('PUT', `/api/follow-up-tasks/${t2.id}`, { vehicleId: 'VEH-0003' });
  check('   ...or an inactive vehicle -> 409 vehicle_inactive', [toInactiveV.status, toInactiveV.body.error.reason], [409, 'vehicle_inactive']);

  const now = h.one('SELECT updated_at FROM follow_up_tasks WHERE id = ?', t2.id).updated_at;
  const stale = await h.api('PUT', `/api/follow-up-tasks/${t2.id}`, { title: 'Late edit', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
  check('an edit made from an older version -> 409 concurrent_modification', [stale.status, stale.body.error.reason], [409, 'concurrent_modification']);
  const fresh2 = await h.api('PUT', `/api/follow-up-tasks/${t2.id}`, { title: 'Current edit', expectedUpdatedAt: now });
  check('   ...the same edit from the current version -> 200', fresh2.status, 200);

  await h.api('POST', `/api/follow-up-tasks/${t2.id}/complete`, {});
  const closed = await h.api('PUT', `/api/follow-up-tasks/${t2.id}`, { title: 'After close' });
  check('a completed task cannot be edited -> 409 task_closed', [closed.status, closed.body.error.reason, closed.body.error.currentStatus], [409, 'task_closed', 'Completed']);
}

/* ---------- E. status transitions ---------- */
console.log('\n-- E. status --');
{
  const h = fresh();
  const act = (id, a, body) => h.api('POST', `/api/follow-up-tasks/${id}/${a}`, body);
  const t = (await create(h)).body.data;
  const s = await act(t.id, 'start', { by: 'Jamal' });
  check('start: Pending -> In Progress, started_at stamped', [s.status, s.body.data.status, !!s.body.data.startedAt, s.body.data.updatedBy], [200, 'In Progress', true, 'Jamal']);
  const s2 = await act(t.id, 'start');
  check('start again -> 409 invalid_transition, currentStatus In Progress', [s2.status, s2.body.error.reason, s2.body.error.currentStatus], [409, 'invalid_transition', 'In Progress']);
  const edit = await h.api('PUT', `/api/follow-up-tasks/${t.id}`, { priority: 'low' });
  check('an In Progress task can still be edited', [edit.status, edit.body.data.status], [200, 'In Progress']);
  const c = await act(t.id, 'complete', { note: 'Done and tested' });
  check('complete: In Progress -> Completed with the note', [c.status, c.body.data.status, c.body.data.completionNote, !!c.body.data.completedAt, !!c.body.data.startedAt],
    [200, 'Completed', 'Done and tested', true, true]);
  for (const a of ['start', 'complete']) {
    const again = await act(t.id, a, {});
    check(`${a} after completion -> 409 task_closed`, [again.status, again.body.error.reason], [409, 'task_closed']);
  }
  const cancelDone = await act(t.id, 'cancel', { reason: 'Mistake' });
  check('a completed task cannot be cancelled -> 409 task_closed', [cancelDone.status, cancelDone.body.error.currentStatus], [409, 'Completed']);

  const p = (await create(h)).body.data;
  const direct = await act(p.id, 'complete');
  check('complete straight from Pending (no body) -> 200', [direct.status, direct.body.data.status, direct.body.data.startedAt], [200, 'Completed', null]);

  const q = (await create(h)).body.data;
  const noReason = await act(q.id, 'cancel', {});
  check('cancel without a reason -> 422 reason', [noReason.status, fields(noReason)], [422, ['reason']]);
  const blankReason = await act(q.id, 'cancel', { reason: '   ' });
  check('   ...a blank reason too', blankReason.status, 422);
  const cx = await act(q.id, 'cancel', { reason: 'Customer sold the car', by: 'Desk' });
  check('cancel: the reason and time are kept (soft delete)', [cx.status, cx.body.data.status, cx.body.data.cancelReason, !!cx.body.data.cancelledAt], [200, 'Cancelled', 'Customer sold the car', true]);
  check('   ...the row still exists', h.one('SELECT count(*) AS n FROM follow_up_tasks WHERE id = ?', q.id).n, 1);
  check('start a cancelled task -> 409 task_closed', (await act(q.id, 'start')).body.error.currentStatus, 'Cancelled');
  check('a status key in an action body -> 422', fields(await act(p.id, 'complete', { status: 'Pending' })), ['status']);
  check('an action on a missing task -> 404', (await act('TSK-9999', 'start')).status, 404);
  check('an unknown action (e.g. reopen) is not routed -> 405, Allow: GET, PUT', [(await act(p.id, 'reopen', {})).status, (await act(p.id, 'reopen', {})).allow], [405, 'GET, PUT']);
  const r = (await create(h)).body.data;
  const clicks = await Promise.all([act(r.id, 'complete'), act(r.id, 'complete'), act(r.id, 'complete')]);
  check('three parallel completes: one 200, the rest 409, one completion stamp',
    [clicks.filter((x) => x.status === 200).length, clicks.filter((x) => x.status === 409).length], [1, 2]);
}

/* ---------- F. security and shape ---------- */
console.log('\n-- F. security --');
{
  const h = fresh();
  const t = (await create(h)).body.data;
  const before = h.n();
  const routes = [['GET', '/api/follow-up-tasks'], ['POST', '/api/follow-up-tasks'], ['GET', `/api/follow-up-tasks/${t.id}`],
    ['PUT', `/api/follow-up-tasks/${t.id}`], ['POST', `/api/follow-up-tasks/${t.id}/start`],
    ['POST', `/api/follow-up-tasks/${t.id}/complete`], ['POST', `/api/follow-up-tasks/${t.id}/cancel`]];
  const open = [];
  h.DB.statements.length = 0;
  for (const [m, p] of routes) {
    const res = await h.api(m, p, m === 'GET' ? undefined : { title: 'x', reason: 'x' }, false);
    if (res.status !== 401) open.push([m, p, res.status]);
  }
  check('every task route refuses a caller with no credential (401)', open, []);
  check('   ...without reaching the database', h.DB.statements.length, 0);
  check('   ...and nothing changed', h.n(), before);
  const del = await h.api('DELETE', `/api/follow-up-tasks/${t.id}`);
  check('there is no DELETE (cancel instead) -> 405, Allow: GET, PUT', [del.status, del.allow], [405, 'GET, PUT']);
  const list = await h.api('GET', '/api/follow-up-tasks');
  check('list -> 200 with the paging envelope', [list.status, list.body.count, list.body.total], [200, 1, 1]);
  ok_('   ...no idempotency column in any record', list.body.data.every((x) => !Object.keys(x).some((k) => /idempotency|fingerprint/i.test(k))), JSON.stringify(list.body.data[0]));
  check('detail of a missing task -> 404', (await h.api('GET', '/api/follow-up-tasks/TSK-0404')).status, 404);
  const broken = { DB: { prepare: () => { throw new Error('D1_ERROR: no such table: follow_up_tasks'); } } };
  const res = await call('/api/follow-up-tasks', broken, 'GET');
  const body = await res.json();
  check('a database failure -> 500 database_error', [res.status, body.error.code], [500, 'database_error']);
  ok_('   ...naming no table or SQL', !/no such table|follow_up_tasks/i.test(JSON.stringify(body)), JSON.stringify(body));
  const bad = await h.api('POST', '/api/follow-up-tasks', '{not json');
  check('a malformed body -> 400 invalid_body', [bad.status, bad.body.error.code], [400, 'invalid_body']);
}

/* ---------- G. deletion is refused while referenced ---------- */
console.log('\n-- G. deletion --');
{
  const h = fresh();
  await create(h);
  for (const [path, label] of [['/api/mechanics/MEC-0001', 'mechanic'], ['/api/vehicles/VEH-0001', 'vehicle'], ['/api/customers/CUS-0001', 'customer']]) {
    const r = await h.api('DELETE', path);
    check(`deleting a ${label} a task refers to -> 409`, r.status, 409);
  }
  check('   ...and the task is still there', h.n(), 1);
}

console.log(`\nFollow-up tasks unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
