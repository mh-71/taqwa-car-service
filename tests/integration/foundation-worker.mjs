/* TEST-ONLY Worker entry. Never registered in src/index.js, never deployed.
   ------------------------------------------------------------------------
   C-1's helpers include two behaviours that cannot be tested without a real
   database, because they are D1's behaviour rather than ours:

     * env.DB.batch() rolls back every statement when one fails -- which is
       the whole basis for the atomic invoice, payment and inventory
       operations in C-4 onward;
     * UPDATE ... RETURNING hands concurrent callers distinct numbers.

   Neither can be reached over the real API, because C-1 ships no write route.
   So run.sh starts this entry on a second port with the same D1 binding, and
   it runs the assertions inside workerd against the real local database,
   returning a JSON summary. The production Worker is untouched.

   It imports the REAL src/lib/write.js -- nothing is re-implemented here, so
   a change to allocateId() is felt directly.

   Every row it writes uses the reserved SRV-98xx / VEH-989x fixture range and
   is removed before it returns; id_counters is restored to its prior value.
   The range is deliberately different from api.test.mjs's 9xxx rows so the
   two suites can run against the same database at the same time. */
import { allocateId, constraintFailure, todayInDhaka, nowIso } from '../../src/lib/write.js';

export default {
  async fetch(request, env) {
    const lines = [];
    let pass = 0, fail = 0;
    const t = (name, cond, detail = '') => {
      if (cond) { pass++; lines.push('PASS  ' + name); }
      else { fail++; lines.push('FAIL  ' + name + (detail ? '  -> ' + JSON.stringify(detail) : '')); }
    };

    const q = (sql, ...b) => (b.length ? env.DB.prepare(sql).bind(...b) : env.DB.prepare(sql));
    const ins = (id, name, price = 0) => q(
      "INSERT INTO services (id, name, price, status, created_at) VALUES (?1, ?2, ?3, 'Active', ?4)",
      id, name, price, '2026-01-01T00:00:00Z');
    const nProbe = async () => (await env.DB.prepare(
      "SELECT count(*) n FROM services WHERE id LIKE 'SRV-98%'").first()).n;
    const counter = async (c) => (await q(
      'SELECT last_value FROM id_counters WHERE collection = ?1', c).first()).last_value;

    const before = { services: await nProbe(), counter: await counter('services') };

    try {
      /* ---------- A. batch rollback ---------- */
      {
        t('the probe range starts empty', before.services === 0, before.services);

        // A1 — a successful batch commits every statement.
        const okRes = await env.DB.batch([ins('SRV-9801', 'A'), ins('SRV-9802', 'B')]);
        t('a successful batch commits all statements', (await nProbe()) === 2, await nProbe());
        t('batch returns one result per statement', Array.isArray(okRes) && okRes.length === 2, okRes.length);
        t('each result reports success', okRes.every((r) => r.success === true));
        t('each result exposes meta.changes', okRes.every((r) => r.meta && r.meta.changes === 1),
          okRes.map((r) => r.meta && r.meta.changes));

        // A2 — PRIMARY KEY violation in the LAST statement rolls back the first two.
        let threw = null;
        try {
          await env.DB.batch([
            ins('SRV-9803', 'C'), ins('SRV-9804', 'D'), ins('SRV-9801', 'dup'),
          ]);
        } catch (e) { threw = String((e && e.message) || e); }
        t('a PK violation throws', threw !== null);
        t('   ...and the earlier statements rolled back', (await nProbe()) === 2, await nProbe());
        t('   ...SRV-9803 was not written',
          (await q("SELECT id FROM services WHERE id = 'SRV-9803'").first()) === null);
        t('   ...the error is a UNIQUE constraint', /UNIQUE constraint failed/.test(threw || ''), threw);
        t('   ...constraintFailure maps it to 409',
          (constraintFailure(new Error(threw)) || {}).status === 409);

        // A3 — CHECK violation rolls back too.
        let threwCheck = null;
        try {
          await env.DB.batch([ins('SRV-9805', 'E'), ins('SRV-9806', 'F', -5)]);
        } catch (e) { threwCheck = String((e && e.message) || e); }
        t('a CHECK violation throws', threwCheck !== null);
        t('   ...and rolls back', (await nProbe()) === 2, await nProbe());
        t('   ...the error is a CHECK constraint', /CHECK constraint failed/.test(threwCheck || ''), threwCheck);
        t('   ...constraintFailure maps it to 422',
          (constraintFailure(new Error(threwCheck)) || {}).status === 422);

        // A4 — FOREIGN KEY violation rolls back too.
        let threwFk = null;
        try {
          await env.DB.batch([
            ins('SRV-9807', 'G'),
            q("INSERT INTO vehicles (id, customer_id, reg_no, brand, model, status, created_at)"
              + " VALUES ('VEH-9890','CUS-NOPE','PROBE-1','X','Y','Active','2026-01-01T00:00:00Z')"),
          ]);
        } catch (e) { threwFk = String((e && e.message) || e); }
        t('an FK violation throws', threwFk !== null);
        t('   ...and rolls back', (await nProbe()) === 2, await nProbe());
        t('   ...the error is a FOREIGN KEY constraint', /FOREIGN KEY constraint failed/.test(threwFk || ''), threwFk);
        t('   ...constraintFailure maps it to 409',
          (constraintFailure(new Error(threwFk)) || {}).status === 409);
        t('   ...the FK row was not created',
          (await q("SELECT id FROM vehicles WHERE id = 'VEH-9890'").first()) === null);
      }

      /* ---------- B. id allocation ---------- */
      {
        const start = await counter('services');

        const a = await allocateId(env, 'services');
        const b = await allocateId(env, 'services');
        t('allocateId returns a formatted id', /^SRV-\d{4,}$/.test(a.id), a);
        t('ids are sequential', b.value === a.value + 1, [a.value, b.value]);
        t('the counter advanced by exactly 2', (await counter('services')) === start + 2, await counter('services'));

        // Every collection allocates from its own counter.
        const first = await allocateId(env, 'customers');
        const second = await allocateId(env, 'expenses');
        t('customers allocates a CUS id', first.id.startsWith('CUS-'), first);
        t('expenses allocates an EXP id', second.id.startsWith('EXP-'), second);
        t('one collection does not disturb another',
          (await counter('services')) === start + 2, await counter('services'));

        // An unknown collection is an error, never an invented id.
        const bad = await allocateId(env, 'widgets');
        t('an unknown collection errors', !!bad.error && !bad.id, bad);

        // Concurrency: the reason this is UPDATE ... RETURNING and not a
        // read-then-write pair.
        const beforeRace = await counter('services');
        const raced = await Promise.all(Array.from({ length: 12 }, () => allocateId(env, 'services')));
        const values = raced.map((r) => r.value).sort((x, y) => x - y);
        t('12 concurrent allocations all succeed', raced.every((r) => !!r.id));
        t('   ...every number is distinct', new Set(values).size === 12, values);
        t('   ...and they are contiguous', values.every((v, i) => v === beforeRace + 1 + i), values);
        t('   ...every id is distinct too', new Set(raced.map((r) => r.id)).size === 12);
        t('   ...each matches the API id shape',
          raced.every((r) => /^[A-Za-z]{2,5}-\d{1,10}$/.test(r.id)));

        // A failed batch rolls the counter back with everything else, so an
        // allocation made INSIDE the batch costs no number.
        const beforeRollback = await counter('services');
        let threw = null;
        try {
          await env.DB.batch([
            q("UPDATE id_counters SET last_value = last_value + 1 WHERE collection = 'services'"),
            ins('SRV-9801', 'dup again'),   // SRV-9801 exists, so this fails
          ]);
        } catch (e) { threw = String((e && e.message) || e); }
        t('a batch containing a counter bump can fail', threw !== null, threw);
        t('   ...and the counter rolled back with it',
          (await counter('services')) === beforeRollback, await counter('services'));

        // Restore the counters this section advanced.
        await q('UPDATE id_counters SET last_value = ?1 WHERE collection = ?2', start, 'services').run();
        await q('UPDATE id_counters SET last_value = last_value - 1 WHERE collection = ?1', 'customers').run();
        await q('UPDATE id_counters SET last_value = last_value - 1 WHERE collection = ?1', 'expenses').run();
      }

      /* ---------- C. the conditional-write guard C-4..C-8 will rely on ---------- */
      {
        await q("UPDATE services SET price = 10 WHERE id = 'SRV-9801'").run();
        const allowed = await q(
          "UPDATE services SET price = price - ?1 WHERE id = 'SRV-9801' AND price - ?1 >= 0", 4).run();
        const refused = await q(
          "UPDATE services SET price = price - ?1 WHERE id = 'SRV-9801' AND price - ?1 >= 0", 999).run();
        const finalPrice = (await q("SELECT price FROM services WHERE id = 'SRV-9801'").first()).price;
        t('a permitted conditional update applies', allowed.meta.changes === 1, allowed.meta.changes);
        t('a refused one changes nothing', refused.meta.changes === 0, refused.meta.changes);
        t('   ...and the value is untouched', finalPrice === 6, finalPrice);
        t('meta.changes is 0 for a row that does not exist',
          (await q("UPDATE services SET price = 1 WHERE id = 'SRV-NOPE'").run()).meta.changes === 0);
      }

      /* ---------- D. the helpers behave the same inside workerd ---------- */
      {
        t('todayInDhaka works in workerd',
          todayInDhaka(new Date('2026-03-15T20:30:00Z')) === '2026-03-16',
          todayInDhaka(new Date('2026-03-15T20:30:00Z')));
        t('   ...and disagrees with the naive UTC slice, as Finding 2 requires',
          todayInDhaka(new Date('2026-03-15T20:30:00Z'))
            !== new Date('2026-03-15T20:30:00Z').toISOString().slice(0, 10));
        t('nowIso is ISO-8601 UTC', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(nowIso()), nowIso());
      }
    } finally {
      /* ---------- cleanup, always ---------- */
      await env.DB.prepare("DELETE FROM services WHERE id LIKE 'SRV-98%'").run();
      await env.DB.prepare("DELETE FROM vehicles WHERE id LIKE 'VEH-989%'").run();
      await q('UPDATE id_counters SET last_value = ?1 WHERE collection = ?2',
        before.counter, 'services').run();
    }

    const left = await nProbe();
    t('every probe row was removed', left === 0, left);
    t('the services counter was restored',
      (await counter('services')) === before.counter, await counter('services'));

    return new Response(JSON.stringify({ pass, fail, lines }, null, 2), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
