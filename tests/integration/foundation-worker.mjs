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

      /* ---------- C2. the C-4 movement batch rolls back as a unit ---------- */
      // The inventory route's two statements are the first place in this API
      // where a half-applied write would corrupt a running balance rather than
      // just return badly. This runs the SAME shape the route builds and forces
      // the ledger INSERT to fail, then checks parts.stock did not move.
      {
        await q(`INSERT INTO parts (id, name, part_no, category, unit, purchase_price,
                   selling_price, stock, min_stock, status, created_at)
                 VALUES ('PRT-9801','Rollback Probe','RB-1','Filters','pc',10,20,10,0,'Active',?1)`,
          '2026-01-01T00:00:00Z').run();
        await q(`INSERT INTO inventory_transactions (id, part_id, type, quantity,
                   reference_type, prev_stock, new_stock, created_at)
                 VALUES ('STK-9801','PRT-9801','purchase',10,'manual',0,10,?1)`,
          '2026-01-01T00:00:00Z').run();

        const stockNow = async () => (await q(
          "SELECT stock FROM parts WHERE id = 'PRT-9801'").first()).stock;
        const ledgerCount = async () => (await q(
          "SELECT count(*) n FROM inventory_transactions WHERE part_id = 'PRT-9801'").first()).n;

        t('the probe part starts at 10', (await stockNow()) === 10, await stockNow());

        // A movement whose ledger INSERT violates the primary key. Everything
        // else about the batch is exactly what the route sends.
        let threw = null;
        try {
          await env.DB.batch([
            q(`INSERT INTO inventory_transactions
                 (id, part_id, type, quantity, unit_cost, reference_type, reference_id,
                  reason, notes, prev_stock, new_stock, created_at)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, stock, stock + ?10, ?11
                 FROM parts
                WHERE id = ?2 AND stock + ?10 >= 0`,
              'STK-9801', 'PRT-9801', 'sale', 4, null, 'manual', null,
              '', '', -4, '2026-01-02T00:00:00Z'),   // STK-9801 already exists
            q(`UPDATE parts SET stock = stock + ?2, updated_at = ?3
                WHERE id = ?1 AND stock + ?2 >= 0`,
              'PRT-9801', -4, '2026-01-02T00:00:00Z'),
          ]);
        } catch (e) { threw = String((e && e.message) || e); }

        t('a movement whose ledger INSERT fails throws', threw !== null, threw);
        t('   ...it is a UNIQUE violation', /UNIQUE constraint failed/.test(threw || ''), threw);
        t('   ...and parts.stock did NOT move', (await stockNow()) === 10, await stockNow());
        t('   ...and no extra ledger row survives', (await ledgerCount()) === 1, await ledgerCount());

        // The mirror case: the UPDATE is the statement that fails.
        let threw2 = null;
        try {
          await env.DB.batch([
            q(`INSERT INTO inventory_transactions
                 (id, part_id, type, quantity, reference_type, prev_stock, new_stock, created_at)
               SELECT ?1, ?2, 'sale', 4, 'manual', stock, stock - 4, ?3
                 FROM parts WHERE id = ?2`,
              'STK-9802', 'PRT-9801', '2026-01-03T00:00:00Z'),
            // CHECK (stock >= 0) refuses this outright rather than matching no rows.
            q("UPDATE parts SET stock = -99 WHERE id = ?1", 'PRT-9801'),
          ]);
        } catch (e) { threw2 = String((e && e.message) || e); }
        t('a movement whose stock UPDATE fails throws', threw2 !== null, threw2);
        t('   ...and the ledger row was rolled back', (await ledgerCount()) === 1, await ledgerCount());
        t('   ...and stock is still 10', (await stockNow()) === 10, await stockNow());

        // And the ordinary success path commits both halves together.
        const good = await env.DB.batch([
          q(`INSERT INTO inventory_transactions
               (id, part_id, type, quantity, reference_type, prev_stock, new_stock, created_at)
             SELECT ?1, ?2, 'sale', 4, 'manual', stock, stock + ?3, ?4
               FROM parts WHERE id = ?2 AND stock + ?3 >= 0`,
            'STK-9803', 'PRT-9801', -4, '2026-01-04T00:00:00Z'),
          q(`UPDATE parts SET stock = stock + ?2 WHERE id = ?1 AND stock + ?2 >= 0`,
            'PRT-9801', -4),
        ]);
        t('a valid movement reports one change per statement',
          good[0].meta.changes === 1 && good[1].meta.changes === 1,
          good.map((r) => r.meta.changes));
        t('   ...stock is now 6', (await stockNow()) === 6, await stockNow());
        const snap = await q("SELECT prev_stock, new_stock FROM inventory_transactions WHERE id = 'STK-9803'").first();
        t('   ...and the ledger snapshot matches the move',
          snap.prev_stock === 10 && snap.new_stock === 6, snap);

        // An outbound movement larger than stock matches nothing, both halves.
        const refused = await env.DB.batch([
          q(`INSERT INTO inventory_transactions
               (id, part_id, type, quantity, reference_type, prev_stock, new_stock, created_at)
             SELECT ?1, ?2, 'sale', 99, 'manual', stock, stock + ?3, ?4
               FROM parts WHERE id = ?2 AND stock + ?3 >= 0`,
            'STK-9804', 'PRT-9801', -99, '2026-01-05T00:00:00Z'),
          q(`UPDATE parts SET stock = stock + ?2 WHERE id = ?1 AND stock + ?2 >= 0`,
            'PRT-9801', -99),
        ]);
        t('an oversized outbound movement changes nothing, in either statement',
          refused[0].meta.changes === 0 && refused[1].meta.changes === 0,
          refused.map((r) => r.meta.changes));
        t('   ...so it commits without a partial write', (await stockNow()) === 6, await stockNow());
        t('   ...and writes no ledger row', (await ledgerCount()) === 2, await ledgerCount());
      }

      /* ---------- E. C-5 — a job card's batch is all or nothing ---------- */
      // A job card write moves the parent, both line tables, parts.stock and
      // the ledger in ONE batch. The route's own pre-check stops a shortage
      // before the batch is built, so the API can never be made to demonstrate
      // what happens when a statement AFTER a stock movement fails. That is
      // exactly what this entry exists for.
      {
        await q(`INSERT INTO customers (id, name, phone, status, created_at)
                 VALUES ('CUS-9801', 'C-5 Probe Customer', '01980000001', 'Active', ?1)`,
          '2026-01-01T00:00:00Z').run();
        await q(`INSERT INTO vehicles (id, customer_id, reg_no, brand, model, status, created_at)
                 VALUES ('VEH-9892', 'CUS-9801', 'C5-PROBE-1', 'Toyota', 'Probe', 'Active', ?1)`,
          '2026-01-01T00:00:00Z').run();
        await q(`INSERT INTO mechanics (id, name, phone, status, created_at)
                 VALUES ('MEC-9801', 'C-5 Probe Mechanic', '01980000002', 'Active', ?1)`,
          '2026-01-01T00:00:00Z').run();
        await q(`INSERT INTO parts (id, name, stock, status, created_at)
                 VALUES ('PRT-9802', 'C-5 Probe Part', 10, 'Active', ?1)`,
          '2026-01-01T00:00:00Z').run();
        await q(`INSERT INTO job_cards
                   (id, customer_id, vehicle_id, mechanic_id, date, status, priority,
                    complaint, created_at)
                 VALUES ('JOB-9801', 'CUS-9801', 'VEH-9892', 'MEC-9801', '2026-01-01',
                         'In Progress', 'normal', 'C-5 probe', ?1)`,
          '2026-01-01T00:00:00Z').run();

        const jobStock = async () => (await q(
          "SELECT stock FROM parts WHERE id = 'PRT-9802'").first()).stock;
        const jobLedger = async () => (await q(
          "SELECT count(*) n FROM inventory_transactions WHERE reference_id = 'JOB-9801'").first()).n;
        const jobLines = async () => (await q(
          "SELECT count(*) n FROM job_card_services WHERE job_card_id = 'JOB-9801'").first()).n;

        // The two statements a job card's stock movement is made of, in the
        // order the route sends them: the ledger row reads the live balance,
        // then the stock follows.
        const movement = (txnId, delta, plannedIssued) => [
          q(`INSERT INTO inventory_transactions
               (id, part_id, type, quantity, unit_cost, reference_type, reference_id,
                reason, notes, prev_stock, new_stock, created_at)
             SELECT ?1, 'PRT-9802', 'job-card-use',
                    CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type = 'job-card-use' THEN quantity
                                                        WHEN type = 'return'       THEN -quantity
                                                        ELSE 0 END), 0)
                                 FROM inventory_transactions
                                WHERE reference_type = 'job-card'
                                  AND reference_id   = 'JOB-9801'
                                  AND part_id        = 'PRT-9802') = ?3
                         THEN ?2 END,
                    NULL, 'job-card', 'JOB-9801', '', 'probe',
                    (SELECT stock FROM parts WHERE id = 'PRT-9802'),
                    (SELECT stock FROM parts WHERE id = 'PRT-9802') - ?2,
                    ?4`,
            txnId, delta, plannedIssued, '2026-01-06T00:00:00Z'),
          q("UPDATE parts SET stock = stock - ?1 WHERE id = 'PRT-9802'", delta),
        ];
        const line = (serviceId) => q(
          `INSERT INTO job_card_services (job_card_id, service_id, name, qty, unit_price, total, line_no)
           VALUES ('JOB-9801', ?1, 'Probe line', 1, 100, 100, 1)`, serviceId);

        t('the probe job card starts with stock 10', (await jobStock()) === 10, await jobStock());

        // E1 — a child line that fails AFTER the stock has already moved.
        let threw3 = null;
        try {
          await env.DB.batch([...movement('STK-9811', 3, 0), line('SRV-0000')]);
        } catch (err) { threw3 = String(err.message || err); }
        t('a job card batch whose child line violates a foreign key throws',
          threw3 !== null && /FOREIGN KEY/i.test(threw3), threw3);
        t('   ...and the stock movement that ran BEFORE it rolled back',
          (await jobStock()) === 10, await jobStock());
        t('   ...and so did its ledger row', (await jobLedger()) === 0, await jobLedger());
        t('   ...and no line was written', (await jobLines()) === 0, await jobLines());

        // E2 — the same batch, with a real service, commits every part of it.
        await ins('SRV-9811', 'Probe Service', 100).run();
        await env.DB.batch([...movement('STK-9812', 3, 0), line('SRV-9811')]);
        t('the same batch with a valid line commits', (await jobStock()) === 7, await jobStock());
        t('   ...writing exactly one ledger row', (await jobLedger()) === 1, await jobLedger());
        t('   ...and one child line', (await jobLines()) === 1, await jobLines());
        const snap2 = await q("SELECT prev_stock, new_stock, quantity FROM inventory_transactions WHERE id = 'STK-9812'").first();
        t('   ...whose snapshot is prev 10 -> new 7 for a quantity of 3',
          snap2.prev_stock === 10 && snap2.new_stock === 7 && snap2.quantity === 3, snap2);

        // E3 — the reconciliation guard: a plan made against a stale issued
        // balance produces a NULL quantity, which the column's NOT NULL turns
        // into a rolled-back batch. This is what stops a concurrent edit from
        // deducting the same units twice.
        let threw4 = null;
        try {
          // 3 units are now issued, so a plan that still believes 0 are is stale.
          await env.DB.batch(movement('STK-9813', 2, 0));
        } catch (err) { threw4 = String(err.message || err); }
        t('a movement planned against a stale issued balance throws',
          threw4 !== null && /NOT NULL/i.test(threw4) && /quantity/i.test(threw4), threw4);
        t('   ...so the stock never moved twice', (await jobStock()) === 7, await jobStock());
        t('   ...and no second ledger row exists', (await jobLedger()) === 1, await jobLedger());

        // E4 — and a plan made against the CURRENT balance goes through.
        await env.DB.batch(movement('STK-9814', 2, 3));
        t('a movement planned against the current balance applies',
          (await jobStock()) === 5, await jobStock());
        t('   ...and the ledger now holds both movements', (await jobLedger()) === 2, await jobLedger());
        const issued = await q(
          `SELECT COALESCE(SUM(CASE WHEN type = 'job-card-use' THEN quantity
                                    WHEN type = 'return'       THEN -quantity
                                    ELSE 0 END), 0) AS n
             FROM inventory_transactions
            WHERE reference_type = 'job-card' AND reference_id = 'JOB-9801'`).first();
        t('   ...totalling 5 issued for this job card', issued.n === 5, issued);
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
      // Foreign-key order: the child lines and the job card go before the
      // customer, vehicle, mechanic and service they point at.
      await env.DB.prepare("DELETE FROM job_card_services WHERE job_card_id LIKE 'JOB-98%'").run();
      await env.DB.prepare("DELETE FROM job_card_parts WHERE job_card_id LIKE 'JOB-98%'").run();
      await env.DB.prepare("DELETE FROM job_cards WHERE id LIKE 'JOB-98%'").run();
      await env.DB.prepare("DELETE FROM services WHERE id LIKE 'SRV-98%'").run();
      await env.DB.prepare("DELETE FROM vehicles WHERE id LIKE 'VEH-989%'").run();
      await env.DB.prepare("DELETE FROM customers WHERE id LIKE 'CUS-98%'").run();
      await env.DB.prepare("DELETE FROM mechanics WHERE id LIKE 'MEC-98%'").run();
      // The ledger rows hold an ON DELETE RESTRICT reference to the part, so
      // they go first.
      await env.DB.prepare("DELETE FROM inventory_transactions WHERE id LIKE 'STK-98%'").run();
      await env.DB.prepare("DELETE FROM parts WHERE id LIKE 'PRT-98%'").run();
      await q('UPDATE id_counters SET last_value = ?1 WHERE collection = ?2',
        before.counter, 'services').run();
    }

    const left = await nProbe();
    t('every probe row was removed', left === 0, left);
    t('   ...including the inventory probe rows',
      (await q("SELECT count(*) n FROM parts WHERE id LIKE 'PRT-98%'").first()).n === 0
      && (await q("SELECT count(*) n FROM inventory_transactions WHERE id LIKE 'STK-98%'").first()).n === 0);
    t('   ...and the job card probe rows',
      (await q("SELECT count(*) n FROM job_cards WHERE id LIKE 'JOB-98%'").first()).n === 0
      && (await q("SELECT count(*) n FROM job_card_services WHERE job_card_id LIKE 'JOB-98%'").first()).n === 0
      && (await q("SELECT count(*) n FROM customers WHERE id LIKE 'CUS-98%'").first()).n === 0
      && (await q("SELECT count(*) n FROM mechanics WHERE id LIKE 'MEC-98%'").first()).n === 0);
    t('the services counter was restored',
      (await counter('services')) === before.counter, await counter('services'));

    return new Response(JSON.stringify({ pass, fail, lines }, null, 2), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
