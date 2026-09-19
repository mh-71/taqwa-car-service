/* storage-adapter — js/storage.js against a backend, and without one.

   Drives the REAL Storage over the REAL Api with fetch faked, so what is
   asserted is behaviour: which requests go out, what the cache ends up
   holding, and that a browser with no Worker behaves exactly as it did
   before this file learned about D1. */
const { boot, check, ok, summary } = require('../lib/harness.cjs');

const { fakeApi } = require('../lib/fake-api.cjs');

const online = (opts) => {
  const f = fakeApi(opts);
  const h = boot({ origin: 'http://localhost:8787', fetch: f });
  return { ...h, f };
};

console.log('=== storage-adapter: js/storage.js ===\n');

(async () => {

/* ============================================================
   1. Choosing a source
   ============================================================ */
console.log('-- 1. mode selection --');
{
  const { ctx } = boot({ origin: '' });                 // opened from disk
  const r = await ctx.Storage.hydrate();
  check('no API reachable -> local mode', r.mode, 'local');
  check('   ...and Storage agrees', ctx.Storage.mode, 'local');
}
{
  const { ctx } = online({ health: false });
  const r = await ctx.Storage.hydrate();
  check('a Worker that answers unhealthily -> local mode', r.mode, 'local');
}
{
  const { ctx } = boot({ origin: 'http://localhost:8787', fetch: async () => { throw new Error('down'); } });
  const r = await ctx.Storage.hydrate();
  check('a Worker that is not running -> local mode', r.mode, 'local');
}
{
  const { ctx } = online({ rows: { customers: [{ id: 'CUS-0001', name: 'Rahim' }] } });
  const r = await ctx.Storage.hydrate();
  check('a live Worker -> api mode', r.mode, 'api');
  check('   ...and Storage agrees', ctx.Storage.mode, 'api');
  ok('   ...and isApi() is true', ctx.Storage.isApi() === true);
}
{
  const { ctx } = online({});
  const r = await ctx.Storage.hydrate();
  check('an EMPTY database is still api mode, not a reason to fall back', r.mode, 'api');
  check('   ...and reads come back empty rather than undefined',
    ctx.Storage.getData('customers'), []);
}
{
  // A partial hydration is worse than none: it would render records that
  // exist and hide records that do not.
  const { ctx } = online({ fail: ({ path }) => path.startsWith('/invoices')
    ? { status: 500, error: { code: 'server_error', message: 'boom' } } : null });
  const r = await ctx.Storage.hydrate();
  check('one collection failing keeps the whole app in local mode', r.mode, 'local');
  check('   ...and says which one', r.collection, 'invoices');
}
{
  const { ctx, f } = online({ rows: { customers: [{ id: 'CUS-0001' }] } });
  await ctx.Storage.hydrate();
  await ctx.Storage.hydrate();
  const healthCalls = f.calls.filter(c => c.path === '/health').length;
  check('hydrate() is idempotent -- the backend is probed once', healthCalls, 1);
}

/* ============================================================
   2. Reads stay synchronous
   ============================================================ */
console.log('\n-- 2. reads --');
{
  const { ctx, f } = online({ rows: {
    customers: [{ id: 'CUS-0001', name: 'Rahim' }, { id: 'CUS-0002', name: 'Karim' }] } });
  await ctx.Storage.hydrate();
  const before = f.calls.length;
  check('getData returns the hydrated rows, synchronously',
    ctx.Storage.getData('customers').map(c => c.name), ['Rahim', 'Karim']);
  check('getById finds one', ctx.Storage.getById('customers', 'CUS-0002').name, 'Karim');
  check('getById misses cleanly', ctx.Storage.getById('customers', 'CUS-9999'), null);
  check('   ...and none of that touched the network', f.calls.length, before);
  ok('getData always returns an array, even for an untouched collection',
    Array.isArray(ctx.Storage.getData('expenses')), '');
}
{
  // 1400 rows across the 1000-row page cap: the second page must be followed,
  // or the UI silently renders two thirds of the table as the whole table.
  const many = Array.from({ length: 1400 }, (_, i) => ({ id: `CUS-${String(i + 1).padStart(4, '0')}` }));
  const { ctx, f } = online({ rows: { customers: many } });
  await ctx.Storage.hydrate();
  check('a collection larger than one page is read completely',
    ctx.Storage.getData('customers').length, 1400);
  ok('   ...by following the offset',
    f.calls.some(c => c.path.includes('offset=1000')),
    JSON.stringify(f.calls.filter(c => c.path.startsWith('/customers')).map(c => c.path)));
}
{
  const { ctx } = online({ rows: { jobCards: [], 'job-cards': [{ id: 'JOB-0001' }] } });
  await ctx.Storage.hydrate();
  check('the jobCards collection maps to the job-cards route',
    ctx.Storage.getData('jobCards').map(j => j.id), ['JOB-0001']);
}
{
  const { ctx } = online({ rows: { 'inventory-transactions': [{ id: 'STK-0001' }] } });
  await ctx.Storage.hydrate();
  check('inventoryTransactions maps to inventory-transactions',
    ctx.Storage.getData('inventoryTransactions').map(t => t.id), ['STK-0001']);
}

/* ============================================================
   3. Writes go to the server, and the server's answer is kept
   ============================================================ */
console.log('\n-- 3. writes --');
{
  const { ctx, f } = online({});
  await ctx.Storage.hydrate();
  ctx.Api.configure({ token: 'unit-token' });
  const res = await ctx.Storage.create('customers', { name: 'Nusrat', phone: '01' });
  ok('create() succeeds', res.ok, JSON.stringify(res));
  const sent = f.calls.find(c => c.method === 'POST');
  check('   ...as a POST to the collection', sent.path, '/customers');
  check('   ...carrying the record', sent.body.name, 'Nusrat');
  check('   ...authenticated', sent.auth, 'Bearer unit-token');
  check('THE SERVER chose the id, not the browser', res.record.id, 'CUS-0901');
  check('   ...and the cache holds what the server returned',
    ctx.Storage.getById('customers', 'CUS-0901').name, 'Nusrat');
  ok('   ...with no client-side counter consulted',
    ctx.localStorage.getItem('taqwa_counters') === null,
    String(ctx.localStorage.getItem('taqwa_counters')));
}
{
  const { ctx, f } = online({ rows: { customers: [{ id: 'CUS-0001', name: 'Rahim', phone: '01' }] } });
  await ctx.Storage.hydrate();
  ctx.Api.configure({ token: 't' });
  const res = await ctx.Storage.update('customers', 'CUS-0001', { name: 'Rahim Ahmed' });
  const sent = f.calls.find(c => c.method === 'PUT');
  check('update() PUTs to the record', sent.path, '/customers/CUS-0001');
  check('   ...sending only the changed fields', sent.body, { name: 'Rahim Ahmed' });
  check('   ...and the cache takes the server row', ctx.Storage.getById('customers', 'CUS-0001').name, 'Rahim Ahmed');
  ok('   ...including fields the server added', res.record.updatedAt === 'later', JSON.stringify(res.record));
}
{
  const { ctx, f } = online({ rows: { customers: [{ id: 'CUS-0001' }] } });
  await ctx.Storage.hydrate();
  ctx.Api.configure({ token: 't' });
  const res = await ctx.Storage.remove('customers', 'CUS-0001');
  ok('remove() succeeds', res.ok, JSON.stringify(res));
  check('   ...as a DELETE', f.calls.find(c => c.method === 'DELETE').path, '/customers/CUS-0001');
  check('   ...and the row leaves the cache', ctx.Storage.getById('customers', 'CUS-0001'), null);
}
{
  const { ctx, f } = online({ rows: { payments: [{ id: 'PAY-0001', invoiceId: 'INV-0001' }],
                                      invoices: [{ id: 'INV-0001', paid: 100 }] } });
  await ctx.Storage.hydrate();
  ctx.Api.configure({ token: 't' });
  const res = await ctx.Storage.action('payments', 'PAY-0001', 'void', {}, ['invoices']);
  ok('action() succeeds', res.ok, JSON.stringify(res));
  check('   ...as a POST to the action path',
    f.calls.find(c => c.path === '/payments/PAY-0001/void').method, 'POST');
  ok('   ...and re-reads the collections the transaction also moved',
    f.calls.filter(c => c.method === 'GET' && c.path.startsWith('/invoices')).length >= 2,
    JSON.stringify(f.calls.filter(c => c.path.startsWith('/invoices')).map(c => c.method)));
}
{
  const { ctx } = online({ rows: { customers: [{ id: 'CUS-0001', name: 'Rahim' }] },
    fail: ({ method }) => method === 'PUT'
      ? { status: 422, error: { code: 'unprocessable', message: 'Enter a valid phone number.',
                                fields: { phone: 'Enter a valid phone number.' } } } : null });
  await ctx.Storage.hydrate();
  ctx.Api.configure({ token: 't' });
  const res = await ctx.Storage.update('customers', 'CUS-0001', { phone: 'nope' });
  ok('a refused write reports the refusal', res.ok === false && res.code === 'unprocessable',
    JSON.stringify(res));
  check('   ...with the field detail the form needs', res.fields.phone, 'Enter a valid phone number.');
  check('THE CACHE IS UNCHANGED when the server said no',
    ctx.Storage.getById('customers', 'CUS-0001').phone, undefined);
  check('   ...and the record it still has is the stored one',
    ctx.Storage.getById('customers', 'CUS-0001').name, 'Rahim');
}
{
  // C-12: the browser's credential is an HttpOnly cookie this code cannot
  // see, so `no_token` is no longer a thing the client decides. With no
  // session the app is LOCKED, and a write is refused before it is sent --
  // by the absence of a session rather than the absence of a token.
  const { ctx, f } = online({ authenticated: false });
  await ctx.Storage.hydrate();
  check('with no session the app is locked, not offline', ctx.Storage.mode, 'locked');
  const res = await ctx.Storage.create('customers', { name: 'X' });
  check('a write with no credential is refused', res.code, 'unauthorized');
  check('   ...and never reached the server', f.calls.filter(c => c.method === 'POST').length, 0);
}

/* ============================================================
   4. The synchronous writers cannot lie
   ============================================================ */
console.log('\n-- 4. the old synchronous writers --');
{
  const { ctx } = online({ rows: { customers: [{ id: 'CUS-0001' }] } });
  await ctx.Storage.hydrate();
  for (const [name, call] of [
    ['addData', () => ctx.Storage.addData('customers', { name: 'X' })],
    ['updateData', () => ctx.Storage.updateData('customers', 'CUS-0001', { name: 'X' })],
    ['deleteData', () => ctx.Storage.deleteData('customers', 'CUS-0001')],
    ['saveSettings', () => ctx.Storage.saveSettings({ taxRate: 9 })],
  ]) {
    let threw = false;
    try { call(); } catch (e) { threw = true; }
    ok(`${name}() refuses in api mode rather than writing somewhere nobody reads`, threw, '');
  }
  check('   ...and the cache was not touched', ctx.Storage.getData('customers').length, 1);
  ok('   ...nor was localStorage', ctx.localStorage.getItem('taqwa_customers') === null, '');
}
{
  const { ctx } = online({ rows: { customers: [{ id: 'CUS-0001' }] } });
  await ctx.Storage.hydrate();
  check('saveData() is a no-op against the API', ctx.Storage.saveData('customers', []), false);
  check('   ...and changed nothing', ctx.Storage.getData('customers').length, 1);
}

/* ============================================================
   5. Settings
   ============================================================ */
console.log('\n-- 5. settings --');
{
  const { ctx } = online({ settings: { businessName: 'Taqwa ASC', taxRate: 7.5, currency: 'BDT' } });
  await ctx.Storage.hydrate();
  const s = ctx.Storage.getSettings();
  check('stored settings win over the browser defaults', s.taxRate, 7.5);
  check('   ...and so does a stored currency', s.currency, 'BDT');
  check('a field the shop never set still renders a default', s.invoiceFooter,
    'Thank you for servicing with Taqwa Automobile Service Center.');
}
{
  const { ctx } = online({ settings: null });
  await ctx.Storage.hydrate();
  check('no settings row yet is not an error -- defaults show',
    ctx.Storage.getSettings().businessName, 'Taqwa Automobile Service Center');
  check('   ...and the app is still in api mode', ctx.Storage.mode, 'api');
}
{
  const { ctx, f } = online({ settings: { businessName: 'Taqwa ASC', taxRate: 5 } });
  await ctx.Storage.hydrate();
  ctx.Api.configure({ token: 't' });
  const res = await ctx.Storage.putSettings({ taxRate: 9 });
  ok('putSettings succeeds', res.ok, JSON.stringify(res));
  const sent = f.calls.find(c => c.method === 'PUT' && c.path === '/settings');
  check('   ...as a PUT to the singleton', sent.path, '/settings');
  check('ONLY the submitted field is sent -- the merge is the server\'s', sent.body, { taxRate: 9 });
  check('   ...and the unsent field survives', ctx.Storage.getSettings().businessName, 'Taqwa ASC');
  check('   ...while the sent one changed', ctx.Storage.getSettings().taxRate, 9);
}
{
  const { ctx, f } = online({ settings: { businessName: 'X' } });
  await ctx.Storage.hydrate();
  ctx.Api.configure({ token: 't' });
  await ctx.Storage.putSettings({ businessName: 'Y', phone: '01' });
  const sent = f.calls.find(c => c.method === 'PUT' && c.path === '/settings');
  ok('neither id nor updatedAt is ever submitted',
    !('id' in sent.body) && !('updatedAt' in sent.body), JSON.stringify(sent.body));
  ok('   ...nor theme', !('theme' in sent.body), JSON.stringify(sent.body));
}

/* ============================================================
   6. What stays in the browser
   ============================================================ */
console.log('\n-- 6. browser-local state --');
{
  const { ctx, f } = online({ rows: { customers: [] } });
  await ctx.Storage.hydrate();
  ctx.Storage.saveTheme('dark');
  check('theme is written to localStorage even in api mode',
    ctx.localStorage.getItem('taqwa_theme'), '"dark"');
  check('   ...and read back from there', ctx.Storage.getTheme(), 'dark');
  ok('   ...and never sent to the server',
    !f.calls.some(c => JSON.stringify(c.body || '').includes('dark')),
    JSON.stringify(f.calls.map(c => c.body)));
}
{
  const { ctx, f } = online({});
  await ctx.Storage.hydrate();
  ctx.Storage.seedIfEmpty();
  check('seedIfEmpty() writes NOTHING to an empty database',
    f.calls.filter(c => c.method === 'POST').length, 0);
  ok('   ...and does not mark the browser seeded either',
    ctx.localStorage.getItem('taqwa_seeded') === null, '');
  check('   ...leaving the empty database empty', ctx.Storage.getData('customers'), []);
}
{
  const { ctx, f } = online({ rows: { customers: [{ id: 'CUS-0001' }] } });
  await ctx.Storage.hydrate();
  check('resetToSeedData() refuses against a real database', ctx.Storage.resetToSeedData(), false);
  ok('   ...deleting nothing', !f.calls.some(c => c.method === 'DELETE'), '');
  check('   ...and the data is still there', ctx.Storage.getData('customers').length, 1);
}

/* ============================================================
   7. A browser with no backend is untouched
   ============================================================ */
console.log('\n-- 7. local mode is the old behaviour, exactly --');
{
  const { ctx } = boot({ origin: '' });
  await ctx.Storage.hydrate();
  const made = ctx.Storage.addData('customers', { name: 'Offline' });
  check('addData still assigns a local sequential id', made.id, 'CUS-0001');
  ok('   ...and a createdAt', typeof made.createdAt === 'string' && made.createdAt.length > 0, made.createdAt);
  check('   ...and it is readable back', ctx.Storage.getById('customers', 'CUS-0001').name, 'Offline');
  check('updateData merges', ctx.Storage.updateData('customers', 'CUS-0001', { name: 'Renamed' }).name, 'Renamed');
  check('deleteData removes', ctx.Storage.deleteData('customers', 'CUS-0001'), true);
  check('   ...and says so when there is nothing to remove',
    ctx.Storage.deleteData('customers', 'CUS-0001'), false);
  ok('   ...and it all went to localStorage',
    ctx.localStorage.getItem('taqwa_customers') !== null, '');
}
{
  const { ctx } = boot({ origin: '' });
  await ctx.Storage.hydrate();
  const res = await ctx.Storage.create('customers', { name: 'Offline' });
  ok('create() works offline too, through the same shape', res.ok && res.record.id === 'CUS-0001',
    JSON.stringify(res));
  const upd = await ctx.Storage.update('customers', 'CUS-0001', { name: 'B' });
  ok('   ...as does update()', upd.ok && upd.record.name === 'B', JSON.stringify(upd));
  const gone = await ctx.Storage.remove('customers', 'CUS-0001');
  ok('   ...and remove()', gone.ok === true, JSON.stringify(gone));
  const missing = await ctx.Storage.update('customers', 'CUS-9999', { name: 'B' });
  check('   ...and a missing record is reported, not invented', missing.code, 'not_found');
}
{
  const { ctx } = boot({ origin: '' });
  await ctx.Storage.hydrate();
  const res = await ctx.Storage.action('payments', 'PAY-0001', 'void');
  check('a backend-only action says so offline rather than pretending', res.code, 'no_api');
}
{
  const { ctx } = boot({ origin: '' });
  await ctx.Storage.hydrate();
  ctx.Storage.seedIfEmpty();
  ok('seedIfEmpty() still loads the demo data with no backend',
    ctx.Storage.getData('customers').length > 0, '');
  check('   ...and marks the browser seeded', ctx.localStorage.getItem('taqwa_seeded'), 'true');
  const before = ctx.Storage.getData('customers').length;
  ctx.Storage.seedIfEmpty();
  check('   ...once', ctx.Storage.getData('customers').length, before);
  ok('resetToSeedData() still works offline', ctx.Storage.resetToSeedData() === true, '');
}

/* ============================================================
   8. The credential leaves no trace
   ============================================================ */
console.log('\n-- 8. the token is not persisted anywhere --');
{
  const { ctx, f } = online({ rows: { customers: [] } });
  await ctx.Storage.hydrate();
  ctx.Api.configure({ token: 'zzz-distinctive-token-zzz' });
  await ctx.Storage.create('customers', { name: 'A', phone: '01' });

  const stored = [];
  for (const k of ['taqwa_customers', 'taqwa_settings', 'taqwa_theme', 'taqwa_counters',
                   'taqwa_seeded', 'taqwa_token', 'taqwa_api_token']) {
    const v = ctx.localStorage.getItem(k);
    if (v !== null) stored.push(`${k}=${v}`);
  }
  ok('no browser storage key holds the token after a write',
    !stored.join('|').includes('zzz-distinctive-token-zzz'), stored.join(' | '));
  ok('   ...and the app never reaches for sessionStorage at all',
    typeof ctx.sessionStorage === 'undefined', 'sessionStorage was touched');
  ok('the token DID reach the server, so it is held somewhere -- in memory',
    f.calls.some(c => c.auth === 'Bearer zzz-distinctive-token-zzz'),
    JSON.stringify(f.calls.map(c => c.auth)));
  ok('   ...and is not readable back off the client',
    !JSON.stringify(ctx.Api.configure({})).includes('zzz-distinctive-token-zzz'),
    JSON.stringify(ctx.Api.configure({})));
}

/* ============================================================
   9. Failing mid-session, and recovering
   ============================================================ */
console.log('\n-- 9. a failure mid-session does not end the session --');
{
  // Hydration succeeded; the server then goes away and comes back. The mode
  // must NOT flip to local underneath a running page -- that would start
  // writing to a localStorage nobody is reading -- and work must resume.
  let down = false;
  const inner = fakeApi({ rows: { customers: [{ id: 'CUS-0001', name: 'Rahim' }] } });
  const flaky = async (url, init) => {
    if (down) throw new Error('connection refused');
    return inner(url, init);
  };
  flaky.calls = inner.calls;
  const { ctx } = boot({ origin: 'http://localhost:8787', fetch: flaky });
  await ctx.Storage.hydrate();
  ctx.Api.configure({ token: 't' });

  down = true;
  const failed = await ctx.Storage.create('customers', { name: 'Nusrat', phone: '01' });
  check('a write while the server is away fails as a network error', failed.code, 'network_error');
  check('   ...and the mode does NOT silently flip to local', ctx.Storage.mode, 'api');
  check('   ...and the cache is untouched, so nothing looks saved',
    ctx.Storage.getData('customers').length, 1);
  ok('   ...and the message names no URL or host',
    !/localhost|8787|http/.test(failed.message), failed.message);

  down = false;
  const recovered = await ctx.Storage.create('customers', { name: 'Nusrat', phone: '01' });
  ok('the very next write succeeds once the server is back', recovered.ok,
    JSON.stringify(recovered));
  check('   ...and the record appears', ctx.Storage.getData('customers').length, 2);
}
{
  // A read failing mid-session must not empty the cache: showing nothing is
  // a worse lie than showing what was last known.
  let down = false;
  const inner = fakeApi({ rows: { invoices: [{ id: 'INV-0001', paid: 100 }] } });
  const flaky = async (url, init) => {
    if (down && /\/invoices/.test(String(url))) throw new Error('down');
    return inner(url, init);
  };
  const { ctx } = boot({ origin: 'http://localhost:8787', fetch: flaky });
  await ctx.Storage.hydrate();
  down = true;
  const stale = await ctx.Storage.refreshAll('invoices');
  check('a failed re-read is reported', stale, ['invoices']);
  check('   ...and leaves the last known rows in place rather than emptying them',
    ctx.Storage.getById('invoices', 'INV-0001').paid, 100);
}

process.exit(summary('Storage adapter unit') === 0 ? 0 : 1);
})();
