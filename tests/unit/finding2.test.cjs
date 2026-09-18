/* Finding 2 — local-calendar dates. Runs the REAL shipped utils.js /
   dashboard.js / appointments.js code under TZ=Asia/Dhaka. */
process.env.TZ = 'Asia/Dhaka';
const fs = require('fs'), vm = require('vm'), path = require('path');
// Repo root, derived from this file's location (tests/unit/ -> ../..).
const ROOT = path.resolve(__dirname, '..', '..');
const { boot, check, ok, summary } = require('../lib/harness.cjs');

console.log('=== Finding 2: local-calendar dates (TZ=Asia/Dhaka, UTC+6) ===\n');

// 1. todayStr() returns the browser's LOCAL calendar date at every hour.
{
  const { ctx } = boot({});
  const RealDate = Date;
  const at = (y, mo, d, h, mi) => {
    class Fixed extends RealDate {
      constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(y, mo, d, h, mi, 0); }
      static now() { return new RealDate(y, mo, d, h, mi, 0).getTime(); }
    }
    ctx.Date = Fixed;
    const r = ctx.Utils.todayStr();
    ctx.Date = RealDate;
    return r;
  };
  console.log('-- 1. todayStr() across the day (the hours the old UTC version got wrong) --');
  check('todayStr at 00:00 local', at(2026, 8, 17, 0, 0), '2026-09-17');
  check('todayStr at 02:00 local', at(2026, 8, 17, 2, 0), '2026-09-17');
  check('todayStr at 05:59 local', at(2026, 8, 17, 5, 59), '2026-09-17');
  check('todayStr at 06:00 local', at(2026, 8, 17, 6, 0), '2026-09-17');
  check('todayStr at 14:00 local', at(2026, 8, 17, 14, 0), '2026-09-17');
  check('todayStr at 23:59 local', at(2026, 8, 17, 23, 59), '2026-09-17');
  check('todayStr crosses at local midnight', at(2026, 8, 18, 0, 1), '2026-09-18');
  // and it must agree with the machine's own local date right now
  const d = new Date();
  const localNow = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  check('todayStr() === real local calendar date now', ctx.Utils.todayStr(), localNow);
  console.log(`        (machine local date: ${localNow}; UTC date: ${new Date().toISOString().slice(0,10)})`);
}

// 2 + 3. Dashboard: today's values and 7-day chart buckets, via the real module.
{
  console.log('\n-- 2/3. Dashboard today values + 7-day chart buckets (real dashboard.js) --');
  const { ctx, els, fireReady } = boot({ modules: ['js/dashboard.js'] });
  ctx.Storage.seedIfEmpty();
  const today = ctx.Utils.todayStr();

  // a payment made "today" in local terms must land in today's bucket
  ctx.Storage.addData('payments', { invoiceId: null, customerId: 'CUS-0001', jobCardId: null,
    date: today, amount: 777, method: 'Cash', notes: 'tz probe', status: 'Active' });
  fireReady();

  const stats = els.get('statsGrid').innerHTML;
  const expectTodayRevenue = ctx.Storage.getData('payments')
    .filter(p => p.status !== 'Void' && (p.date || '').slice(0, 10) === today)
    .reduce((s, p) => s + Number(p.amount), 0);
  ok(`Today's Revenue stat === sum of local-today payments (${expectTodayRevenue})`,
     stats.includes(ctx.Utils.money(expectTodayRevenue)),
     `stat grid did not contain ${ctx.Utils.money(expectTodayRevenue)}`);

  const chart = els.get('revChart').innerHTML;
  const labels = [...chart.matchAll(/aria-label="([^:]+):/g)].map(m => m[1]);
  check('chart renders 7 day columns', labels.length, 7);
  // last bucket must be local today; build the expected 7 local dates
  const expected = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i);
    expected.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`); }
  const todayLabel = new Date().toLocaleDateString('en-GB', { weekday: 'short' });
  check('last chart column is local today', labels[6], todayLabel);
  ok('today chart bucket === sum of local-today payments',
     /rev-col--today/.test(chart) && chart.split('rev-col--today')[1].includes(ctx.Utils.money(expectTodayRevenue)),
     `today column did not show ${ctx.Utils.money(expectTodayRevenue)}`);
  const summaryHtml = els.get('revSummary').innerHTML;
  ok("chart summary 'Today' figure is non-zero", /Today:.*[1-9]/.test(summaryHtml), summaryHtml);
  console.log(`        expected local bucket dates: ${expected[0]} .. ${expected[6]}`);
}

// 4 + 5. Appointments: default date and tomorrow helper, from the real source.
{
  console.log('\n-- 4/5. Appointments default date + tomorrow helper (real appointments.js) --');
  const { ctx } = boot({});
  const src = fs.readFileSync(path.join(ROOT, 'js/appointments.js'), 'utf8');

  // pull the shipped tomorrowStr definition out of the file and run THAT text
  const m = src.match(/const tomorrowStr = \(\) => \{[\s\S]*?\};/);
  ok('tomorrowStr found in appointments.js', !!m, 'regex did not match');
  const sandbox = { Utils: ctx.Utils, toDateStr: ctx.Utils.toDateStr, Date, String, Number, out: null };
  vm.createContext(sandbox);
  vm.runInContext(m[0] + '\nout = tomorrowStr();', sandbox);
  const d = new Date(); d.setDate(d.getDate() + 1);
  const expectTomorrow = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  check('tomorrowStr() === local calendar tomorrow', sandbox.out, expectTomorrow);
  ok('tomorrowStr no longer calls toISOString', !m[0].includes('toISOString'), m[0]);

  // the form default date uses todayStr, which is now local
  ok('appointment form default date binds to todayStr()',
     /id="af-date"[^>]*value="\$\{esc\(a\.date \|\| todayStr\(\)\)\}"/.test(src), 'form default not wired to todayStr');
  check('todayStr() used for that default is local', ctx.Utils.todayStr(),
     `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`);
}

// 6. Reports date ranges — execute the SHIPPED helper block from reports.js.
{
  console.log('\n-- 6. Reports date ranges (shipped reports.js helper block) --');
  const { ctx } = boot({});
  const src = fs.readFileSync(path.join(ROOT, 'js/reports.js'), 'utf8');
  const start = src.indexOf('function parseLocalDate');
  const end = src.indexOf('/** Inclusive range check');
  ok('reports.js date-helper block located', start > 0 && end > start, `start=${start} end=${end}`);
  const block = src.slice(start, end);
  const sandbox = { Utils: ctx.Utils, fmtDate: ctx.Utils.fmtDate, Date, String, Number, out: {} };
  vm.createContext(sandbox);
  vm.runInContext(block + `
    out.today     = getRange('today');
    out.yesterday = getRange('yesterday');
    out.week      = getRange('week');
    out.month     = getRange('month');
    out.lastmonth = getRange('lastmonth');
    out.custom    = getRange('custom', '2026-09-10', '2026-09-01');
  `, sandbox);
  const T = ctx.Utils.todayStr();
  const o = sandbox.out;
  check('range Today is local today..today', [o.today.from, o.today.to], [T, T]);
  const y = new Date(); y.setDate(y.getDate() - 1);
  const Y = `${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,'0')}-${String(y.getDate()).padStart(2,'0')}`;
  check('range Yesterday is local yesterday', [o.yesterday.from, o.yesterday.to], [Y, Y]);
  ok('range This Week ends today and starts on/before it', o.week.to === T && o.week.from <= T, JSON.stringify(o.week));
  ok('range This Month starts on the 1st of the local month',
     o.month.from === T.slice(0, 8) + '01' && o.month.to === T, JSON.stringify(o.month));
  ok('range Last Month is a full prior month before this one',
     o.lastmonth.to < o.month.from && o.lastmonth.from.endsWith('-01'), JSON.stringify(o.lastmonth));
  check('custom range swaps reversed dates', [o.custom.from, o.custom.to], ['2026-09-01', '2026-09-10']);
}

process.exit(summary('Finding 2') === 0 ? 0 : 1);
