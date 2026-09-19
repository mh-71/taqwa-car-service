/* write-safety — the guarantees a write has to keep once it crosses a network.

   C-10 made every write asynchronous. That introduced three failure modes the
   old synchronous writes could not have, and this suite is about those:

     1. a second click while the first request is still in flight,
     2. a dialog that closes, or a success toast that appears, before the
        server has actually agreed,
     3. a write that succeeds while the re-read that follows it does not,
        leaving the screen showing a figure the database has moved on from.

   Everything is driven through the REAL Utils.guard / Utils.saving /
   Utils.wrote and the REAL Storage, with fetch faked. */
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

/* A button close enough to the real thing for the guard to act on: a
   disabled button fires no click, which is what makes it the guard. */
function button(label = 'Save') {
  const b = {
    textContent: label, disabled: false, _handlers: [],
    addEventListener(t, cb) { if (t === 'click') b._handlers.push(cb); },
    click() {
      if (b.disabled) return Promise.resolve();          // the browser's own rule
      return Promise.all(b._handlers.map(cb => cb({ currentTarget: b, target: b })));
    },
  };
  return b;
}

const online = (opts) => {
  const f = fakeApi(opts);
  return { ...boot({ origin: 'http://localhost:8787', fetch: f }), f };
};

console.log('=== write-safety: guard, wrote, and the stale re-read ===\n');

(async () => {

/* ============================================================
   1. A second click cannot send a second request
   ============================================================ */
console.log('-- 1. duplicate submission --');
{
  const { ctx } = boot({ origin: '' });
  let runs = 0;
  const btn = button('Delete');
  btn.addEventListener('click', ctx.Utils.saving(async () => {
    runs += 1;
    await new Promise(r => setTimeout(r, 20));
  }));
  const first = btn.click();
  check('the control is disabled while the write is in flight', btn.disabled, true);
  check('   ...and says so', btn.textContent, 'Saving…');
  await btn.click();                       // the impatient second press
  await first;
  check('the handler ran ONCE, not twice', runs, 1);
  check('   ...and the control is usable again', btn.disabled, false);
  check('   ...with its own label back', btn.textContent, 'Delete');
}
{
  const { ctx } = boot({ origin: '' });
  let runs = 0;
  const btn = button('Deactivate');
  // The delegated shape: the listener sits on a table body, so the button
  // being held is the one in the row rather than the listener's own element.
  const rowClick = () => ctx.Utils.guard(btn, async () => {
    runs += 1;
    await new Promise(r => setTimeout(r, 20));
  });
  const first = rowClick();
  check('guard() holds the row button too', btn.disabled, true);
  await rowClick();
  await first;
  check('   ...so a delegated row action also runs once', runs, 1);
  check('   ...and is restored', btn.disabled === false && btn.textContent === 'Deactivate', true);
}
/* ============================================================
   2. A failure does not leave the control stuck
   ============================================================ */
console.log('\n-- 2. recovery after a failure --');
{
  // console.error is where the detail goes; the user gets a toast. Capturing
  // the log is how this checks the failure was reported rather than eaten,
  // and that the message carries no stack trace of its own.
  const logged = [];
  const realError = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  const { ctx } = boot({ origin: '' });
  const btn = button('Save');
  btn.addEventListener('click', ctx.Utils.saving(async () => { throw new Error('boom'); }));
  await btn.click();
  console.error = realError;
  check('an unexpected throw still re-enables the control', btn.disabled, false);
  check('   ...and restores its label', btn.textContent, 'Save');
  ok('   ...and the failure is reported rather than swallowed',
    logged.some(l => /Write failed/.test(l)), JSON.stringify(logged));
  let ran = false;
  btn._handlers = [];
  btn.addEventListener('click', ctx.Utils.saving(async () => { ran = true; }));
  await btn.click();
  ok('   ...and the next attempt still works', ran, 'the guard stayed latched');
}
{
  const { ctx } = boot({ origin: '' });
  const btn = button('Save');
  btn.addEventListener('click', ctx.Utils.guard.bind(null, btn, async () => {
    throw new Error('boom');
  }));
  await btn.click();
  check('guard() recovers from a throw as well', btn.disabled, false);
}

/* ============================================================
   3. wrote(): success, refusal, and success-with-stale
   ============================================================ */
console.log('\n-- 3. reporting an outcome --');
{
  const { ctx } = boot({ origin: '' });
  check('a plain success is a success', ctx.Utils.wrote({ ok: true }), true);
  check('a refusal is not', ctx.Utils.wrote({ ok: false, message: 'No.' }), false);
  check('a missing result is not', ctx.Utils.wrote(undefined), false);
  check('a success whose re-read failed is STILL a success',
    ctx.Utils.wrote({ ok: true, stale: ['invoices'] }), true);
}

/* ============================================================
   4. A write that succeeds while the re-read fails
   ============================================================ */
console.log('\n-- 4. the stale re-read --');
{
  // The payment lands; the invoice re-read that follows it does not.
  let hydrated = false;
  const f = fakeApi({ rows: {
    customers: [{ id: 'CUS-0001' }], invoices: [{ id: 'INV-0001', total: 840, paid: 0 }],
    payments: [{ id: 'PAY-0001', invoiceId: 'INV-0001', amount: 200, status: 'Active' }] } });
  const inner = f;
  const failing = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (hydrated && (init.method || 'GET') === 'GET' && path.startsWith('/invoices')) {
      throw new Error('network down');
    }
    return inner(url, init);
  };
  failing.calls = inner.calls;
  const h = boot({ origin: 'http://localhost:8787', fetch: failing });
  await h.ctx.Storage.hydrate();
  hydrated = true;
  h.ctx.Api.configure({ token: 't' });

  const res = await h.ctx.Storage.action('payments', 'PAY-0001', 'void', {}, ['invoices']);
  ok('the action itself is reported as successful, because it was',
    res.ok === true, JSON.stringify(res));
  check('   ...and names what could not be re-read', res.stale, ['invoices']);
  check('   ...which wrote() turns into a visible warning, not a silent stale screen',
    h.ctx.Utils.wrote(res), true);
}
{
  const { ctx } = online({ rows: { customers: [], invoices: [] } });
  await ctx.Storage.hydrate();
  ctx.Api.configure({ token: 't' });
  const res = await ctx.Storage.action('invoices', 'INV-0001', 'void', {}, []);
  ok('a transaction with nothing to re-read carries no stale list',
    !('stale' in (res.ok ? res : {})), JSON.stringify(res));
}
{
  const { ctx, f } = online({ rows: { parts: [{ id: 'PRT-0001', stock: 5 }] } });
  await ctx.Storage.hydrate();
  const stale = await ctx.Storage.refreshAll('parts', 'invoices');
  check('refreshAll reports nothing stale when every re-read works', stale, []);
  ok('   ...and actually re-read them',
    f.calls.filter(c => c.method === 'GET' && /^\/(parts|invoices)/.test(c.path)).length >= 4, '');
}
{
  const { ctx } = boot({ origin: '' });
  await ctx.Storage.hydrate();
  check('refreshAll offline reports every name as stale rather than pretending',
    await ctx.Storage.refreshAll('parts'), ['parts']);
}

process.exit(summary('Write safety unit') === 0 ? 0 : 1);
})();
