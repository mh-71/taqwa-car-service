/* src/lib/write.js + the two new http.js helpers — unit tests.

   C-1 ships no route, so there is nothing to call over HTTP here: these test
   the helpers directly, plus allocateId() against a stubbed D1 that records
   the SQL it would send. The behaviour that needs a real database -- batch
   rollback, counter sequencing under a failed write -- is proved in the
   integration suite instead, where an actual D1 can refuse a statement.

   Two things get disproportionate weight because getting them wrong is how
   this project has been bitten before:

     - zero and '' must survive every validator, because tax_rate 0, price 0
       and an empty currency are all real values in this schema;
     - todayInDhaka() must not agree with toISOString().slice(0, 10) during
       the Dhaka small hours. That disagreement IS audit Finding 2, and a
       test that only checks "returns a YYYY-MM-DD string" would pass on the
       bug. */
import {
  readJsonBody, readOptionalBody, readString, readNumber, readEnum, readDate,
  nowIso, todayInDhaka, allocateId, constraintFailure,
} from '../../src/lib/write.js';
import {
  ok, fail, conflict, unprocessable, methodNotAllowed, noDatabase,
  readRecordId, readIntParam,
} from '../../src/lib/http.js';

let pass = 0, fail_ = 0;
const check = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  good ? pass++ : fail_++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}`);
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail_++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

const req = (body, { raw = null } = {}) =>
  new Request('http://worker.local/api/x', {
    method: 'POST',
    body: raw !== null ? raw : JSON.stringify(body),
  });

console.log('\n-- 1. readJsonBody --');
{
  check('a JSON object parses', (await readJsonBody(req({ a: 1 }))).value, { a: 1 });
  check('an empty object parses', (await readJsonBody(req({}))).value, {});
  check('nested structures survive',
    (await readJsonBody(req({ a: { b: [1, 2] } }))).value, { a: { b: [1, 2] } });

  const cases = [
    ['an empty body', '', 'A JSON object body is required.'],
    ['malformed JSON', '{not json', 'Request body is not valid JSON.'],
    ['a truncated object', '{"a":', 'Request body is not valid JSON.'],
    ['JSON null', 'null', 'Request body must be a JSON object.'],
    ['a JSON array', '[1,2,3]', 'Request body must be a JSON object.'],
    ['a JSON string', '"hello"', 'Request body must be a JSON object.'],
    ['a JSON number', '42', 'Request body must be a JSON object.'],
    ['a JSON boolean', 'true', 'Request body must be a JSON object.'],
  ];
  for (const [label, raw, expected] of cases) {
    const r = await readJsonBody(req(null, { raw }));
    check(`${label} -> error`, r.error, expected);
    ok_(`${label} yields no value`, !('value' in r));
  }

  const big = await readJsonBody(req(null, { raw: '{"a":"' + 'x'.repeat(1024 * 1024 + 10) + '"}' }));
  check('an oversized body is refused', big.error, 'Request body is too large.');
}

console.log('\n-- 2. readString --');
{
  check('a plain string', readString({ a: 'hi' }, 'a'), { value: 'hi' });
  check('is trimmed', readString({ a: '  hi  ' }, 'a'), { value: 'hi' });
  check('absent and optional -> \'\'', readString({}, 'a'), { value: '' });
  check('null and optional -> \'\'', readString({ a: null }, 'a'), { value: '' });
  check('a custom fallback is honoured', readString({}, 'a', { fallback: 'Cash' }), { value: 'Cash' });
  check('an empty string stays \'\' when optional', readString({ a: '' }, 'a'), { value: '' });
  check('whitespace-only collapses to \'\' when optional', readString({ a: '   ' }, 'a'), { value: '' });

  ok_('absent and required -> error', !!readString({}, 'a', { required: true }).error);
  check('blank and required -> error', readString({ a: '   ' }, 'a', { required: true }).error,
    '`a` cannot be blank.');
  check('a number is not a string', readString({ a: 5 }, 'a').error, '`a` must be a string.');
  check('an array is not a string', readString({ a: [] }, 'a').error, '`a` must be a string.');
  check('over max -> error', readString({ a: 'xxxxxx' }, 'a', { max: 5 }).error,
    '`a` must be 5 characters or fewer.');
  check('exactly max is fine', readString({ a: 'xxxxx' }, 'a', { max: 5 }), { value: 'xxxxx' });
  // Length is measured after trimming, as the app stores it.
  check('trailing space does not count toward max',
    readString({ a: 'xxxxx  ' }, 'a', { max: 5 }), { value: 'xxxxx' });
}

console.log('\n-- 3. readNumber --');
{
  check('a number', readNumber({ a: 12 }, 'a'), { value: 12 });
  check('ZERO is a value, not missing', readNumber({ a: 0 }, 'a'), { value: 0 });
  check('zero passes a required check', readNumber({ a: 0 }, 'a', { required: true }), { value: 0 });
  check('zero passes min: 0', readNumber({ a: 0 }, 'a', { min: 0 }), { value: 0 });
  check('a negative number', readNumber({ a: -3 }, 'a'), { value: -3 });
  check('a decimal', readNumber({ a: 612.5 }, 'a'), { value: 612.5 });
  check('a numeric string is coerced', readNumber({ a: '42' }, 'a'), { value: 42 });
  check('a decimal string is coerced', readNumber({ a: '1.5' }, 'a'), { value: 1.5 });

  check('absent -> null, NOT 0', readNumber({}, 'a'), { value: null });
  check('null -> null', readNumber({ a: null }, 'a'), { value: null });
  check('an empty string -> null (a cleared form field)', readNumber({ a: '' }, 'a'), { value: null });
  check('a custom fallback', readNumber({}, 'a', { fallback: 0 }), { value: 0 });
  ok_('absent and required -> error', !!readNumber({}, 'a', { required: true }).error);

  check('below min -> error', readNumber({ a: -1 }, 'a', { min: 0 }).error, '`a` must be at least 0.');
  check('above max -> error', readNumber({ a: 101 }, 'a', { max: 100 }).error, '`a` must be at most 100.');
  check('at min is fine', readNumber({ a: 0 }, 'a', { min: 0, max: 100 }), { value: 0 });
  check('at max is fine', readNumber({ a: 100 }, 'a', { min: 0, max: 100 }), { value: 100 });
  check('a fraction fails integer', readNumber({ a: 1.5 }, 'a', { integer: true }).error,
    '`a` must be a whole number.');
  check('an integer passes integer', readNumber({ a: 60 }, 'a', { integer: true }), { value: 60 });

  for (const bad of ['abc', '12abc', {}, [], true, NaN, Infinity, '1e999']) {
    ok_(`${JSON.stringify(bad) ?? String(bad)} is rejected`,
      !!readNumber({ a: bad }, 'a').error, JSON.stringify(readNumber({ a: bad }, 'a')));
  }
}

console.log('\n-- 4. readEnum --');
{
  const STATUS = ['Active', 'Inactive'];
  check('an allowed value', readEnum({ a: 'Active' }, 'a', STATUS), { value: 'Active' });
  check('the other allowed value', readEnum({ a: 'Inactive' }, 'a', STATUS), { value: 'Inactive' });
  check('absent -> null', readEnum({}, 'a', STATUS), { value: null });
  check('a fallback', readEnum({}, 'a', STATUS, { fallback: 'Active' }), { value: 'Active' });
  ok_('absent and required -> error', !!readEnum({}, 'a', STATUS, { required: true }).error);

  // Case-sensitive on purpose: the schema's CHECKs are case-sensitive, so a
  // loose match here would only move the failure to the database.
  ok_('wrong case is rejected', !!readEnum({ a: 'active' }, 'a', STATUS).error);
  ok_('an unknown value is rejected', !!readEnum({ a: 'Deleted' }, 'a', STATUS).error);
  ok_('a number is rejected', !!readEnum({ a: 1 }, 'a', STATUS).error);
  ok_('the message lists what is allowed',
    readEnum({ a: 'x' }, 'a', STATUS).error.includes('Active, Inactive'));

  // A realistic set from the schema.
  const METHODS = ['Cash', 'Card', 'Bank Transfer', 'Mobile Banking', 'Cheque'];
  check('a value containing a space', readEnum({ m: 'Bank Transfer' }, 'm', METHODS), { value: 'Bank Transfer' });
}

console.log('\n-- 5. readDate --');
{
  check('a valid date', readDate({ d: '2026-09-18' }, 'd'), { value: '2026-09-18' });
  check('is passed through verbatim', readDate({ d: '2026-01-01' }, 'd'), { value: '2026-01-01' });
  check('a leap day in a leap year', readDate({ d: '2024-02-29' }, 'd'), { value: '2024-02-29' });
  check('absent -> \'\'', readDate({}, 'd'), { value: '' });
  ok_('absent and required -> error', !!readDate({}, 'd', { required: true }).error);

  for (const bad of ['2026-2-1', '26-02-01', '2026/02/01', '01-02-2026', 'today', '2026-09-18T00:00:00Z', '']) {
    const r = readDate({ d: bad }, 'd', { required: true });
    ok_(`"${bad}" is rejected`, !!r.error, JSON.stringify(r));
  }
  check('an impossible day', readDate({ d: '2026-02-31' }, 'd').error, '`d` is not a real calendar date.');
  check('month 13', readDate({ d: '2026-13-01' }, 'd').error, '`d` is not a real calendar date.');
  check('day 00', readDate({ d: '2026-01-00' }, 'd').error, '`d` is not a real calendar date.');
  check('a non-leap 29 Feb', readDate({ d: '2025-02-29' }, 'd').error, '`d` is not a real calendar date.');

  // The value must never be routed through a local Date and back.
  const TZ = process.env.TZ;
  for (const zone of ['UTC', 'Asia/Dhaka', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    process.env.TZ = zone;
    check(`unchanged under TZ=${zone}`, readDate({ d: '2026-03-15' }, 'd'), { value: '2026-03-15' });
  }
  process.env.TZ = TZ;
}

console.log('\n-- 6. Timestamps --');
{
  const t = nowIso();
  ok_('nowIso is full ISO-8601 with Z', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t), t);
  ok_('nowIso matches what storage.js writes', t === new Date(t).toISOString(), t);
  ok_('nowIso is close to now', Math.abs(Date.now() - Date.parse(t)) < 5000, t);

  ok_('todayInDhaka is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(todayInDhaka()), todayInDhaka());

  // Audit Finding 2. Dhaka is UTC+6, so 18:00-23:59 UTC is already the NEXT
  // calendar day there -- exactly the midnight-to-06:00 local window where
  // toISOString().slice(0, 10) reports yesterday.
  const window = [
    ['2026-03-15T18:00:00Z', '2026-03-16', '2026-03-15'],  // 00:00 Dhaka
    ['2026-03-15T18:00:01Z', '2026-03-16', '2026-03-15'],
    ['2026-03-15T20:30:00Z', '2026-03-16', '2026-03-15'],  // 02:30 Dhaka
    ['2026-03-15T23:59:59Z', '2026-03-16', '2026-03-15'],  // 05:59 Dhaka
  ];
  for (const [utc, dhaka, naive] of window) {
    check(`${utc} -> ${dhaka} in Dhaka`, todayInDhaka(new Date(utc)), dhaka);
    ok_(`${utc}: the naive toISOString slice would say ${naive} — the Finding 2 bug`,
      new Date(utc).toISOString().slice(0, 10) === naive
        && todayInDhaka(new Date(utc)) !== naive);
  }

  // Outside that window the two agree, which is why the bug hid.
  for (const [utc, expected] of [
    ['2026-03-15T17:59:59Z', '2026-03-15'],  // 23:59 Dhaka, same day
    ['2026-03-16T00:00:00Z', '2026-03-16'],  // 06:00 Dhaka
    ['2026-03-16T09:00:00Z', '2026-03-16'],
  ]) {
    check(`${utc} -> ${expected}`, todayInDhaka(new Date(utc)), expected);
    ok_(`${utc}: naive slice happens to agree here`,
      new Date(utc).toISOString().slice(0, 10) === expected);
  }

  // Year and month boundaries in the same window.
  check('new year rolls at 18:00Z on 31 Dec', todayInDhaka(new Date('2025-12-31T18:00:00Z')), '2026-01-01');
  check('month rolls at 18:00Z on the last day', todayInDhaka(new Date('2026-01-31T18:00:00Z')), '2026-02-01');

  // Independent of the process timezone, unlike Utils.todayStr().
  const TZ = process.env.TZ;
  const at = new Date('2026-03-15T20:30:00Z');
  for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    process.env.TZ = zone;
    check(`ignores TZ=${zone}`, todayInDhaka(at), '2026-03-16');
  }
  process.env.TZ = TZ;
}

console.log('\n-- 7. allocateId --');
{
  function stubCounters(row, { calls = [] } = {}) {
    return {
      calls,
      prepare(sql) {
        const entry = { sql, binds: null };
        calls.push(entry);
        const stmt = {
          bind(...args) { entry.binds = args; return stmt; },
          async first() { return row; },
        };
        return stmt;
      },
    };
  }

  const calls = [];
  const env = { DB: stubCounters({ last_value: 1, prefix: 'CUS' }, { calls }) };
  const r = await allocateId(env, 'customers');
  check('formats the id', r.id, 'CUS-0001');
  check('returns the raw value', r.value, 1);
  check('returns the prefix', r.prefix, 'CUS');
  check('binds the collection', calls[0].binds, ['customers']);
  check('issues exactly one statement', calls.length, 1);

  const sql = calls[0].sql;
  ok_('bumps and reads in ONE statement', /UPDATE\s+id_counters/i.test(sql) && /RETURNING/i.test(sql), sql);
  ok_('increments by one', /last_value\s*=\s*last_value\s*\+\s*1/i.test(sql), sql);
  ok_('is not a read-then-write pair', !/SELECT\s+last_value/i.test(sql), sql);
  ok_('the collection is bound, not interpolated', sql.includes('?1') && !sql.includes('customers'), sql);

  // Padding matches storage.js:97-100 across the whole range.
  for (const [value, prefix, expected] of [
    [1, 'CUS', 'CUS-0001'], [9, 'VEH', 'VEH-0009'], [10, 'APT', 'APT-0010'],
    [99, 'JOB', 'JOB-0099'], [100, 'SRV', 'SRV-0100'], [999, 'MEC', 'MEC-0999'],
    [1000, 'PRT', 'PRT-1000'], [9999, 'INV', 'INV-9999'],
    [10000, 'PAY', 'PAY-10000'], [123456, 'EXP', 'EXP-123456'],
  ]) {
    const got = await allocateId({ DB: stubCounters({ last_value: value, prefix }) }, 'x');
    check(`${prefix} @ ${value} -> ${expected}`, got.id, expected);
  }

  // Every prefix the app actually uses, taken from storage.js's own map.
  for (const [collection, prefix] of [
    ['customers', 'CUS'], ['vehicles', 'VEH'], ['appointments', 'APT'],
    ['jobCards', 'JOB'], ['services', 'SRV'], ['mechanics', 'MEC'],
    ['parts', 'PRT'], ['invoices', 'INV'], ['payments', 'PAY'],
    ['expenses', 'EXP'], ['inventoryTransactions', 'STK'],
  ]) {
    const got = await allocateId({ DB: stubCounters({ last_value: 7, prefix }) }, collection);
    check(`${collection} -> ${prefix}-0007`, got.id, `${prefix}-0007`);
    ok_(`${collection} id matches the API's own id shape`, /^[A-Za-z]{2,5}-\d{1,10}$/.test(got.id), got.id);
  }

  const missing = await allocateId({ DB: stubCounters(null) }, 'widgets');
  check('an unknown collection is an error, not an invented id', missing.error,
    'No id counter for collection `widgets`.');
  ok_('and yields no id', !('id' in missing));
}

console.log('\n-- 8. conflict() and unprocessable() --');
{
  const c = conflict('Still has vehicles.');
  const cb = await c.json();
  check('conflict is 409', c.status, 409);
  check('conflict code', cb.error.code, 'conflict');
  check('conflict message', cb.error.message, 'Still has vehicles.');
  check('conflict keeps the standard envelope', Object.keys(cb), ['error']);
  ok_('conflict is JSON', (c.headers.get('content-type') || '').includes('application/json'));

  const cx = await conflict('Nope.', { conflictsWith: 'VEH-0003' }).json();
  check('conflict carries machine-readable extra', cx.error.conflictsWith, 'VEH-0003');

  const u = unprocessable('Check the fields.');
  const ub = await u.json();
  check('unprocessable is 422', u.status, 422);
  check('unprocessable code', ub.error.code, 'unprocessable');
  ok_('no fields key when none given', !('fields' in ub.error));

  const uf = await unprocessable('Check the fields.', { taxRate: 'must be 0-100' }).json();
  check('fields are carried through', uf.error.fields, { taxRate: 'must be 0-100' });
}

console.log('\n-- 9. constraintFailure --');
{
  // The exact strings local D1 produced during the C-1 spike.
  const cases = [
    ['D1_ERROR: UNIQUE constraint failed: services.id: SQLITE_CONSTRAINT', 409, 'conflict'],
    ['D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT', 409, 'conflict'],
    ['D1_ERROR: CHECK constraint failed: price >= 0: SQLITE_CONSTRAINT', 422, 'unprocessable'],
    ['D1_ERROR: NOT NULL constraint failed: services.name: SQLITE_CONSTRAINT', 422, 'unprocessable'],
  ];
  for (const [message, status, code] of cases) {
    const res = constraintFailure(new Error(message));
    ok_(`${message.slice(10, 40)}... -> ${status}`, res && res.status === status,
      res ? `got ${res.status}` : 'got null');
    const body = await res.json();
    check(`   ...code is ${code}`, body.error.code, code);
    ok_('   ...no table or column name leaks',
      !JSON.stringify(body).includes('services.') && !JSON.stringify(body).includes('SQLITE'),
      JSON.stringify(body));
    ok_('   ...no raw driver text leaks', !JSON.stringify(body).includes('D1_ERROR'));
  }

  ok_('a non-constraint error returns null so the caller can 500',
    constraintFailure(new Error('D1_ERROR: no such column: foo')) === null);
  ok_('a network error returns null', constraintFailure(new Error('boom')) === null);
  ok_('undefined returns null', constraintFailure(undefined) === null);
  ok_('a string error is handled', constraintFailure('UNIQUE constraint failed: x.y') !== null);
}

console.log('\n-- 10. The existing http.js helpers are unchanged --');
{
  const o = ok([1, 2], { count: 2 });
  check('ok() still returns data + meta', await o.json(), { data: [1, 2], count: 2 });
  check('ok() is still 200', o.status, 200);

  const f = await fail('bad', 'Bad.', 400).json();
  check('fail() envelope unchanged', f, { error: { code: 'bad', message: 'Bad.' } });

  const m = methodNotAllowed(['GET']);
  check('methodNotAllowed still 405', m.status, 405);
  check('methodNotAllowed still sets Allow', m.headers.get('allow'), 'GET');

  check('noDatabase still 503', noDatabase().status, 503);
  check('readRecordId unchanged', readRecordId('CUS-0001'), { value: 'CUS-0001' });
  ok_('readRecordId still rejects a bare number', !!readRecordId('1').error);

  const url = new URL('http://x/?limit=5');
  check('readIntParam unchanged', readIntParam(url, 'limit', { def: 500, min: 1, max: 1000 }), { value: 5 });

  // The new helpers must not have changed the shared shape.
  const codes = [
    [conflict('x'), 409, 'conflict'],
    [unprocessable('x'), 422, 'unprocessable'],
  ];
  for (const [res, status, code] of codes) {
    const b = await res.json();
    ok_(`${code} matches the API-wide { error: { code, message } } shape`,
      res.status === status && typeof b.error.code === 'string' && typeof b.error.message === 'string');
  }
}

/* ---------- readOptionalBody: the body that may be absent ---------- */
// C-8 moved this here from the invoice route, because a second operation
// needed it: voiding an invoice and voiding a payment both take no fields at
// all. Requiring `{}` would only be a trap for a caller with nothing to send.
console.log('\n-- readOptionalBody --');
{
  const req = (body) => new Request('http://w.local/x', {
    method: 'POST',
    ...(body === undefined ? {} : { body }),
  });
  check('no body at all is an empty object', (await readOptionalBody(req())).value, {});
  check('an empty string is too', (await readOptionalBody(req(''))).value, {});
  check('and so is whitespace', (await readOptionalBody(req('   \n '))).value, {});
  check('an object comes back as itself', (await readOptionalBody(req('{"a":1}'))).value, { a: 1 });
  ok_('malformed JSON is still an error',
    !!(await readOptionalBody(req('{oops'))).error);
  for (const wrong of ['null', '[]', '"text"', '7', 'true']) {
    ok_(`${wrong} is not an object`, !!(await readOptionalBody(req(wrong))).error, wrong);
  }
  // The difference from readJsonBody is exactly one case: an absent body.
  ok_('readJsonBody still refuses an empty body', !!(await readJsonBody(req(''))).error);
  ok_('   ...where readOptionalBody accepts it', !(await readOptionalBody(req(''))).error);
}

console.log(`\nWrite foundation unit: ${pass} passed, ${fail_} failed`);
process.exit(fail_ ? 1 : 0);
