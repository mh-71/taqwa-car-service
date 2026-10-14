/* storage-follow-ups — the on-demand, database-only collections added for
   Customer Follow-up (followUps, followUpContacts), and the one additive
   change to Storage.action (it now passes `meta` on).

   Drives the REAL Storage over the REAL Api with fetch faked. What must hold:
     1. Hydration is untouched: COLLECTIONS is the same twelve, and loading a
        page never asks for follow-ups.
     2. load() reads them on demand in 'api' mode, into the cache.
     3. A failing follow-up endpoint (missing migration, 500, timeout) fails
        load() alone: the mode stays 'api' and every other collection stays.
     4. Outside 'api' mode they read as empty -- even if browser storage holds
        something under their name -- and every write is refused without
        touching browser storage.
     5. Storage.action passes `meta` on (the created contact, `replayed`),
        caches `data` under the action's own collection, and existing callers
        see the same ok/record/stale as before.
     6. Signing out forgets them. */
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const FU = { id: 'FUP-0001', customerId: 'CUS-0001', vehicleId: null, reason: 'Call back', status: 'Open',
  dueDate: '2026-10-20', priority: 'normal', lastOutcome: null, lastContactAt: null };
const CONTACT = { id: 'FUC-0001', followUpId: 'FUP-0001', outcome: 'reached', status: 'Active' };

/** fakeApi for everything else; follow-up paths answered here, as the Worker would. */
function api({ followUps = [FU], contacts = [], failFollowUps = null } = {}) {
  const base = fakeApi({ rows: { customers: [{ id: 'CUS-0001', name: 'Rahim' }] } });
  const calls = base.calls;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (!path.startsWith('/follow-up')) return base(url, init);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (failFollowUps) return res(failFollowUps.status, { error: failFollowUps.error });
    const list = path.startsWith('/follow-up-contacts') ? contacts : followUps;
    if (method === 'GET') return res(200, { data: list, count: list.length, total: list.length, limit: 1000, offset: 0 });
    if (method === 'POST' && path === '/follow-ups') return res(body.idempotencyKey === 'replay-key-000000' ? 200 : 201,
      { data: { ...FU, id: 'FUP-0002' }, ...(body.idempotencyKey === 'replay-key-000000' ? { replayed: true } : {}) });
    if (method === 'POST' && path.endsWith('/contact')) {
      return res(201, { data: { ...FU, lastOutcome: 'reached' }, contact: CONTACT });
    }
    if (method === 'POST' && path.endsWith('/void')) {
      return res(200, { data: { ...CONTACT, status: 'Void' }, followUp: { ...FU, lastOutcome: null } });
    }
    return res(404, { error: { code: 'not_found', message: 'No such record.' } });
  };
  fn.calls = calls;
  return fn;
}
const online = (opts) => {
  const f = api(opts);
  const h = boot({ origin: 'http://localhost:8787', fetch: f });
  return { ...h, f };
};

console.log('=== storage-follow-ups: on-demand, database-only collections ===\n');

(async () => {

console.log('-- 1. hydration is untouched --');
{
  const { ctx, f } = online();
  const r = await ctx.Storage.hydrate();
  check('a live Worker -> api mode', r.mode, 'api');
  check('COLLECTIONS is still the same twelve, in order', [...ctx.Storage.COLLECTIONS],
    ['customers', 'vehicles', 'appointments', 'jobCards', 'services', 'mechanics', 'parts', 'invoices',
      'payments', 'expenses', 'inventoryTransactions', 'invoiceAdjustments']);
  ok('   ...and hydration never asks for follow-ups', !f.calls.some(c => c.path.startsWith('/follow-up')),
    JSON.stringify(f.calls.map(c => c.path)));
  check('   ...so they read as empty until loaded', ctx.Storage.getData('followUps'), []);
}
{
  // Every follow-up path failing must not affect the app's mode at all.
  const { ctx } = online({ failFollowUps: { status: 500, error: { code: 'database_error', message: 'Could not read follow-ups.' } } });
  const r = await ctx.Storage.hydrate();
  check('a broken follow-up endpoint does not stop hydration: still api mode', r.mode, 'api');
}

console.log('\n-- 2. load() on demand --');
{
  const { ctx, f } = online({ contacts: [CONTACT] });
  await ctx.Storage.hydrate();
  const a = await ctx.Storage.load('followUps');
  const b = await ctx.Storage.load('followUpContacts');
  ok('load() succeeds for both', a.ok && b.ok, JSON.stringify([a, b]));
  check('   ...as paged GETs to their API paths',
    f.calls.filter(c => c.path.startsWith('/follow-up')).map(c => c.path),
    ['/follow-ups?limit=1000&offset=0', '/follow-up-contacts?limit=1000&offset=0']);
  check('   ...into the cache', [ctx.Storage.getData('followUps').length, ctx.Storage.getById('followUpContacts', 'FUC-0001').outcome],
    [1, 'reached']);
  const notOnDemand = await ctx.Storage.load('customers');
  check('load() refuses a hydrated collection (it is not an on-demand one)', notOnDemand.code, 'not_on_demand');
}

console.log('\n-- 3. a failing follow-up endpoint fails alone --');
for (const [label, failure] of [
  ['missing migration (500 database_error)', { status: 500, error: { code: 'database_error', message: 'Could not read follow-ups.' } }],
  ['not found (404)', { status: 404, error: { code: 'not_found', message: 'No such endpoint.' } }],
]) {
  const { ctx } = online({ failFollowUps: failure });
  await ctx.Storage.hydrate();
  const r = await ctx.Storage.load('followUps');
  ok(`${label}: load() reports the failure`, r.ok === false && r.code === failure.error.code, JSON.stringify(r));
  check('   ...the mode stays api', ctx.Storage.mode, 'api');
  check('   ...other collections are untouched', ctx.Storage.getData('customers').map(c => c.id), ['CUS-0001']);
  check('   ...and nothing is invented for follow-ups', ctx.Storage.getData('followUps'), []);
}

console.log('\n-- 4. outside api mode: empty, and every write refused --');
{
  const { ctx } = boot({ origin: '' });            // no backend at all
  ctx.localStorage.setItem('taqwa_followUps', JSON.stringify([{ id: 'FUP-9999', reason: 'planted demo row' }]));
  await ctx.Storage.hydrate();
  ctx.Storage.seedIfEmpty();                        // the app seeds demo data in local mode
  check('local mode', ctx.Storage.mode, 'local');
  check('getData(followUps) is empty even with a browser-storage row under its name', ctx.Storage.getData('followUps'), []);
  check('getById finds nothing', ctx.Storage.getById('followUps', 'FUP-9999'), null);
  const before = ctx.localStorage.getItem('taqwa_followUps');
  const c = await ctx.Storage.create('followUps', { customerId: 'CUS-0001', reason: 'x', idempotencyKey: 'k' });
  const u = await ctx.Storage.update('followUps', 'FUP-9999', { reason: 'y' });
  const d = await ctx.Storage.remove('followUps', 'FUP-9999');
  const cc = await ctx.Storage.create('followUpContacts', { outcome: 'reached' });
  check('create / update / remove are refused with no_api', [c.code, u.code, d.code, cc.code], ['no_api', 'no_api', 'no_api', 'no_api']);
  check('   ...and browser storage is exactly as it was', ctx.localStorage.getItem('taqwa_followUps'), before);
  check('   ...and nothing was written for contacts', ctx.localStorage.getItem('taqwa_followUpContacts'), null);
  check('saveData refuses them too', ctx.Storage.saveData('followUps', []), false);
  const l = await ctx.Storage.load('followUps');
  check('load() is refused offline', l.code, 'no_api');
  const act = await ctx.Storage.action('followUps', 'FUP-9999', 'complete', {});
  check('actions are refused offline (as before)', act.code, 'no_api');
  // The change is limited to these two: an ordinary collection still works offline.
  const cust = await ctx.Storage.create('customers', { name: 'Offline' });
  ok('   ...while an ordinary collection still writes offline exactly as before', cust.ok === true, JSON.stringify(cust));
}
{
  // Signed out: the existing locked refusal comes first.
  const f = fakeApi({ authenticated: false });
  const { ctx } = boot({ origin: 'http://localhost:8787', fetch: f });
  await ctx.Storage.hydrate();
  check('locked mode', ctx.Storage.mode, 'locked');
  const c = await ctx.Storage.create('followUps', { reason: 'x' });
  check('a write while signed out gets the existing unauthorized refusal', c.code, 'unauthorized');
  check('   ...and reads are empty', ctx.Storage.getData('followUps'), []);
}

console.log('\n-- 5. create and action pass meta on --');
{
  const { ctx } = online();
  await ctx.Storage.hydrate();
  await ctx.Storage.load('followUps');
  const fresh = await ctx.Storage.create('followUps', { customerId: 'CUS-0001', reason: 'x', dueDate: '2026-10-20', idempotencyKey: 'new-key-000000000' });
  ok('create() in api mode posts and caches the server record', fresh.ok && fresh.record.id === 'FUP-0002', JSON.stringify(fresh));
  ok('   ...no replayed flag on a first success', !fresh.meta.replayed, JSON.stringify(fresh.meta));
  const replay = await ctx.Storage.create('followUps', { customerId: 'CUS-0001', reason: 'x', dueDate: '2026-10-20', idempotencyKey: 'replay-key-000000' });
  check('a replay is visible as meta.replayed', replay.meta.replayed, true);
  check('   ...and does not duplicate the cached record', ctx.Storage.getData('followUps').filter(r => r.id === 'FUP-0002').length, 1);

  const r = await ctx.Storage.action('followUps', 'FUP-0001', 'contact', { outcome: 'reached', idempotencyKey: 'contact-key-00000' }, ['followUpContacts']);
  ok('action() succeeds', r.ok, JSON.stringify(r));
  check('   ...record is the follow-up (data)', r.record.id, 'FUP-0001');
  check('   ...meta carries the created contact', r.meta.contact, CONTACT);
  check('   ...the follow-up cache holds the follow-up, never the contact',
    [ctx.Storage.getById('followUps', 'FUP-0001').lastOutcome, ctx.Storage.getById('followUps', 'FUC-0001')], ['reached', null]);
  const v = await ctx.Storage.action('followUpContacts', 'FUC-0001', 'void', { reason: 'Mistake' }, ['followUps']);
  check('a void caches the contact under contacts and passes the follow-up in meta',
    [v.record.status, v.meta.followUp.lastOutcome], ['Void', null]);
}
{
  // Backward compatibility: an existing action caller sees what it always saw.
  const f = fakeApi({ rows: { payments: [{ id: 'PAY-0001', invoiceId: 'INV-0001' }], invoices: [{ id: 'INV-0001' }] } });
  const { ctx } = boot({ origin: 'http://localhost:8787', fetch: f });
  await ctx.Storage.hydrate();
  const res = await ctx.Storage.action('payments', 'PAY-0001', 'void', {}, ['invoices']);
  check('an existing action still returns ok + record (+ an empty meta)', [res.ok, res.record.id, res.meta, 'stale' in res],
    [true, 'PAY-0001', {}, false]);
}

console.log('\n-- 6. signing out forgets them --');
{
  const { ctx } = online();
  await ctx.Storage.hydrate();
  await ctx.Storage.load('followUps');
  check('loaded', ctx.Storage.getData('followUps').length, 1);
  const out = await ctx.Storage.signOut();
  ok('signed out', out.ok !== false, JSON.stringify(out));
  check('   ...and the follow-ups are gone from the cache', ctx.Storage.getData('followUps'), []);
}

process.exit(summary('Storage follow-ups unit') === 0 ? 0 : 1);
})();
