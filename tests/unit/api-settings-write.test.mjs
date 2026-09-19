/* PUT /api/settings — unit tests against the REAL Worker handler with a
   stubbed D1 binding.

   Settings is the one singleton, and its write has three things to get right
   that no other route does:

     - it MERGES, because Storage.saveSettings() writes
       `{ ...getSettings(), ...supplied }`. A field left out keeps what it had;
     - it must NOT apply the browser's DEFAULT_SETTINGS. Those live in
       storage.js so the browser never sees a missing field, and writing them
       here would invent a shop's phone number and address. Only the COLUMNS'
       own defaults apply;
     - the theme is not its business. It is a per-device preference read from
       localStorage before first paint, and it is refused by name.

   The cross-field rules are validateSettings()'s, applied to the record as it
   will be AFTER the merge -- judging the patch alone would let a request that
   changes only the closing time past the opening-time comparison. */
import worker from '../../src/index.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

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

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A fully populated settings row, as the table holds it. */
const STORED = {
  business_name: 'Taqwa Automobile Service Center',
  phone: '+880 1711-000000',
  email: 'info@taqwaauto.com',
  website: 'https://taqwa.autos',
  tax_id: 'BIN-123',
  address: 'Diabari, Uttara, Dhaka',
  business_description: 'Full service workshop',
  invoice_footer: 'Thank you.',
  payment_terms: 'Due on collection',
  tax_rate: 5,
  currency: '৳',
  default_appointment_duration: 60,
  opening_time: '09:00',
  closing_time: '18:00',
  working_days: '["Sat","Sun","Mon"]',
  updated_at: '2026-09-10T09:00:00.000Z',
};

/** `stored` null means the shop has never saved its settings. */
function stubDB({ stored = STORED, written = null, throwOnWrite = null } = {}) {
  const calls = [];
  const db = {
    calls,
    get sql() { return calls.map((c) => c.sql).join('\n'); },
    find(fragment) { return calls.find((c) => c.sql.includes(fragment)); },
    all(fragment) { return calls.filter((c) => c.sql.includes(fragment)); },
    prepare(sql) {
      const entry = { sql, binds: null };
      calls.push(entry);
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async first() {
          if (sql.includes('sqlite_master')) return { n: 0 };
          if (sql.includes('INSERT INTO settings') || sql.includes('UPDATE settings')) {
            if (throwOnWrite) throw new Error(throwOnWrite);
            return written ?? { ...(stored ?? STORED), updated_at: '2026-09-19T10:00:00.000Z' };
          }
          if (sql.includes('FROM settings')) return stored;
          return null;
        },
        async all() {
          if (sql.includes('sqlite_master')) return { results: [{ name: 'customers' }] };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
    async batch(statements) { return statements.map(() => ({ meta: { changes: 1 } })); },
  };
  return db;
}

// C-9 put a bearer-token gate in front of every mutation, so this suite
// authenticates the way any caller does: the token in the header, and the
// Worker's own secret in the env it is handed. The gate itself is tested in
// api-auth.test.mjs -- here it is simply satisfied, so these assertions stay
// about the route. An env without a DB still has the token, so a missing
// binding is still answered by the route rather than by the gate.
const TEST_TOKEN = 'unit-test-token';
const call = (path, env, method, body) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { API_TOKEN: TEST_TOKEN, ...env });
const put = (body, db) => call('/api/settings', { DB: db ?? stubDB() }, 'PUT', body);
const bodyOf = async (res) => res.json();

/**
 * The one statement that writes, whichever form it took: a merge is an UPDATE
 * and a first save is an INSERT, because an UPSERT's INSERT is evaluated
 * first and would trip business_name's NOT NULL on a partial merge.
 */
const writeStatement = (db) =>
  db.calls.find((c) => /^\s*(INSERT INTO settings|UPDATE settings)/.test(c.sql));
const writtenColumns = (db) => {
  const w = writeStatement(db);
  const insert = w.sql.match(/INSERT INTO settings \(id, ([^)]+)\)/);
  if (insert) return insert[1].split(',').map((s) => s.trim());
  return w.sql.match(/SET ([\s\S]+?)\s+WHERE/)[1]
    .split(',').map((s) => s.trim().split(' ')[0]);
};
const writtenAt = (db) => {
  const w = writeStatement(db);
  const names = writtenColumns(db);
  return (col) => w.binds[names.indexOf(col)];
};

/* ============================================================
   1. A valid write
   ============================================================ */
console.log('\n=== PUT /api/settings ===');
console.log('\n-- 1. A full save --');
{
  const db = stubDB();
  const res = await put({
    businessName: 'Taqwa Auto', phone: '01711-111111', email: 'a@b.com',
    website: 'https://example.com', taxId: 'BIN-9', address: 'Uttara',
    businessDescription: 'desc', invoiceFooter: 'footer', paymentTerms: 'terms',
    taxRate: 7.5, currency: '$', defaultAppointmentDuration: 45,
    openingTime: '08:00', closingTime: '20:00', workingDays: ['Sat', 'Sun'],
  }, db);
  ok_('PUT -> 200', res.status === 200, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  const b = await bodyOf(res);
  ok_('   ...returns the settings object', !!b.data?.businessName, JSON.stringify(b).slice(0, 200));
  ok_('   ...in the same shape a GET returns',
    'workingDays' in b.data && Array.isArray(b.data.workingDays)
      && 'taxRate' in b.data && !('id' in b.data), Object.keys(b.data ?? {}));
  ok_('   ...with no paging metadata', !('count' in b) && !('total' in b));

  check('exactly one statement writes it',
    db.calls.filter((c) => /^\s*(INSERT|UPDATE)/.test(c.sql)).length, 1);
  ok_('   ...a merge is an UPDATE of the singleton row',
    /^\s*UPDATE settings/.test(writeStatement(db).sql) && /WHERE id = 1/.test(writeStatement(db).sql),
    writeStatement(db).sql);
  ok_('   ...returning the row it wrote', /RETURNING/.test(writeStatement(db).sql));
  const at = writtenAt(db);
  check('every supplied field is written', [at('business_name'), at('tax_rate'), at('currency')],
    ['Taqwa Auto', 7.5, '$']);
  check('   ...including the workshop defaults',
    [at('default_appointment_duration'), at('opening_time'), at('closing_time')],
    [45, '08:00', '20:00']);
  check('   ...and the working days, as JSON', at('working_days'), '["Sat","Sun"]');
}

console.log('\n-- 2. It merges, exactly as Storage.saveSettings does --');
{
  const db = stubDB();
  const res = await put({ taxRate: 10 }, db);
  ok_('a one-field save -> 200', res.status === 200, `got ${res.status}`);
  check('only that column is written', writtenColumns(db), ['tax_rate', 'updated_at']);
  ok_('   ...and only that column is assigned',
    /SET tax_rate = \?1, updated_at = \?2\s+WHERE id = 1/.test(writeStatement(db).sql),
    writeStatement(db).sql);
  ok_('the stored row is read first, so the merged record can be judged',
    !!db.find('FROM settings'), db.sql);
  check('   ...with exactly one read', db.all('FROM settings WHERE id = 1').length, 1);
}
{
  const db = stubDB();
  await put({ businessDescription: 'new description' }, db);
  check('a prose-only save writes prose only', writtenColumns(db),
    ['business_description', 'updated_at']);
}
{
  const db = stubDB();
  const res = await put({}, db);
  check('an empty body -> 422', res.status, 422);
  ok_('   ...and nothing was written', !writeStatement(db), db.sql);
}

console.log('\n-- 3. updatedAt is the server\'s --');
{
  const db = stubDB();
  await put({ taxRate: 6 }, db);
  const stamp = writtenAt(db)('updated_at');
  ok_('every save stamps updated_at',
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(stamp), stamp);
  ok_('   ...and it is always in the statement',
    writtenColumns(db).includes('updated_at'), writtenColumns(db));
}
for (const [field, value] of [
  ['updatedAt', '2020-01-01T00:00:00Z'], ['id', 2], ['theme', 'dark'],
]) {
  const db = stubDB();
  const res = await put({ taxRate: 6, [field]: value }, db);
  check(`\`${field}\` -> 422`, res.status, 422);
  ok_('   ...names the field', !!(await bodyOf(res)).error.fields?.[field]);
  ok_('   ...and nothing was written', !writeStatement(db), db.sql);
}
{
  const b = await bodyOf(await put({ theme: 'dark' }));
  ok_('the theme refusal says where it really lives',
    /per-device preference/.test(b.error.fields.theme), b.error.fields.theme);
}

console.log('\n-- 4. Working days --');
{
  const db = stubDB();
  await put({ workingDays: [] }, db);
  check('an empty array is a real value, stored as []', writtenAt(db)('working_days'), '[]');
}
{
  const db = stubDB();
  await put({ workingDays: ['Sun', 'Mon', 'Sat'] }, db);
  check('the order a caller sends is the order stored',
    writtenAt(db)('working_days'), '["Sun","Mon","Sat"]');
}
{
  const db = stubDB();
  await put({ workingDays: WEEKDAYS }, db);
  check('all seven are allowed', writtenAt(db)('working_days'), JSON.stringify(WEEKDAYS));
}
for (const [why, value] of [
  ['a string instead of an array', 'Mon'],
  ['an object', { Mon: true }],
  ['a day that is not a weekday', ['Monday']],
  ['a day in the wrong case', ['mon']],
  ['a non-string entry', [1]],
  ['the same day twice', ['Mon', 'Mon']],
  ['more than seven entries', [...WEEKDAYS, 'Mon']],
]) {
  const db = stubDB();
  const res = await put({ workingDays: value }, db);
  check(`${why} -> 422`, res.status, 422);
  ok_('   ...names workingDays', !!(await bodyOf(res)).error.fields?.workingDays);
  ok_('   ...and nothing was written', !writeStatement(db), db.sql);
}

console.log('\n-- 5. Numbers --');
for (const rate of [0, 5, 7.5, 100]) {
  const db = stubDB();
  const res = await put({ taxRate: rate }, db);
  ok_(`a tax rate of ${rate} is accepted`, res.status === 200, `got ${res.status}`);
  check('   ...and stored as given', writtenAt(db)('tax_rate'), rate);
}
for (const [why, value] of [
  ['a negative tax rate', -1], ['a tax rate above 100', 101],
  ['a tax rate that is not a number', 'lots'],
  ['a blank tax rate', ''], ['a null tax rate', null],
]) {
  const res = await put({ taxRate: value });
  check(`${why} -> 422`, res.status, 422);
}
{
  const b = await bodyOf(await put({ taxRate: '' }));
  check('a blank tax rate uses the client\'s wording', b.error.fields.taxRate,
    'Tax rate must be a number.');
}
{
  const db = stubDB();
  await put({ defaultAppointmentDuration: 30 }, db);
  check('a duration is stored as a number', writtenAt(db)('default_appointment_duration'), 30);
  const db2 = stubDB();
  await put({ defaultAppointmentDuration: '' }, db2);
  check('   ...and a blank one is NULL, the column\'s "not recorded"',
    writtenAt(db2)('default_appointment_duration'), null);
  const db3 = stubDB();
  await put({ defaultAppointmentDuration: null }, db3);
  check('   ...as is an explicit null', writtenAt(db3)('default_appointment_duration'), null);
}
for (const value of [0, -5]) {
  const res = await put({ defaultAppointmentDuration: value });
  check(`a duration of ${value} -> 422`, res.status, 422);
  check('   ...with the client\'s wording', (await bodyOf(res)).error.fields.defaultAppointmentDuration,
    'Duration must be a positive number of minutes.');
}

console.log('\n-- 6. The cross-field rules, on the MERGED record --');
for (const [why, body, field, message] of [
  ['a blank business name', { businessName: '   ' }, 'businessName', 'Business name is required.'],
  ['a blank address', { address: '' }, 'address', 'Address is required.'],
  ['a blank phone', { phone: '  ' }, 'phone', 'Phone is required.'],
  ['a malformed email', { email: 'not-an-email' }, 'email',
    'Enter a valid email address, or leave it blank.'],
  ['a blank currency', { currency: ' ' }, 'currency', 'Currency symbol is required.'],
  ['a long currency', { currency: 'TAKA!!' }, 'currency',
    'Currency symbol should be short (max 5 characters).'],
  ['a malformed opening time', { openingTime: '25:00' }, 'openingTime', 'Enter a valid time (HH:MM).'],
  ['a malformed closing time', { closingTime: '9am' }, 'closingTime', 'Enter a valid time (HH:MM).'],
]) {
  const db = stubDB();
  const res = await put(body, db);
  check(`${why} -> 422`, res.status, 422);
  check('   ...with the client\'s wording', (await bodyOf(res)).error.fields[field], message);
  ok_('   ...and nothing was written', !writeStatement(db), db.sql);
}
for (const blank of ['', '   ']) {
  ok_(`a blank email is allowed (${JSON.stringify(blank)})`, (await put({ email: blank })).status === 200);
  ok_(`   ...and a blank website too`, (await put({ website: blank })).status === 200);
  ok_(`   ...and blank opening/closing times`,
    (await put({ openingTime: blank, closingTime: blank })).status === 200);
}
for (const site of ['https://example.com', 'http://x.io/a', 'example.com', 'sub.example.co.uk/page']) {
  ok_(`website ${site} is accepted`, (await put({ website: site })).status === 200);
}
for (const site of ['not a website', 'ftp:/nope']) {
  check(`website ${JSON.stringify(site)} -> 422`, (await put({ website: site })).status, 422);
}
{
  // The comparison must see the STORED opening time, not just the patch.
  const res = await put({ closingTime: '08:00' });
  check('a closing time before the STORED opening time -> 422', res.status, 422);
  check('   ...with the client\'s wording', (await bodyOf(res)).error.fields.closingTime,
    'Closing time should be after opening time.');
  const same = await put({ closingTime: '09:00' });
  check('a closing time equal to it -> 422', same.status, 422);
  ok_('   ...and one after it is fine', (await put({ closingTime: '09:01' })).status === 200);
}
{
  // Both supplied at once are compared against each other.
  check('a closing time before a supplied opening time -> 422',
    (await put({ openingTime: '18:00', closingTime: '09:00' })).status, 422);
  ok_('   ...and the right way round is fine',
    (await put({ openingTime: '07:00', closingTime: '08:00' })).status === 200);
}

console.log('\n-- 7. Text is left as text --');
{
  const db = stubDB();
  await put({ businessDescription: '  Full service — engine & body.  ' }, db);
  check('prose is stored trimmed and otherwise untouched',
    writtenAt(db)('business_description'), 'Full service — engine & body.');
}
for (const field of ['taxId', 'invoiceFooter', 'paymentTerms', 'businessDescription']) {
  const res = await put({ [field]: 'anything at all: 123 !@# ৳' });
  ok_(`${field} takes arbitrary text`, res.status === 200, `got ${res.status}`);
}
{
  const res = await put({ businessDescription: 'x'.repeat(5000) });
  check('but prose is still bounded -> 422', res.status, 422);
}

console.log('\n-- 8. The first save creates the singleton --');
{
  const db = stubDB({ stored: null });
  const res = await put({
    businessName: 'New Shop', phone: '01700-000000', address: 'Dhaka',
  }, db);
  ok_('a first save with the three required fields -> 200', res.status === 200,
    `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  ok_('   ...inserts the row', !!writeStatement(db), db.sql);
  ok_('   ...with ON CONFLICT, so two first saves at once merge rather than fail',
    /ON CONFLICT\(id\) DO UPDATE SET/.test(db.find('INSERT INTO settings').sql),
    db.find('INSERT INTO settings').sql);
  ok_('   ...and never writes the browser\'s defaults',
    !writtenColumns(db).includes('tax_rate') && !writtenColumns(db).includes('currency'),
    writtenColumns(db));
  ok_('   ...leaving those to the COLUMN defaults the schema declares',
    !db.sql.includes('Taqwa Automobile Service Center'), db.sql);
}
for (const [why, body] of [
  ['no business name', { phone: '0170', address: 'Dhaka' }],
  ['no phone', { businessName: 'X', address: 'Dhaka' }],
  ['no address', { businessName: 'X', phone: '0170' }],
  ['only a tax rate', { taxRate: 7 }],
]) {
  const db = stubDB({ stored: null });
  const res = await put(body, db);
  check(`a first save with ${why} -> 422`, res.status, 422);
  const b = await bodyOf(res);
  ok_('   ...saying it is the first save',
    /No settings have been saved yet/.test(b.error.message), b.error.message);
  ok_('   ...and nothing was written', !writeStatement(db), db.sql);
}
{
  // Once a row exists the same one-field save is fine: that is the merge.
  const db = stubDB();
  ok_('the same one-field save works once a row exists', (await put({ taxRate: 7 }, db)).status === 200);
}

console.log('\n-- 9. Errors and methods --');
{
  const res = await put('not json');
  check('a malformed body -> 400', res.status, 400);
  const empty = await call('/api/settings', { DB: stubDB() }, 'PUT');
  check('no body at all -> 400', empty.status, 400);
  const arr = await put([1, 2]);
  check('an array body -> 400', arr.status, 400);
}
{
  const res = await call('/api/settings', {}, 'PUT', { taxRate: 5 });
  check('no binding -> 503', res.status, 503);
  check('   ...code', (await bodyOf(res)).error.code, 'no_database');
}
{
  const db = stubDB({ throwOnWrite: 'D1_ERROR: CHECK constraint failed: tax_rate BETWEEN 0 AND 100: SQLITE_CONSTRAINT' });
  const res = await put({ taxRate: 5 }, db);
  check('a constraint the route did not catch -> 422', res.status, 422);
  ok_('   ...with no SQL leaked', !JSON.stringify(await bodyOf(res)).includes('SQLITE'));
}
{
  const db = stubDB({ throwOnWrite: 'kaboom' });
  const res = await put({ taxRate: 5 }, db);
  check('anything else -> 500 without detail', res.status, 500);
  ok_('   ...and says nothing about the error',
    !JSON.stringify(await bodyOf(res)).includes('kaboom'));
}
for (const m of ['POST', 'PATCH', 'DELETE']) {
  const res = await call('/api/settings', { DB: stubDB() }, m, { taxRate: 5 });
  check(`${m} -> 405`, res.status, 405);
  check('   ...Allow names GET and PUT', res.headers.get('allow'), 'GET, PUT');
}
for (const path of ['/api/settings/1', '/api/settings/', '/api/settings/anything']) {
  const res = await call(path, { DB: stubDB() }, 'PUT', { taxRate: 5 });
  check(`PUT ${path} -> 404, a singleton has nothing to address`, res.status, 404);
}

console.log('\n-- 10. Unknown fields, and what is never touched --');
{
  // The API's policy from C-2 onward: SERVER-OWNED fields are refused by
  // name; a key the route simply does not know is ignored, never written.
  const db = stubDB();
  const res = await put({ taxRate: 8, somethingElse: 'x', invoicePrefix: 'INV' }, db);
  ok_('an unknown key is ignored, not written', res.status === 200, `got ${res.status}`);
  check('   ...so only the known field is written', writtenColumns(db), ['tax_rate', 'updated_at']);
}
{
  const db = stubDB();
  await put({ taxRate: 8 }, db);
  ok_('no other table is named anywhere',
    !/\b(customers|vehicles|job_cards|invoices|payments|parts|appointments|expenses|inventory_transactions)\b/
      .test(db.sql), db.sql);
  ok_('   ...and no theme column is written', !/theme/i.test(db.sql), db.sql);
  check('   ...the whole write is two statements: one read, one upsert', db.calls.length, 2);
}
{
  const raw = readFileSync(join(ROOT, 'src/routes/settings.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok_('the module never touches localStorage', !/localStorage/.test(code));
  ok_('   ...and never imports the frontend settings engine', !/Utils|DEFAULT_SETTINGS/.test(code));
  ok_('   ...nor hard-codes the browser\'s default business name',
    !/Taqwa Automobile Service Center/.test(code), 'browser default found in code');
}

console.log('\n-- 11. Repeated saves --');
{
  const db = stubDB();
  const first = await put({ taxRate: 9 }, db);
  const second = await put({ taxRate: 9 }, db);
  ok_('saving the same value twice is fine',
    first.status === 200 && second.status === 200, { first: first.status, second: second.status });
  check('   ...and each is its own statement',
    db.calls.filter((c) => /^\s*(INSERT|UPDATE)/.test(c.sql)).length, 2);
}

console.log(`\nSettings write unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
