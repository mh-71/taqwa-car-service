/* Customer follow-ups (0005) — unit tests against the REAL Worker handlers:
   /api/follow-ups, its complete / cancel / contact actions, and
   /api/follow-up-contacts with its void action.

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0005), through the same minimal D1-shaped wrapper the
   write-off suite uses, so the guards are exercised as SQL rather than
   described. Real D1 -- its batch transaction over HTTP and truly parallel
   requests -- is the integration suite's job (section 25).

   What must hold:
     A. Schema: the tables, CHECKs, FKs and counters 0005 promises; no
        duplicate-open restriction anywhere.
     B. Create: strict fields, real calendar dates (past and far future),
        active customer / vehicle that belongs to them, several Open
        follow-ups for the same customer + vehicle + reason.
     C. Idempotency: same key + same payload -> 200 replayed, one row;
        same key + other payload -> 409; concurrent same-key requests make
        one row; a replay still works after the follow-up was edited.
     D. Update: permitted fields only, vehicle ownership, closed is final.
     E. Complete / cancel: transitions, required cancel reason, 409 retry.
     F. Contacts: outcome rules, Open only, due date moves, cache follows the
        latest Active contact, deterministic same-millisecond ordering.
     G. Void: guarded, audited, recomputes the cache, never moves due_date.
     H. Deletion: a referenced customer / vehicle cannot be deleted.
     I. Atomicity: a failed batch leaves no contact and no cache change.
     J. Routes: 405 for the append-only collection's missing verbs, safe
        500s, no internal columns in any record.
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
const call = (path, env, method, body) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { API_TOKEN: TEST_TOKEN, ...env });

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }

if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version; nothing was checked.');
  console.log(`\nCustomer follow-ups unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-10-08T00:00:00Z';
const MIGRATIONS = ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql',
  '0004_job_card_discount_rate.sql', '0005_customer_follow_ups.sql'];

/** The smallest D1-shaped wrapper the handlers need: prepare/bind/first/all/run/batch. */
function makeD1({ failBatchAt = null } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of MIGRATIONS) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const clean = (a) => a.map((x) => (x === undefined ? null : x));
  class Stmt {
    constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
    bind(...a) { return new Stmt(this.sql, clean(a)); }
    exec() {
      const s = raw.prepare(this.sql);
      if (returnsRows(this.sql)) { const r = s.all(...this.binds); return { results: r, meta: { changes: r.length } }; }
      const r = s.run(...this.binds);
      return { results: [], meta: { changes: Number(r.changes) } };
    }
    async first(col) {
      // A RETURNING statement is a write: run it fully, then hand back row 0.
      if (/\bRETURNING\b/i.test(this.sql)) { const r = this.exec().results[0] ?? null; return r && col ? r[col] : r; }
      const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r;
    }
    async all() { return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
    async run() { return this.exec(); }
  }
  const db = {
    raw,
    failBatchAt,
    prepare: (sql) => new Stmt(sql),
    async batch(statements) {
      raw.exec('BEGIN');
      try {
        const out = statements.map((s, i) => {
          if (db.failBatchAt === i) throw new Error('D1_ERROR: injected failure for the atomicity test');
          return s.exec();
        });
        raw.exec('COMMIT');
        return out;
      } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
  return db;
}

function fresh(opts) {
  const DB = makeD1(opts);
  DB.raw.exec(`
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'Rahim', '01700000001', '${AT}');
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0002', 'Karim', '01700000002', '${AT}');
    INSERT INTO customers (id, name, phone, status, created_at) VALUES ('CUS-0003', 'Gone', '01700000003', 'Inactive', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'R1', 'Toyota', 'Corolla', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0002', 'CUS-0002', 'R2', 'Honda', 'Civic', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, status, created_at) VALUES ('VEH-0003', 'CUS-0001', 'R3', 'Kia', 'Rio', 'Inactive', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0004', 'CUS-0001', 'R4', 'Nissan', 'Sunny', '${AT}');`);
  const env = { DB };
  const api = async (method, path, body) => {
    const res = await call(path, env, method, body);
    return { status: res.status, allow: res.headers.get('allow'), body: await res.json().catch(() => null) };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  const n = (table) => one(`SELECT count(*) AS n FROM ${table}`).n;
  return { DB, env, api, one, n };
}

let keySeq = 0;
const newKey = () => `test-key-${String(++keySeq).padStart(8, '0')}-abcdef`;
const GOOD = (extra = {}) => ({
  customerId: 'CUS-0001', vehicleId: 'VEH-0001', reason: 'Check brake noise after service',
  notes: 'Ask if the squeal is gone', priority: 'high', dueDate: '2026-10-20', idempotencyKey: newKey(), ...extra,
});
const create = (h, extra) => h.api('POST', '/api/follow-ups', GOOD(extra));
const contact = (h, id, body) => h.api('POST', `/api/follow-ups/${id}/contact`, { idempotencyKey: newKey(), ...body });

console.log('=== Customer follow-ups (0005) against an in-memory database ===');

/* ---------- A. schema ---------- */
console.log('\n-- A. schema --');
{
  const h = fresh();
  const cols = (t) => h.DB.raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  check('follow_ups has the designed columns', cols('follow_ups'),
    ['id', 'customer_id', 'vehicle_id', 'reason', 'notes', 'priority', 'due_date', 'status', 'last_contact_at',
      'last_outcome', 'closed_at', 'close_note', 'idempotency_key', 'idempotency_fingerprint', 'created_at', 'updated_at']);
  check('follow_up_contacts has the designed columns', cols('follow_up_contacts'),
    ['id', 'follow_up_id', 'contacted_at', 'outcome', 'note', 'next_contact_date', 'recorded_by', 'status',
      'void_reason', 'voided_at', 'voided_by', 'idempotency_key', 'idempotency_fingerprint', 'created_at']);
  const fks = (t) => h.DB.raw.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort();
  check('follow_ups: customer and vehicle are ON DELETE RESTRICT', fks('follow_ups'),
    [['customer_id', 'customers', 'RESTRICT'], ['vehicle_id', 'vehicles', 'RESTRICT']]);
  check('follow_up_contacts: the follow-up is ON DELETE RESTRICT', fks('follow_up_contacts'),
    [['follow_up_id', 'follow_ups', 'RESTRICT']]);
  const idx = (t) => h.DB.raw.prepare(`PRAGMA index_list(${t})`).all();
  const uniques = (t) => idx(t).filter((i) => i.unique).map((i) =>
    h.DB.raw.prepare(`PRAGMA index_info(${i.name})`).all().map((c) => c.name).join(','));
  check('the only UNIQUE constraints on follow_ups are the id and the idempotency key (no duplicate-open rule)',
    uniques('follow_ups').sort(), ['id', 'idempotency_key']);
  ok_('   ...and no partial index exists on follow_ups', idx('follow_ups').every((i) => !i.partial), JSON.stringify(idx('follow_ups')));
  check('follow_up_contacts: UNIQUE only on id and the idempotency key', uniques('follow_up_contacts').sort(), ['id', 'idempotency_key']);
  check('the designed indexes exist', [...idx('follow_ups'), ...idx('follow_up_contacts')].filter((i) => i.origin === 'c').map((i) => i.name).sort(),
    ['ix_fu_created', 'ix_fu_customer', 'ix_fu_status_due', 'ix_fu_vehicle', 'ix_fuc_created', 'ix_fuc_followup']);
  check('counters FUP and FUC start at 0',
    h.DB.raw.prepare(`SELECT collection, prefix, last_value FROM id_counters WHERE collection LIKE 'followUp%' ORDER BY collection`).all()
      .map((r) => [r.collection, r.prefix, r.last_value]), [['followUpContacts', 'FUC', 0], ['followUps', 'FUP', 0]]);
  const base = `INSERT INTO follow_ups (id, customer_id, reason, priority, due_date, status, idempotency_key, idempotency_fingerprint, created_at, updated_at)`;
  const fp = 'a'.repeat(64);
  const tryIns = (vals) => { try { h.DB.raw.exec(`${base} VALUES (${vals})`); return 'ok'; } catch (e) { return /CHECK/.test(e.message) ? 'check' : e.message; } };
  check('CHECK: priority is normal or high only', tryIns(`'X-1','CUS-0001','r','urgent','2026-10-01','Open','k-000000000000001','${fp}','${AT}','${AT}'`), 'check');
  check('CHECK: a blank reason is refused', tryIns(`'X-2','CUS-0001','   ','normal','2026-10-01','Open','k-000000000000002','${fp}','${AT}','${AT}'`), 'check');
  check('CHECK: a reason over 200 characters is refused', tryIns(`'X-3','CUS-0001','${'r'.repeat(201)}','normal','2026-10-01','Open','k-000000000000003','${fp}','${AT}','${AT}'`), 'check');
  check('CHECK: Cancelled needs a close note', (() => {
    try { h.DB.raw.exec(`${base.replace('updated_at)', 'updated_at, closed_at)')} VALUES ('X-4','CUS-0001','r','normal','2026-10-01','Cancelled','k-000000000000004','${fp}','${AT}','${AT}','${AT}')`); return 'ok'; }
    catch (e) { return /CHECK/.test(e.message) ? 'check' : e.message; } })(), 'check');
  check('CHECK: status outside Open/Completed/Cancelled is refused', tryIns(`'X-5','CUS-0001','r','normal','2026-10-01','Pending','k-000000000000005','${fp}','${AT}','${AT}'`), 'check');
  check('CHECK: a short idempotency key is refused', tryIns(`'X-6','CUS-0001','r','normal','2026-10-01','Open','short','${fp}','${AT}','${AT}'`), 'check');
}

/* ---------- B. create ---------- */
console.log('\n-- B. create --');
{
  const h = fresh();
  const r = await create(h);
  check('a valid follow-up -> 201', r.status, 201);
  check('   ...the record the UI reads, with no internal columns', Object.keys(r.body.data),
    ['id', 'customerId', 'vehicleId', 'reason', 'notes', 'priority', 'dueDate', 'status', 'lastContactAt',
      'lastOutcome', 'closedAt', 'closeNote', 'createdAt', 'updatedAt']);
  check('   ...FUP-0001, Open, no contact yet', [r.body.data.id, r.body.data.status, r.body.data.lastOutcome, r.body.data.lastContactAt],
    ['FUP-0001', 'Open', null, null]);
  ok_('   ...no replayed flag on a first success', !('replayed' in r.body), JSON.stringify(r.body));
  const again = await create(h);   // new key, identical content
  check('the same customer + vehicle + reason again (new key) -> 201: duplicates Open are allowed', again.status, 201);
  const third = await create(h, { vehicleId: null });
  check('   ...and with no vehicle', [third.status, third.body.data.vehicleId], [201, null]);
  check('three Open follow-ups now exist', h.n('follow_ups'), 3);

  const defaults = await create(h, { priority: undefined, notes: undefined });
  check('priority defaults to normal; notes to empty', [defaults.body.data.priority, defaults.body.data.notes], ['normal', '']);

  for (const [label, dueDate] of [['a past date', '1990-01-01'], ['today-ish', '2026-10-14'], ['far future', '2099-12-31'], ['leap day', '2028-02-29']]) {
    const d = await create(h, { dueDate });
    check(`dueDate ${label} (${dueDate}) is accepted -- no range limit`, [d.status, d.body.data?.dueDate], [201, dueDate]);
  }
  for (const [label, dueDate] of [['impossible day', '2026-02-30'], ['month 13', '2026-13-01'], ['short form', '26-1-1'],
    ['no dashes', '20261014'], ['a number', 20261014], ['a boolean', true], ['an object', { y: 2026 }], ['an array', ['2026-10-14']],
    ['a timestamp', '2026-10-14T00:00:00Z'], ['non-leap Feb 29', '2027-02-29']]) {
    const d = await create(h, { dueDate });
    check(`dueDate ${label} -> 422 fields.dueDate`, [d.status, Object.keys(d.body.error?.fields ?? {})], [422, ['dueDate']]);
  }
  const missing = await h.api('POST', '/api/follow-ups', { idempotencyKey: newKey() });
  check('missing required fields -> 422 naming each', [missing.status, Object.keys(missing.body.error.fields).sort()],
    [422, ['customerId', 'dueDate', 'reason']]);
  check('   ...using the existing unprocessable envelope', missing.body.error.code, 'unprocessable');
  const long = await create(h, { reason: 'r'.repeat(201), notes: 'n'.repeat(1001) });
  check('reason > 200 and notes > 1000 -> 422', Object.keys(long.body.error.fields).sort(), ['notes', 'reason']);
  const edge = await create(h, { reason: 'r'.repeat(200), notes: 'n'.repeat(1000) });
  check('   ...exactly 200 and 1000 are accepted', edge.status, 201);
  const pri = await create(h, { priority: 'urgent' });
  check('priority outside normal/high -> 422', [pri.status, Object.keys(pri.body.error.fields)], [422, ['priority']]);
  const before = h.n('follow_ups');
  const counterBefore = h.one(`SELECT last_value FROM id_counters WHERE collection = 'followUps'`).last_value;
  const bad = await create(h, { reason: '' });
  check('a refused create writes nothing and spends no id', [bad.status, h.n('follow_ups'),
    h.one(`SELECT last_value FROM id_counters WHERE collection = 'followUps'`).last_value], [422, before, counterBefore]);
  const body400 = await h.api('POST', '/api/follow-ups', 'not json');
  check('a body that is not JSON -> 400 invalid_body', [body400.status, body400.body.error.code], [400, 'invalid_body']);
}

console.log('\n-- B2. strict allow-list --');
{
  const h = fresh();
  for (const key of ['status', 'lastOutcome', 'lastContactAt', 'id', 'createdAt', 'updatedAt', 'closedAt', 'closeNote',
    'idempotencyFingerprint', 'contactedAt', 'somethingElse']) {
    const r = await create(h, { [key]: 'x' });
    check(`create with "${key}" -> 422 fields.${key}`, [r.status, Object.keys(r.body.error?.fields ?? {})], [422, [key]]);
  }
  check('   ...and nothing was written', h.n('follow_ups'), 0);
  const msg = (await create(h, { status: 'Completed' })).body.error.fields.status;
  ok_('a server-owned key is refused with a reason, not silently ignored', /set by the server/.test(msg), msg);
}

console.log('\n-- B3. customer and vehicle --');
{
  const h = fresh();
  const cases = [
    ['a customer that does not exist', { customerId: 'CUS-0999', vehicleId: null }, 409, 'customer_not_found'],
    ['an Inactive customer', { customerId: 'CUS-0003', vehicleId: null }, 409, 'customer_inactive'],
    ['a vehicle that does not exist', { vehicleId: 'VEH-0999' }, 409, 'vehicle_not_found'],
    ['an Inactive vehicle', { vehicleId: 'VEH-0003' }, 409, 'vehicle_inactive'],
  ];
  for (const [label, extra, status, reason] of cases) {
    const r = await create(h, extra);
    check(`${label} -> ${status} ${reason}`, [r.status, r.body.error?.reason], [status, reason]);
  }
  const other = await create(h, { vehicleId: 'VEH-0002' });
  check("another customer's vehicle -> 422 fields.vehicleId", [other.status, other.body.error?.fields?.vehicleId],
    [422, 'Selected vehicle does not belong to this customer.']);
  const malformed = await create(h, { customerId: "CUS-1'; DROP TABLE x;--" });
  check('a malformed customer id -> 422, never reaching SQL as text', [malformed.status, Object.keys(malformed.body.error.fields)], [422, ['customerId']]);
  check('none of those wrote a row', h.n('follow_ups'), 0);
  ok_('   ...and no refusal echoes a customer name or phone',
    !JSON.stringify(cases).includes('Rahim') && !JSON.stringify(other.body).includes('Rahim'), '');
}

/* ---------- C. idempotency ---------- */
console.log('\n-- C. idempotency --');
{
  const h = fresh();
  const body = GOOD();
  const first = await h.api('POST', '/api/follow-ups', body);
  const second = await h.api('POST', '/api/follow-ups', body);
  check('same key + same payload: first 201, second 200', [first.status, second.status], [201, 200]);
  check('   ...the replay says replayed: true and returns the same id', [second.body.replayed, second.body.data.id], [true, first.body.data.id]);
  check('   ...and only one row exists', h.n('follow_ups'), 1);
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  const third = await h.api('POST', '/api/follow-ups', reordered);
  check('key order does not change the fingerprint', [third.status, third.body.replayed], [200, true]);
  const padded = await h.api('POST', '/api/follow-ups', { ...body, reason: `  ${body.reason}  ` });
  check('   ...nor does surrounding whitespace (the payload is normalised)', [padded.status, padded.body.replayed], [200, true]);
  const changed = await h.api('POST', '/api/follow-ups', { ...body, dueDate: '2026-10-21' });
  check('same key + different payload -> 409 idempotency_key_reused', [changed.status, changed.body.error?.reason], [409, 'idempotency_key_reused']);
  ok_('   ...with no stored data echoed back', !JSON.stringify(changed.body).includes(body.notes), JSON.stringify(changed.body));
  check('   ...and nothing new written', h.n('follow_ups'), 1);

  const edited = await h.api('PUT', `/api/follow-ups/${first.body.data.id}`, { reason: 'Edited reason', dueDate: '2026-11-01' });
  check('the follow-up is edited', edited.status, 200);
  const afterEdit = await h.api('POST', '/api/follow-ups', body);
  check('a replay AFTER an edit is still recognised (fingerprint, not current columns)', [afterEdit.status, afterEdit.body.replayed], [200, true]);
  check('   ...and shows the current state of the same resource', [afterEdit.body.data.id, afterEdit.body.data.reason], [first.body.data.id, 'Edited reason']);
  const closed = await h.api('POST', `/api/follow-ups/${first.body.data.id}/complete`, {});
  check('the follow-up is completed', closed.status, 200);
  const afterClose = await h.api('POST', '/api/follow-ups', body);
  check('   ...and a replay is still 200 replayed, now showing Completed', [afterClose.status, afterClose.body.data.status], [200, 'Completed']);

  for (const [label, k] of [['missing', undefined], ['empty', ''], ['too short', 'abc'], ['too long', 'k'.repeat(65)],
    ['illegal characters', 'key with spaces 12345'], ['a number', 1234567890123456789]]) {
    const r = await h.api('POST', '/api/follow-ups', { ...GOOD(), idempotencyKey: k });
    check(`idempotencyKey ${label} -> 422 fields.idempotencyKey`, [r.status, Object.keys(r.body.error?.fields ?? {})], [422, ['idempotencyKey']]);
  }
  check('none of those wrote a row', h.n('follow_ups'), 1);
}
{
  const h = fresh();
  const body = GOOD();
  const results = await Promise.all(Array.from({ length: 6 }, () => h.api('POST', '/api/follow-ups', body)));
  const statuses = results.map((r) => r.status).sort();
  check('six concurrent requests with one key -> exactly one row', h.n('follow_ups'), 1);
  check('   ...one 201 and five 200 replays', statuses, [200, 200, 200, 200, 200, 201]);
  check('   ...all naming the same follow-up', [...new Set(results.map((r) => r.body.data.id))], ['FUP-0001']);
  ok_('   ...every 200 is marked replayed', results.filter((r) => r.status === 200).every((r) => r.body.replayed === true), '');
}

/* ---------- D. update ---------- */
console.log('\n-- D. update --');
{
  const h = fresh();
  const id = (await create(h)).body.data.id;
  const r = await h.api('PUT', `/api/follow-ups/${id}`, { priority: 'normal', notes: '', vehicleId: 'VEH-0004' });
  check('PUT merges permitted fields', [r.status, r.body.data.priority, r.body.data.notes, r.body.data.vehicleId], [200, 'normal', '', 'VEH-0004']);
  check('   ...reason and due date untouched', [r.body.data.reason, r.body.data.dueDate], ['Check brake noise after service', '2026-10-20']);
  const clear = await h.api('PUT', `/api/follow-ups/${id}`, { vehicleId: null });
  check('vehicleId null clears the vehicle', [clear.status, clear.body.data.vehicleId], [200, null]);
  const otherOwner = await h.api('PUT', `/api/follow-ups/${id}`, { vehicleId: 'VEH-0002' });
  check("another customer's vehicle -> 422 fields.vehicleId", [otherOwner.status, otherOwner.body.error?.fields?.vehicleId],
    [422, 'Selected vehicle does not belong to this customer.']);
  const inactive = await h.api('PUT', `/api/follow-ups/${id}`, { vehicleId: 'VEH-0003' });
  check('an Inactive vehicle -> 409 vehicle_inactive', [inactive.status, inactive.body.error?.reason], [409, 'vehicle_inactive']);
  const ghost = await h.api('PUT', `/api/follow-ups/${id}`, { vehicleId: 'VEH-0999' });
  check('a missing vehicle -> 409 vehicle_not_found', [ghost.status, ghost.body.error?.reason], [409, 'vehicle_not_found']);
  for (const key of ['customerId', 'status', 'idempotencyKey', 'lastOutcome', 'closedAt', 'createdAt']) {
    const x = await h.api('PUT', `/api/follow-ups/${id}`, { [key]: 'x' });
    check(`PUT with "${key}" -> 422`, [x.status, Object.keys(x.body.error?.fields ?? {})], [422, [key]]);
  }
  const empty = await h.api('PUT', `/api/follow-ups/${id}`, {});
  check('an empty PUT -> 422', empty.status, 422);
  const pastDue = await h.api('PUT', `/api/follow-ups/${id}`, { dueDate: '2000-01-01' });
  check('a past due date is accepted on update', [pastDue.status, pastDue.body.data.dueDate], [200, '2000-01-01']);
  const badDue = await h.api('PUT', `/api/follow-ups/${id}`, { dueDate: '2026-04-31' });
  check('an impossible due date on update -> 422', badDue.status, 422);
  const nf = await h.api('PUT', '/api/follow-ups/FUP-0999', { reason: 'x' });
  check('an unknown follow-up -> 404', nf.status, 404);
  await h.api('POST', `/api/follow-ups/${id}/cancel`, { reason: 'Customer sold the car' });
  const afterClose = await h.api('PUT', `/api/follow-ups/${id}`, { reason: 'too late' });
  check('a closed follow-up cannot be edited -> 409 follow_up_closed + currentStatus',
    [afterClose.status, afterClose.body.error?.reason, afterClose.body.error?.currentStatus], [409, 'follow_up_closed', 'Cancelled']);
  check('   ...and its reason is unchanged', h.one('SELECT reason FROM follow_ups WHERE id = ?', id).reason, 'Check brake noise after service');
}
{
  const h = fresh();
  const id = (await create(h)).body.data.id;
  h.DB.raw.exec(`UPDATE vehicles SET status = 'Inactive' WHERE id = 'VEH-0001'`);
  const keep = await h.api('PUT', `/api/follow-ups/${id}`, { vehicleId: 'VEH-0001', reason: 'Still the same car' });
  check('keeping the current vehicle needs no re-check, even if it became Inactive since', keep.status, 200);
}

/* ---------- E. complete / cancel ---------- */
console.log('\n-- E. complete and cancel --');
{
  const h = fresh();
  const a = (await create(h)).body.data.id;
  const b = (await create(h)).body.data.id;
  const done = await h.api('POST', `/api/follow-ups/${a}/complete`, { note: 'Customer is happy' });
  check('complete -> 200 Completed with the note and a close time',
    [done.status, done.body.data.status, done.body.data.closeNote, typeof done.body.data.closedAt], [200, 'Completed', 'Customer is happy', 'string']);
  const noBody = await call(`/api/follow-ups/${b}/complete`, h.env, 'POST');
  check('complete with no body at all is fine (the note is optional)', noBody.status, 200);
  const again = await h.api('POST', `/api/follow-ups/${a}/complete`, {});
  check('complete again -> 409 follow_up_closed, currentStatus Completed',
    [again.status, again.body.error?.reason, again.body.error?.currentStatus], [409, 'follow_up_closed', 'Completed']);
  const cancelDone = await h.api('POST', `/api/follow-ups/${a}/cancel`, { reason: 'x' });
  check('cancel a Completed follow-up -> 409 (no reopening, no flip)', [cancelDone.status, cancelDone.body.error?.currentStatus], [409, 'Completed']);
  const c = (await create(h)).body.data.id;
  const noReason = await h.api('POST', `/api/follow-ups/${c}/cancel`, {});
  check('cancel without a reason -> 422 fields.reason', [noReason.status, Object.keys(noReason.body.error?.fields ?? {})], [422, ['reason']]);
  const blank = await h.api('POST', `/api/follow-ups/${c}/cancel`, { reason: '   ' });
  check('   ...a blank reason too', blank.status, 422);
  const longR = await h.api('POST', `/api/follow-ups/${c}/cancel`, { reason: 'r'.repeat(501) });
  check('   ...and one over 500 characters', longR.status, 422);
  const longN = await h.api('POST', `/api/follow-ups/${c}/complete`, { note: 'n'.repeat(501) });
  check('a completion note over 500 characters -> 422', longN.status, 422);
  const extra = await h.api('POST', `/api/follow-ups/${c}/cancel`, { reason: 'ok', status: 'Open' });
  check('cancel with an extra key -> 422', [extra.status, Object.keys(extra.body.error.fields)], [422, ['status']]);
  const cancelled = await h.api('POST', `/api/follow-ups/${c}/cancel`, { reason: 'Customer moved away' });
  check('cancel -> 200 Cancelled, reason kept as the close note', [cancelled.status, cancelled.body.data.status, cancelled.body.data.closeNote],
    [200, 'Cancelled', 'Customer moved away']);
  const reCancel = await h.api('POST', `/api/follow-ups/${c}/cancel`, { reason: 'again' });
  check('cancel again -> 409 currentStatus Cancelled', [reCancel.status, reCancel.body.error?.currentStatus], [409, 'Cancelled']);
  check('   ...the first reason is kept', h.one('SELECT close_note FROM follow_ups WHERE id = ?', c).close_note, 'Customer moved away');
  const nf = await h.api('POST', '/api/follow-ups/FUP-0999/complete', {});
  check('an unknown follow-up -> 404', nf.status, 404);
}

/* ---------- F. contacts ---------- */
console.log('\n-- F. contacts --');
{
  const h = fresh();
  const id = (await create(h)).body.data.id;
  const r = await contact(h, id, { outcome: 'unreachable', note: 'No answer', recordedBy: 'Sumon' });
  check('record a contact -> 201', r.status, 201);
  check('   ...data is the updated follow-up, contact is the new contact', [r.body.data.id, r.body.contact.followUpId, r.body.contact.id],
    [id, id, 'FUC-0001']);
  check('   ...the contact record has no internal columns', Object.keys(r.body.contact),
    ['id', 'followUpId', 'contactedAt', 'outcome', 'note', 'nextContactDate', 'recordedBy', 'status', 'voidReason', 'voidedAt', 'voidedBy', 'createdAt']);
  check('   ...the follow-up caches it', [r.body.data.lastOutcome, r.body.data.lastContactAt], ['unreachable', r.body.contact.contactedAt]);
  check('   ...no next date given: the due date stays', r.body.data.dueDate, '2026-10-20');
  const client = await contact(h, id, { outcome: 'reached', contactedAt: '2020-01-01T00:00:00Z' });
  check('a client-supplied contactedAt is refused (server time only)', [client.status, Object.keys(client.body.error.fields)], [422, ['contactedAt']]);

  const cb = await contact(h, id, { outcome: 'callback_requested' });
  check('callback_requested without nextContactDate -> 422', [cb.status, Object.keys(cb.body.error.fields)], [422, ['nextContactDate']]);
  const other = await contact(h, id, { outcome: 'other', note: '  ' });
  check('other without a note -> 422', [other.status, Object.keys(other.body.error.fields)], [422, ['note']]);
  const bad = await contact(h, id, { outcome: 'busy' });
  check('an unknown outcome -> 422', bad.status, 422);
  const badDate = await contact(h, id, { outcome: 'callback_requested', nextContactDate: '2026-02-30' });
  check('an impossible nextContactDate -> 422', [badDate.status, Object.keys(badDate.body.error.fields)], [422, ['nextContactDate']]);
  const longNote = await contact(h, id, { outcome: 'reached', note: 'n'.repeat(1001) });
  check('a note over 1000 characters -> 422', longNote.status, 422);
  const longName = await contact(h, id, { outcome: 'reached', recordedBy: 'n'.repeat(101) });
  check('recordedBy over 100 characters -> 422', longName.status, 422);

  const past = await contact(h, id, { outcome: 'callback_requested', nextContactDate: '2026-01-05' });
  check('a PAST nextContactDate is accepted and becomes the due date',
    [past.status, past.body.contact.nextContactDate, past.body.data.dueDate], [201, '2026-01-05', '2026-01-05']);
  const fut = await contact(h, id, { outcome: 'reached', nextContactDate: '2099-12-31' });
  check('   ...so is a far-future one, on any outcome', [fut.status, fut.body.data.dueDate, fut.body.data.lastOutcome], [201, '2099-12-31', 'reached']);
  const ok2 = await contact(h, id, { outcome: 'other', note: 'Spoke to his son' });
  check('other with a note -> 201', [ok2.status, ok2.body.data.lastOutcome], [201, 'other']);
  check('reached does not complete the follow-up', h.one('SELECT status FROM follow_ups WHERE id = ?', id).status, 'Open');

  const same = { outcome: 'unreachable', note: 'No answer' };
  const t1 = await contact(h, id, same);
  const t2 = await contact(h, id, same);
  check('two contacts with identical content and NEW keys, back to back -> both recorded', [t1.status, t2.status], [201, 201]);

  await h.api('POST', `/api/follow-ups/${id}/complete`, {});
  const closed = await contact(h, id, { outcome: 'reached' });
  check('a contact on a Completed follow-up -> 409 follow_up_closed', [closed.status, closed.body.error?.reason], [409, 'follow_up_closed']);
  const nf = await contact(h, 'FUP-0999', { outcome: 'reached' });
  check('a contact on an unknown follow-up -> 404', nf.status, 404);
  const c2 = (await create(h)).body.data.id;
  await h.api('POST', `/api/follow-ups/${c2}/cancel`, { reason: 'Not needed' });
  const onCancelled = await contact(h, c2, { outcome: 'reached' });
  check('   ...and on a Cancelled one', [onCancelled.status, onCancelled.body.error?.currentStatus], [409, 'Cancelled']);
}
console.log('\n-- F2. contact idempotency --');
{
  const h = fresh();
  const id = (await create(h)).body.data.id;
  const body = { idempotencyKey: newKey(), outcome: 'callback_requested', nextContactDate: '2026-10-25', note: 'After Friday' };
  const first = await h.api('POST', `/api/follow-ups/${id}/contact`, body);
  const second = await h.api('POST', `/api/follow-ups/${id}/contact`, body);
  check('same key + same payload: 201 then 200 replayed', [first.status, second.status, second.body.replayed], [201, 200, true]);
  check('   ...the same contact id, one row', [second.body.contact.id, h.n('follow_up_contacts')], [first.body.contact.id, 1]);
  check('   ...data is the follow-up', second.body.data.id, id);
  const diff = await h.api('POST', `/api/follow-ups/${id}/contact`, { ...body, note: 'Different' });
  check('same key + different payload -> 409 idempotency_key_reused', [diff.status, diff.body.error?.reason], [409, 'idempotency_key_reused']);
  const other = (await create(h)).body.data.id;
  const otherFu = await h.api('POST', `/api/follow-ups/${other}/contact`, body);
  check('the same key against another follow-up -> 409 (the follow-up is part of the payload)', [otherFu.status, otherFu.body.error?.reason], [409, 'idempotency_key_reused']);
  check('   ...still one contact', h.n('follow_up_contacts'), 1);
  const cross = await h.api('POST', '/api/follow-ups', GOOD({ idempotencyKey: body.idempotencyKey }));
  check('a contact key reused for a follow-up create is a different table: allowed', cross.status, 201);

  await h.api('POST', `/api/follow-ups/${id}/complete`, {});
  const afterClose = await h.api('POST', `/api/follow-ups/${id}/contact`, body);
  check('a replay after the follow-up closed -> 200 replayed (not follow_up_closed)', [afterClose.status, afterClose.body.replayed], [200, true]);
  await h.api('POST', `/api/follow-up-contacts/${first.body.contact.id}/void`, { reason: 'Wrong customer' });
  const afterVoid = await h.api('POST', `/api/follow-ups/${id}/contact`, body);
  check('a replay after the contact was voided -> 200 replayed, showing it Void', [afterVoid.status, afterVoid.body.contact.status], [200, 'Void']);
  check('   ...and still one contact row', h.n('follow_up_contacts'), 1);
}
{
  const h = fresh();
  const id = (await create(h)).body.data.id;
  const body = { idempotencyKey: newKey(), outcome: 'reached' };
  const results = await Promise.all(Array.from({ length: 6 }, () => h.api('POST', `/api/follow-ups/${id}/contact`, body)));
  check('six concurrent contact requests with one key -> exactly one contact', h.n('follow_up_contacts'), 1);
  check('   ...one 201 and five 200 replays', results.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 201]);
  check('   ...all naming the same contact', [...new Set(results.map((r) => r.body.contact.id))], ['FUC-0001']);
}

/* ---------- G. void and the cache ---------- */
console.log('\n-- G. void and the latest-contact cache --');
{
  const h = fresh();
  const id = (await create(h)).body.data.id;
  const c1 = (await contact(h, id, { outcome: 'reached', note: 'Happy' })).body.contact.id;
  const c2r = await contact(h, id, { outcome: 'unreachable', nextContactDate: '2026-11-11' });
  const c2 = c2r.body.contact.id;
  check('a later unreachable replaces the earlier reached', c2r.body.data.lastOutcome, 'unreachable');
  check('   ...and moved the due date', c2r.body.data.dueDate, '2026-11-11');

  const v = await h.api('POST', `/api/follow-up-contacts/${c2}/void`, { reason: 'Logged on the wrong follow-up', voidedBy: 'Manager' });
  check('void -> 200, the contact is Void with reason, time and name',
    [v.status, v.body.data.status, v.body.data.voidReason, v.body.data.voidedBy, typeof v.body.data.voidedAt], [200, 'Void', 'Logged on the wrong follow-up', 'Manager', 'string']);
  check('   ...the outcome and note are untouched', [v.body.data.outcome, v.body.data.nextContactDate], ['unreachable', '2026-11-11']);
  check('   ...the previous Active contact counts again', [v.body.followUp.lastOutcome, v.body.followUp.lastContactAt],
    ['reached', h.one('SELECT contacted_at FROM follow_up_contacts WHERE id = ?', c1).contacted_at]);
  check('   ...and the due date is NOT restored', v.body.followUp.dueDate, '2026-11-11');
  const fu = h.one('SELECT reason, notes, priority, status, vehicle_id FROM follow_ups WHERE id = ?', id);
  check('   ...nothing else on the follow-up changed', [fu.reason, fu.priority, fu.status, fu.vehicle_id],
    ['Check brake noise after service', 'high', 'Open', 'VEH-0001']);
  const again = await h.api('POST', `/api/follow-up-contacts/${c2}/void`, { reason: 'again' });
  check('void again -> 409 contact_void', [again.status, again.body.error?.reason], [409, 'contact_void']);
  const noReason = await h.api('POST', `/api/follow-up-contacts/${c1}/void`, {});
  check('void without a reason -> 422', [noReason.status, Object.keys(noReason.body.error.fields)], [422, ['reason']]);
  const blank = await h.api('POST', `/api/follow-up-contacts/${c1}/void`, { reason: ' ' });
  check('   ...blank -> 422', blank.status, 422);
  const longR = await h.api('POST', `/api/follow-up-contacts/${c1}/void`, { reason: 'r'.repeat(501) });
  check('   ...over 500 characters -> 422', longR.status, 422);
  const extra = await h.api('POST', `/api/follow-up-contacts/${c1}/void`, { reason: 'ok', status: 'Active' });
  check('void with an extra key -> 422', [extra.status, Object.keys(extra.body.error.fields)], [422, ['status']]);
  const all = await h.api('POST', `/api/follow-up-contacts/${c1}/void`, { reason: 'Duplicate entry' });
  check('void the last Active contact -> the cache is empty again', [all.body.followUp.lastOutcome, all.body.followUp.lastContactAt], [null, null]);
  const hist = await h.api('GET', '/api/follow-up-contacts');
  check('voided contacts stay in the history', hist.body.data.map((c) => [c.id, c.status]).sort(), [[c1, 'Void'], [c2, 'Void']]);
  const nf = await h.api('POST', '/api/follow-up-contacts/FUC-0999/void', { reason: 'x' });
  check('void an unknown contact -> 404', nf.status, 404);

  await h.api('POST', `/api/follow-ups/${id}/complete`, {});
  const c3 = (await create(h)).body.data.id;
  const k = (await contact(h, c3, { outcome: 'reached' })).body.contact.id;
  await h.api('POST', `/api/follow-ups/${c3}/cancel`, { reason: 'Customer asked to stop' });
  const onClosed = await h.api('POST', `/api/follow-up-contacts/${k}/void`, { reason: 'Mistake' });
  check('a contact on a Cancelled follow-up can still be voided', [onClosed.status, onClosed.body.followUp.status, onClosed.body.followUp.lastOutcome],
    [200, 'Cancelled', null]);
}
{
  const h = fresh();
  const id = (await create(h)).body.data.id;
  // Two contacts in the same millisecond: the later insert (higher rowid) wins.
  const fp = 'f'.repeat(64);
  h.DB.raw.exec(`
    INSERT INTO follow_up_contacts (id, follow_up_id, contacted_at, outcome, status, idempotency_key, idempotency_fingerprint, created_at)
      VALUES ('FUC-0101', '${id}', '2026-10-10T10:00:00.000Z', 'reached', 'Active', 'same-ms-key-000001', '${fp}', '2026-10-10T10:00:00.000Z');
    INSERT INTO follow_up_contacts (id, follow_up_id, contacted_at, outcome, status, idempotency_key, idempotency_fingerprint, created_at)
      VALUES ('FUC-0099', '${id}', '2026-10-10T10:00:00.000Z', 'unreachable', 'Active', 'same-ms-key-000002', '${fp}', '2026-10-10T10:00:00.000Z');
    INSERT INTO follow_up_contacts (id, follow_up_id, contacted_at, outcome, status, idempotency_key, idempotency_fingerprint, created_at)
      VALUES ('FUC-0098', '${id}', '2026-10-09T10:00:00.000Z', 'reached', 'Active', 'same-ms-key-000003', '${fp}', '2026-10-09T10:00:00.000Z');`);
  // Trigger a recompute through a real void of an unrelated older contact.
  const v = await h.api('POST', '/api/follow-up-contacts/FUC-0098/void', { reason: 'test' });
  check('same-millisecond contacts: the later-inserted one wins (rowid), not the text id', v.body.followUp.lastOutcome, 'unreachable');
}

/* ---------- H. deletion ---------- */
console.log('\n-- H. deleting a referenced customer or vehicle --');
{
  const h = fresh();
  const id = (await create(h)).body.data.id;
  await h.api('POST', `/api/follow-ups/${id}/complete`, {});
  const delV = await h.api('DELETE', '/api/vehicles/VEH-0001');
  check('a vehicle with a (closed) follow-up cannot be deleted -> 409', delV.status, 409);
  // A customer whose ONLY reference is a follow-up proves the follow-up FK on its own:
  h.DB.raw.exec(`INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0010', 'Solo', '01700000010', '${AT}')`);
  const solo = await create(h, { customerId: 'CUS-0010', vehicleId: null });
  const delSolo = await h.api('DELETE', '/api/customers/CUS-0010');
  check('a customer whose only reference is a follow-up cannot be deleted -> 409', [solo.status, delSolo.status], [201, 409]);
  check('   ...the generic, data-free message', delSolo.body.error.message, 'A record this refers to does not exist, or is still in use.');
  ok_('   ...both rows still exist', h.one(`SELECT count(*) AS n FROM customers WHERE id = 'CUS-0010'`).n === 1
    && h.one(`SELECT count(*) AS n FROM vehicles WHERE id = 'VEH-0001'`).n === 1, '');
  h.DB.raw.exec(`INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0011', 'Free', '01700000011', '${AT}')`);
  const delFree = await h.api('DELETE', '/api/customers/CUS-0011');
  check('an unreferenced customer still deletes (existing behaviour unchanged)', delFree.status, 200);
}

/* ---------- I. atomicity ---------- */
console.log('\n-- I. a failed batch leaves nothing behind --');
{
  const h = fresh();
  const id = (await create(h)).body.data.id;
  await contact(h, id, { outcome: 'reached' });
  const before = h.one('SELECT last_outcome, due_date, updated_at FROM follow_ups WHERE id = ?', id);
  h.DB.failBatchAt = 1;   // the cache UPDATE fails after the contact INSERT ran
  const r = await contact(h, id, { outcome: 'unreachable', nextContactDate: '2030-01-01' });
  h.DB.failBatchAt = null;
  check('the request fails with a generic 500', [r.status, r.body.error.code, r.body.error.message], [500, 'database_error', 'Could not record the contact.']);
  ok_('   ...no SQL or internal text in the response', !/D1_ERROR|injected|follow_up_contacts/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
  check('   ...no contact row was left behind', h.n('follow_up_contacts'), 1);
  check('   ...and the follow-up is exactly as before', h.one('SELECT last_outcome, due_date, updated_at FROM follow_ups WHERE id = ?', id), before);
  const contactId = h.one('SELECT id FROM follow_up_contacts').id;
  h.DB.failBatchAt = 1;
  const v = await h.api('POST', `/api/follow-up-contacts/${contactId}/void`, { reason: 'x' });
  h.DB.failBatchAt = null;
  check('a failed void batch: 500, and the contact is still Active', [v.status, h.one('SELECT status FROM follow_up_contacts WHERE id = ?', contactId).status], [500, 'Active']);
}

/* ---------- J. routes ---------- */
console.log('\n-- J. routes and responses --');
{
  const h = fresh();
  const id = (await create(h)).body.data.id;
  await contact(h, id, { outcome: 'reached' });
  const putC = await h.api('PUT', '/api/follow-up-contacts/FUC-0001', { note: 'edit' });
  const delC = await h.api('DELETE', '/api/follow-up-contacts/FUC-0001');
  const postC = await h.api('POST', '/api/follow-up-contacts', { followUpId: id, outcome: 'reached' });
  check('the contact history has no PUT, DELETE or POST: 405 for each', [putC.status, delC.status, postC.status], [405, 405, 405]);
  check('   ...advertising only what it takes', [putC.allow, postC.allow], ['GET', 'GET']);
  check('   ...and the contact is unchanged', h.one('SELECT note, status FROM follow_up_contacts').status, 'Active');
  const delF = await h.api('DELETE', `/api/follow-ups/${id}`);
  check('a follow-up cannot be deleted either: 405', [delF.status, delF.allow], [405, 'GET, PUT']);
  const getAct = await h.api('GET', `/api/follow-ups/${id}/complete`);
  check('an action is POST only', getAct.status, 405);
  const list = await h.api('GET', '/api/follow-ups');
  check('GET /api/follow-ups: the standard envelope', [list.status, list.body.count, list.body.total, list.body.limit, list.body.offset], [200, 1, 1, 500, 0]);
  const det = await h.api('GET', `/api/follow-ups/${id}`);
  check('GET /api/follow-ups/:id', [det.status, det.body.data.id], [200, id]);
  const detC = await h.api('GET', '/api/follow-up-contacts/FUC-0001');
  check('GET /api/follow-up-contacts/:id', [detC.status, detC.body.data.followUpId], [200, id]);
  ok_('no response carries the idempotency key or fingerprint',
    !/idempotency/i.test(JSON.stringify([list.body, det.body, detC.body])), '');
  const badId = await h.api('GET', "/api/follow-ups/FUP-1'--");
  check('a malformed id -> 400', badId.status, 400);

  // Authentication: every new route is behind the router's gate.
  const NEW_ROUTES = [
    'GET /api/follow-ups', 'POST /api/follow-ups', 'GET /api/follow-ups/:id', 'PUT /api/follow-ups/:id',
    'POST /api/follow-ups/:id/complete', 'POST /api/follow-ups/:id/cancel', 'POST /api/follow-ups/:id/contact',
    'GET /api/follow-up-contacts', 'GET /api/follow-up-contacts/:id', 'POST /api/follow-up-contacts/:id/void',
  ];
  const health = await (await call('/api/health', h.env, 'GET')).json();
  check('health advertises exactly these ten follow-up routes',
    health.data.routes.filter((r) => r.includes('/follow-up')), NEW_ROUTES);
  const open = [];
  const before = h.n('follow_ups') + h.n('follow_up_contacts');
  for (const route of NEW_ROUTES) {
    const [method, path] = route.split(' ');
    const concrete = path.replace(':id', path.includes('contacts') ? 'FUC-0001' : id);
    const res = await worker.fetch(new Request('http://worker.local' + concrete, {
      method, ...(method === 'GET' ? {} : { body: JSON.stringify({ idempotencyKey: newKey(), outcome: 'reached', reason: 'x' }) }),
    }), { API_TOKEN: TEST_TOKEN, DB: h.DB });
    if (res.status !== 401) open.push([route, res.status]);
  }
  check('every follow-up route refuses a caller with no credential (401)', open, []);
  check('   ...and none of those requests changed anything', h.n('follow_ups') + h.n('follow_up_contacts'), before);
}
{
  // A database without 0005 (code deployed before the migration): every
  // follow-up route fails closed with a generic 500, and other routes work.
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of MIGRATIONS.slice(0, 4)) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const wrapped = {};
  wrapped.prepare = (sql) => ({
    _b: [], bind(...a) { this._b = a; return this; },
    async first() { return raw.prepare(sql).get(...this._b) ?? null; },
    async all() { return { results: raw.prepare(sql).all(...this._b) }; },
    async run() { const r = raw.prepare(sql).run(...this._b); return { meta: { changes: Number(r.changes) } }; },
  });
  const env = { DB: wrapped };
  const l = await call('/api/follow-ups', env, 'GET');
  const lb = await l.json();
  check('no 0005 tables: GET /api/follow-ups -> 500 database_error', [l.status, lb.error.code], [500, 'database_error']);
  ok_('   ...naming no table or SQL', !/no such table|follow_ups/i.test(JSON.stringify(lb)), JSON.stringify(lb));
  const c = await call('/api/customers', env, 'GET');
  check('   ...while /api/customers still answers 200', c.status, 200);
}

console.log(`\nCustomer follow-ups unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
