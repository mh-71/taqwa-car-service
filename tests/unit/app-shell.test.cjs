/* app-shell — what the shell says about where the data actually is.

   The behaviour under test is the one that has no visible symptom when it
   goes wrong: with no Worker answering, Storage falls back to this browser
   and the app keeps working perfectly, while everything the user types stops
   reaching the shared database. That is correct offline and dangerous when
   unintended, so the shell has to say which of the two is happening.

   Drives the REAL js/app.js through the harness. */
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

/* app.js needs a little more DOM than the read-only suites: it builds the
   shell with innerHTML and queries inside it. The harness element is enough
   to capture what was written, which is what the assertions read. */
function shell(opts = {}) {
  const h = boot({ modules: ['js/app.js'], ...opts });
  const toasts = [];
  // Utils.toast writes into a host the fake DOM discards, so the call is
  // captured at the boundary instead -- app.js calls Utils.toast by name.
  h.ctx.Utils.toast = (message, type) => { toasts.push({ message, type }); };
  h.toasts = toasts;
  return h;
}

/* The shell is assembled as one innerHTML string on a created element; the
   harness's createElement returns a capturing stub, so read it back. */
function shellHtml(ctx) {
  return ctx.document.body._lastShellHtml || '';
}

console.log('=== app-shell: saying where the data is ===\n');

(async () => {

/* ============================================================
   1. Nothing to reach -> quiet
   ============================================================ */
console.log('-- 1. no backend was ever addressable --');
{
  const h = shell({ origin: '' });          // a page opened from disk
  h.fireReady();
  await new Promise(r => setTimeout(r, 10));
  check('the app is on browser storage', h.ctx.Storage.mode, 'local');
  check('   ...and nobody is interrupted about it', h.toasts.length, 0);
}

/* ============================================================
   2. A backend that was there to reach, and was not
   ============================================================ */
console.log('\n-- 2. the backend was expected and did not answer --');
{
  const h = shell({ origin: 'http://localhost:8787',
                    fetch: async () => { throw new Error('connection refused'); } });
  h.fireReady();
  await new Promise(r => setTimeout(r, 30));
  check('the app still works, on browser storage', h.ctx.Storage.mode, 'local');
  check('   ...and the user IS told', h.toasts.length, 1);
  const t = h.toasts[0] || {};
  ok('   ...that the server did not answer', /did not answer/i.test(t.message || ''), t.message);
  ok('   ...and that what they type will not reach the database',
    /not reach the shared database/i.test(t.message || ''), t.message);
  check('   ...as a warning, not an error', t.type, 'warning');
  ok('   ...naming no URL, port or internal detail',
    !/(localhost|8787|http|Error|undefined)/.test(t.message || ''), t.message);
}
{
  const h = shell({ origin: 'http://localhost:8787',
                    fetch: fakeApi({ health: false }) });   // Worker up, database not
  h.fireReady();
  await new Promise(r => setTimeout(r, 30));
  check('an unhealthy Worker is the same story', h.ctx.Storage.mode, 'local');
  check('   ...and is also surfaced', h.toasts.length, 1);
}
{
  // Hydration got past the probe and then failed part-way: the app must not
  // show a half-filled cache, and must say the same thing.
  let n = 0;
  const inner = fakeApi({ rows: { customers: [{ id: 'CUS-0001' }] } });
  const flaky = async (url, init) => {
    if (/\/invoices/.test(String(url))) throw new Error('down');
    return inner(url, init);
  };
  const h = shell({ origin: 'http://localhost:8787', fetch: flaky });
  h.fireReady();
  await new Promise(r => setTimeout(r, 40));
  check('a partial hydration falls back rather than showing half a database',
    h.ctx.Storage.mode, 'local');
  check('   ...and is surfaced too', h.toasts.length, 1);
  check('   ...with no rows from the partial read left behind',
    h.ctx.Storage.getData('customers').length, 5);   // the local seed, not the API's 1
}

/* ============================================================
   3. A backend that answered
   ============================================================ */
console.log('\n-- 3. connected --');
{
  const h = shell({ origin: 'http://localhost:8787',
                    fetch: fakeApi({ rows: { customers: [{ id: 'CUS-0001', name: 'Rahim' }] } }) });
  h.fireReady();
  await new Promise(r => setTimeout(r, 40));
  check('the app is on the database', h.ctx.Storage.mode, 'api');
  check('   ...and says nothing, because nothing is wrong', h.toasts.length, 0);
  check('   ...and the rows are the database\'s',
    h.ctx.Storage.getData('customers').map(c => c.name), ['Rahim']);
  ok('   ...and it did NOT seed demo data over them',
    h.ctx.localStorage.getItem('taqwa_seeded') === null, '');
}

/* ============================================================
   4. The footer text itself
   ============================================================ */
console.log('\n-- 4. what the footer renders --');
{
  const h = shell({ origin: '' });
  h.fireReady();
  await new Promise(r => setTimeout(r, 10));
  const html = shellHtml(h.ctx);
  ok('offline, the footer names the browser as the source',
    /This browser only/.test(html), html.slice(0, 200));
  ok('   ...and marks the dot as local rather than healthy',
    /sidebar__foot-dot--local/.test(html), 'modifier missing');
  ok('   ...and no longer claims a fixed "Workshop open"',
    !/Workshop open/.test(html), 'the old static string is still there');
}
{
  const h = shell({ origin: 'http://localhost:8787', fetch: fakeApi({ rows: {} }) });
  h.fireReady();
  await new Promise(r => setTimeout(r, 40));
  const html = shellHtml(h.ctx);
  ok('connected, the footer says so', /Connected to the database/.test(html), html.slice(0, 200));
  ok('   ...with the healthy dot', !/sidebar__foot-dot--local/.test(html), 'local modifier leaked');
}

/* ============================================================
   5. Locked — the Worker is up, this browser is not signed in
   ============================================================ */
console.log('\n-- 5. signed out --');
{
  const h = shell({ origin: 'http://localhost:8787',
                    fetch: fakeApi({ authenticated: false,
                                     rows: { customers: [{ id: 'CUS-0001', name: 'Rahim' }] } }) });
  h.fireReady();
  await new Promise(r => setTimeout(r, 40));
  check('the app is LOCKED, not offline', h.ctx.Storage.mode, 'locked');
  ok('   ...which is the point: it did not quietly fall back to this browser',
    h.ctx.Storage.mode !== 'local', h.ctx.Storage.mode);
  check('   ...and read nothing', h.ctx.Storage.getData('customers'), []);
  ok('   ...and seeded nothing over the top',
    h.ctx.localStorage.getItem('taqwa_seeded') === null && h.ctx.localStorage.getItem('taqwa_customers') === null,
    'the browser store was written');
  check('   ...and did not warn about being offline, because it is not',
    h.toasts.length, 0);
}
{
  // A browser that HAS been used offline before must not have that old data
  // shown to it once a server exists but it has not signed in.
  const h = shell({ origin: 'http://localhost:8787', fetch: fakeApi({ authenticated: false }) });
  h.ctx.localStorage.setItem('taqwa_customers', JSON.stringify([{ id: 'CUS-0009', name: 'Leftover' }]));
  h.ctx.localStorage.setItem('taqwa_seeded', 'true');
  h.fireReady();
  await new Promise(r => setTimeout(r, 40));
  check('a locked app shows nothing from the browser store', h.ctx.Storage.getData('customers'), []);
  check('   ...not even settings', h.ctx.Storage.getSettings().businessName,
    'Taqwa Automobile Service Center');
  ok('   ...and the leftover rows are still there, untouched, for offline use',
    h.ctx.localStorage.getItem('taqwa_customers').includes('Leftover'), 'data was destroyed');
}
{
  const h = shell({ origin: 'http://localhost:8787', fetch: fakeApi({ authenticated: false }) });
  h.fireReady();
  await new Promise(r => setTimeout(r, 40));
  for (const [name, call] of [
    ['create', () => h.ctx.Storage.create('customers', { name: 'X' })],
    ['update', () => h.ctx.Storage.update('customers', 'CUS-0001', { name: 'X' })],
    ['remove', () => h.ctx.Storage.remove('customers', 'CUS-0001')],
    ['putSettings', () => h.ctx.Storage.putSettings({ taxRate: 1 })],
    ['action', () => h.ctx.Storage.action('payments', 'PAY-0001', 'void')],
  ]) {
    const res = await call();
    check(`${name}() while locked is refused`, res.code, 'unauthorized');
  }
  for (const name of ['addData', 'updateData', 'deleteData']) {
    let threw = false;
    try {
      if (name === 'addData') h.ctx.Storage.addData('customers', { name: 'X' });
      if (name === 'updateData') h.ctx.Storage.updateData('customers', 'CUS-0001', {});
      if (name === 'deleteData') h.ctx.Storage.deleteData('customers', 'CUS-0001');
    } catch (e) { threw = true; }
    ok(`${name}() while locked refuses rather than writing to the browser`, threw, '');
  }
  ok('   ...and nothing reached localStorage',
    h.ctx.localStorage.getItem('taqwa_customers') === null, '');
}
{
  const f = fakeApi({ authenticated: false, rows: { customers: [{ id: 'CUS-0001', name: 'Rahim' }] } });
  const h = shell({ origin: 'http://localhost:8787', fetch: f });
  h.fireReady();
  await new Promise(r => setTimeout(r, 40));
  const bad = await h.ctx.Storage.signIn('wrong');
  ok('a wrong passphrase is refused', bad.ok === false, JSON.stringify(bad));
  check('   ...and the app stays locked', h.ctx.Storage.mode, 'locked');

  const good = await h.ctx.Storage.signIn('open sesame');
  ok('the right passphrase signs in', good.ok === true, JSON.stringify(good));
  check('   ...and the app is now reading the database', h.ctx.Storage.mode, 'api');
  check('   ...with the database\'s rows', h.ctx.Storage.getData('customers').map(c => c.name), ['Rahim']);

  await h.ctx.Storage.signOut();
  check('signing out locks it again', h.ctx.Storage.mode, 'locked');
  check('   ...and forgets what was read, so the next person cannot see it',
    h.ctx.Storage.getData('customers'), []);
}

process.exit(summary('App shell unit') === 0 ? 0 : 1);
})();
