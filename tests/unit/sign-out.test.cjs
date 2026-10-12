/* sign-out — ending the session, and only claiming to when it has ended.

   The session is a signed HttpOnly cookie: DELETE /api/session is the one
   supported way to end it, and GET /api/session the only way script can
   learn whether that took. These suites hold the client to that:

     1. Storage.signOut() reports success only once the server confirms the
        session is gone, and on any failure leaves the data and mode as they
        were -- it never forgets the cache while the session is still live.
     2. Signing out clears authentication state only: business data and
        settings kept in this browser are untouched.
     3. The shell's two Sign Out controls (the header button and the profile
        menu item) reload to the sign-in screen on success, and on failure
        stay put, keep the icon, re-enable, and say the user is still signed in.
     4. A page holding workshop data that goes into the back/forward cache is
        blanked, and reloaded if Back brings it out again.

   Drives the REAL js/storage.js and js/app.js through the shared harness. */
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const ORIGIN = 'http://localhost:8787';
const ROWS = { customers: [{ id: 'CUS-0001', name: 'Rahim' }] };
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

/** A fetch that wraps the fake API and can break one kind of request. */
function wrapped(f, { breakDelete, breakSessionAfterDelete, keepSession, holdDelete, holdHealth } = {}) {
  let deleted = false;
  let release = null;
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    const isSession = /\/api\/session$/.test(String(url));
    if (holdHealth && /\/api\/health$/.test(String(url))) return new Promise(() => {});   // never answers
    if (isSession && method === 'DELETE') {
      if (holdDelete) await new Promise(r => { release = r; });
      if (breakDelete === 'network') { f.calls.push({ method, path: '/session' }); throw new TypeError('Failed to fetch'); }
      if (breakDelete === 500) {
        f.calls.push({ method, path: '/session' });
        return { status: 500, ok: false, json: async () => ({ error: { code: 'internal_error', message: 'Something went wrong on the server.' } }) };
      }
      if (keepSession) { f.calls.push({ method, path: '/session' }); return { status: 204, ok: true, json: async () => null }; }
      deleted = true;
    }
    if (isSession && method === 'GET' && deleted && breakSessionAfterDelete) throw new TypeError('Failed to fetch');
    return f(url, init);
  };
  fn.calls = f.calls;
  fn.release = () => release && release();
  return fn;
}

/* ============================================================
   1-2. Storage.signOut()
   ============================================================ */
async function signedInStorage(opts = {}) {
  const f = fakeApi({ authenticated: true, rows: ROWS });
  const fetch = wrapped(f, opts);
  const h = boot({ origin: ORIGIN, fetch });
  // Things this browser keeps that have nothing to do with the session.
  h.ctx.localStorage.setItem('taqwa_theme', JSON.stringify('dark'));
  h.ctx.localStorage.setItem('taqwa_settings', JSON.stringify({ businessName: 'Local Copy' }));
  h.ctx.localStorage.setItem('taqwa_customers', JSON.stringify([{ id: 'CUS-0009', name: 'Offline' }]));
  h.ctx.localStorage.setItem('taqwa_counters', JSON.stringify({ customers: 9 }));
  await h.ctx.Storage.hydrate();
  return { h, f: fetch, S: h.ctx.Storage };
}
const browserData = h => ['taqwa_theme', 'taqwa_settings', 'taqwa_customers', 'taqwa_counters']
  .map(k => h.ctx.localStorage.getItem(k));

console.log('=== sign-out ===\n');

(async () => {

console.log('-- 1. Storage.signOut(): success --');
{
  const { h, f, S } = await signedInStorage();
  check('signed in to start with', S.mode, 'api');
  const before = browserData(h);
  const res = await S.signOut();
  ok('sign-out succeeds', res.ok === true, JSON.stringify(res));
  const calls = f.calls.filter(c => c.path === '/session').map(c => c.method);
  check('   ...by asking the server to end the session, then confirming it', calls.slice(-2), ['DELETE', 'GET']);
  check('   ...and the app is locked', S.mode, 'locked');
  check('   ...with nothing read while signed in left to show', S.getData('customers'), []);
  check('   ...business data and settings kept in this browser are untouched', browserData(h), before);
}

console.log('\n-- 1b. Storage.signOut(): the server did not end the session --');
for (const [why, opts, code] of [
  ['the network failed', { breakDelete: 'network' }, 'network_error'],
  ['the server answered 500', { breakDelete: 500 }, 'internal_error'],
  ['the cookie survived the DELETE', { keepSession: true }, 'still_signed_in'],
  ['the confirmation could not be read', { breakSessionAfterDelete: true }, 'network_error'],
]) {
  const { h, S } = await signedInStorage(opts);
  const before = browserData(h);
  const res = await S.signOut();
  ok(`${why}: sign-out is NOT reported as done`, res.ok === false, JSON.stringify(res));
  check(`   ...with a reason the user can be shown (${code})`, [res.code, typeof res.message === 'string' && res.message.length > 0], [code, true]);
  check('   ...the app stays signed in', S.mode, 'api');
  check('   ...and keeps its data, since the session holding it is still live', S.getData('customers').map(c => c.name), ['Rahim']);
  check('   ...and browser data is untouched', browserData(h), before);
}

/* ============================================================
   3. The shell's Sign Out controls
   ============================================================ */
function signOutButton() {
  const el = makeElement('signOutBtn');
  el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 17"/></svg>';
  el.attrs = {};
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
  el.removeAttribute = k => { delete el.attrs[k]; };
  el.focused = 0;
  el.focus = () => { el.focused += 1; };
  return el;
}

async function shell({ signedIn = true, origin = ORIGIN, health = true, ...opts } = {}) {
  const f = fakeApi({ authenticated: signedIn, rows: ROWS, health });
  const fetch = wrapped(f, opts);
  const btn = signOutButton();
  const winOn = {};
  const session = new Map();
  const h = boot({
    modules: ['js/app.js'], origin, fetch,
    beforeModules(doc, ctx) {
      const byId = doc.getElementById.bind(doc);
      doc.getElementById = id => (id === 'signOutBtn' ? btn : byId(id));
      ctx.window.addEventListener = (t, cb) => { (winOn[t] = winOn[t] || []).push(cb); };
      ctx.sessionStorage = {
        getItem: k => (session.has(k) ? session.get(k) : null),
        setItem: (k, v) => session.set(k, String(v)), removeItem: k => session.delete(k),
      };
      ctx.location.reload = () => { ctx.location.reloads = (ctx.location.reloads || 0) + 1; };
    },
  });
  const toasts = [];
  h.ctx.Utils.toast = (message, type) => toasts.push({ message, type });
  h.fireReady();
  await settle();
  const deletes = () => fetch.calls.filter(c => c.path === '/session' && c.method === 'DELETE').length;
  const fire = (t, ev) => (winOn[t] || []).forEach(cb => cb(ev));
  return { h, f: fetch, btn, toasts, session, deletes, fire, reloads: () => h.ctx.location.reloads || 0 };
}

console.log('\n-- 3. the header Sign Out button: success --');
{
  const s = await shell({ holdDelete: true });
  check('the shell is connected', s.h.ctx.Storage.mode, 'api');
  s.h.ctx.document.activeElement = s.btn;
  s.btn.dispatch('click');
  s.btn.dispatch('click');                       // an impatient second press
  await settle(5);
  ok('while it is in flight the button is disabled and marked busy',
    s.btn.disabled === true && s.btn.attrs['aria-busy'] === 'true', JSON.stringify(s.btn.attrs));
  check('   ...and keeps its icon (no "Saving…" text in an icon button)', s.btn.innerHTML.includes('<svg'), true);
  s.f.release();
  await settle();
  check('only one sign-out request was sent', s.deletes(), 1);
  check('on success the page reloads to the sign-in screen', s.reloads(), 1);
  check('   ...the tab remembers it is signed out', s.session.get('taqwa_shell_source'), 'locked');
  check('   ...the data read while signed in is gone', s.h.ctx.Storage.getData('customers'), []);
  check('   ...and no error was shown', s.toasts.filter(t => t.type === 'error').length, 0);
}

console.log('\n-- 3b. the header Sign Out button: failure --');
for (const [why, opts, detail] of [
  ['the server cannot be reached', { breakDelete: 'network' }, /Could not reach the server/],
  ['the server answers 500', { breakDelete: 500 }, /Something went wrong on the server/],
  ['the session survives', { keepSession: true }, /still reports this browser as signed in/],
]) {
  const s = await shell(opts);
  s.h.ctx.document.activeElement = s.btn;
  s.btn.dispatch('click');
  await settle();
  check(`${why}: no reload -- nothing is claimed`, s.reloads(), 0);
  const err = s.toasts.find(t => t.type === 'error') || {};
  ok('   ...the user is told they are still signed in', /still signed in/.test(err.message || ''), JSON.stringify(s.toasts));
  ok('   ...and why', detail.test(err.message || ''), err.message);
  ok('   ...the button is usable again, with its icon and focus',
    s.btn.disabled === false && !('aria-busy' in s.btn.attrs) && s.btn.innerHTML.includes('<svg') && s.btn.focused === 1,
    JSON.stringify({ disabled: s.btn.disabled, attrs: s.btn.attrs, focused: s.btn.focused }));
  check('   ...the app is still signed in with its data', [s.h.ctx.Storage.mode, s.h.ctx.Storage.getData('customers').length], ['api', 1]);
  // Retrying works once the server is back is the user's next move; a second
  // press must send a second request rather than be swallowed.
  s.btn.dispatch('click');
  await settle();
  check('   ...and pressing again tries again', s.deletes(), 2);
}

console.log('\n-- 3c. the profile menu\'s Sign Out --');
function menuClick(s, dataset) {
  const item = { dataset };
  s.h.ctx.document.getElementById('profileMenu').dispatch('click', { target: { closest: () => item } });
}
{
  const s = await shell();
  menuClick(s, { previewItem: 'Sign Out', signout: '' });
  await settle();
  check('connected: it signs out like the header button', [s.deletes(), s.reloads()], [1, 1]);
  check('   ...and no "design preview" notice', s.toasts.filter(t => /preview|not active/i.test(t.message)).length, 0);
}
{
  const s = await shell({ breakDelete: 'network' });
  menuClick(s, { previewItem: 'Sign Out', signout: '' });
  await settle();
  check('connected, server unreachable: no reload', s.reloads(), 0);
  ok('   ...and the user is told they are still signed in',
    s.toasts.some(t => t.type === 'error' && /still signed in/.test(t.message)), JSON.stringify(s.toasts));
}
{
  const s = await shell({ origin: '' });          // no server: browser storage only
  check('offline: the app is on browser storage', s.h.ctx.Storage.mode, 'local');
  menuClick(s, { previewItem: 'Sign Out', signout: '' });
  await settle();
  check('   ...Sign Out sends nothing and reloads nothing', [s.deletes(), s.reloads()], [0, 0]);
  ok('   ...and says there is no session to end',
    s.toasts.some(t => t.type === 'info' && /no session to sign out of/.test(t.message)), JSON.stringify(s.toasts));
}
{
  // A server is configured but did not answer this load: the browser may
  // still hold a live cookie, so Sign Out asks rather than says "no session".
  const s = await shell({ breakDelete: 'network', health: false });
  check('server configured but down: the app fell back to browser storage', s.h.ctx.Storage.mode, 'local');
  menuClick(s, { previewItem: 'Sign Out', signout: '' });
  await settle();
  check('   ...Sign Out still asks the server', s.deletes(), 1);
  ok('   ...and, unanswered, says the user is still signed in',
    s.reloads() === 0 && s.toasts.some(t => t.type === 'error' && /still signed in/.test(t.message)), JSON.stringify(s.toasts));
}
{
  // Pressed while the page is still loading: the mode is not settled yet,
  // and the press must still end the session, not be waved off.
  const s = await shell({ holdHealth: true });
  check('still loading: the mode is not settled', s.h.ctx.Storage.mode === 'api', false);
  s.btn.dispatch('click');
  await settle();
  check('   ...the header button still ends the session', [s.deletes(), s.reloads()], [1, 1]);
}
{
  const s = await shell();
  menuClick(s, { previewItem: 'Profile', previewHref: 'pages/profile.html' });
  await settle();
  check('Profile still navigates and does not sign out', [s.h.ctx.location.href, s.deletes()], ['pages/profile.html', 0]);
}
{
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'js', 'app.js'), 'utf8');
  ok('the menu no longer says Sign Out is "not active yet"', !/not active yet/.test(html), '');
  ok('the menu item is a real button reachable from the menu keyboard handling',
    /profileItem\('signout', 'Sign Out', [^)]*data-signout'\)/.test(html) && /role="menuitem"/.test(html), '');
}

/* ============================================================
   4. Back/forward cache
   ============================================================ */
console.log('\n-- 4. Back after leaving a signed-in page --');
{
  const s = await shell();
  s.fire('pagehide', { persisted: true });
  check('a signed-in page going into the back/forward cache is blanked', s.h.ctx.document.body.style.display, 'none');
  s.fire('pageshow', { persisted: true });
  check('   ...and reloaded if Back brings it out, so a fresh check decides what shows', s.reloads(), 1);
}
{
  const s = await shell();
  s.fire('pagehide', { persisted: false });
  s.fire('pageshow', { persisted: false });
  check('an ordinary unload or first show is left alone', [s.h.ctx.document.body.style.display, s.reloads()], [undefined, 0]);
}
{
  const s = await shell({ origin: '' });
  s.fire('pagehide', { persisted: true });
  s.fire('pageshow', { persisted: true });
  check('a browser-only page (no session) is left to the cache as before', [s.h.ctx.document.body.style.display, s.reloads()], [undefined, 0]);
}

process.exit(summary('Sign-out unit') === 0 ? 0 : 1);
})();
