/* navigation-loading — the blank screen on every sidebar click.

   Every page is a full document load, and with a backend the data must be
   fetched before any module can render. Two things made that wait a blank
   screen, and these are the regressions guarded here:

   1. The shell (sidebar, header, content area) was only drawn AFTER the
      data arrived -- so for the whole wait there was nothing on screen but
      page background. app.js must draw it as soon as it runs, show only a
      neutral placeholder in the content area, finish the source-dependent
      parts once the data is in, and reveal the page only after its module
      has rendered it.
   2. The data took five strictly sequential round trips. Requests that do
      not depend on each other's answers must go out together: two rounds.
      The decisions taken on the answers must not change.

   Drives the REAL js/app.js and js/storage.js through the harness. */
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const API = 'http://localhost:8787';
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/* A page with an early shell in it: querySelector finds the pieces app.js
   looks for once the shell has been prepended, and records what it does. */
function pageWithShell() {
  const log = [];
  const parts = {};
  const beforeModules = (doc) => {
    let drawn = false;
    const prepend = doc.body.prepend;
    doc.body.prepend = function (el) { drawn = true; prepend.call(this, el); };
    const skeleton = Object.assign(makeElement('skeleton'), { remove() { log.push('skeleton removed'); } });
    const classes = new Set(['shell', 'is-pending']);
    parts.shell = Object.assign(makeElement('shell'), {
      classList: {
        add(c) { classes.add(c); log.push(`+${c}`); },
        remove(c) { classes.delete(c); log.push(`-${c}`); },
        contains(c) { return classes.has(c); },
        toggle() {},
      },
      querySelector(sel) { return sel === '.content-skeleton' ? skeleton : null; },
    });
    parts.classes = classes;
    parts.user = Object.assign(makeElement('user'), {
      insertAdjacentHTML(where, html) { log.push(`insert ${where}`); parts.inserted = html; },
    });
    parts.tagline = makeElement('tagline');
    doc.querySelector = (sel) => {
      if (!drawn) return null;
      return { '.shell': parts.shell, '.topbar__user': parts.user,
               '.topbar__user-text span': parts.tagline }[sel] || null;
    };
    // Elements built with innerHTML (the sign-in screen) find their parts.
    const create = doc.createElement;
    doc.createElement = (tag) => Object.assign(create(tag), { querySelector: () => makeElement('part') });
    // The sign-out button exists if the early shell drew it (and nothing has
    // removed it since), or once completeShell() has inserted it.
    parts.signOut = Object.assign(makeElement('signOutBtn'), { remove() { parts.signOutRemoved = true; log.push('sign-out removed'); } });
    const byId = doc.getElementById;
    doc.getElementById = (id) => {
      if (id !== 'signOutBtn') return byId(id);
      const drawn = /id="signOutBtn"/.test(doc.body._lastShellHtml || '') && !parts.signOutRemoved;
      return drawn || parts.inserted ? parts.signOut : null;
    };
  };
  return { log, parts, beforeModules };
}

/* fetch whose answers are held until the test releases them, so the rounds
   of requests can be counted. */
function heldFetch(api) {
  const pending = [];
  const calls = [];
  const fetch = (url, init) => new Promise(resolve => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    calls.push(path);
    pending.push({ url: String(url), init, resolve, path });
  });
  async function releaseAll() {
    const batch = pending.splice(0);
    for (const p of batch) {
      if (p.path === '/api/website-bookings') {
        p.resolve({ ok: true, status: 200, json: async () => ({ bookings: [] }) });
      } else {
        p.resolve(await api(p.url, p.init));
      }
    }
    await tick(5);
    return batch.map(p => p.path);
  }
  return { fetch, calls, pending, releaseAll };
}

console.log('=== navigation-loading: no blank screen while the data loads ===\n');

(async () => {

/* ============================================================
   1. The shell is drawn before the data arrives
   ============================================================ */
console.log('-- 1. the shell goes up before hydration finishes --');
{
  // A backend that never answers: everything visible now was drawn without data.
  const h = boot({ modules: ['js/app.js'], origin: API, fetch: () => new Promise(() => {}) });
  const html = h.ctx.document.body._lastShellHtml || '';
  ok('with a backend, the shell is drawn as soon as app.js runs', html.length > 0, 'nothing was drawn');
  check('   ...with every sidebar link', (html.match(/class="nav__link/g) || []).length, 13);
  ok('   ...and the header (title, theme toggle, avatar)',
    /topbar__title/.test(html) && /id="themeToggle"/.test(html) && /class="avatar"/.test(html), '');
  ok('   ...and a placeholder in the content area instead of a blank sheet',
    /class="content-skeleton"/.test(html), 'no skeleton');
  const sk = (html.match(/<div class="content-skeleton"[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  ok('   ...which holds no invented data (no text, digits or currency)',
    sk && !/[0-9৳]/.test(sk.replace(/<[^>]+>/g, '')) && sk.replace(/<[^>]+>/g, '').trim() === '', sk);
  ok('   ...hidden from screen readers', /content-skeleton" aria-hidden="true"/.test(html), '');
  ok('on a first page the footer says it is connecting -- not a false "This browser only"',
    /Connecting/.test(html) && !/This browser only/.test(html), html.slice(html.indexOf('dataSource'), html.indexOf('dataSource') + 200));
  ok('   ...and the sign-out button is already in the header, so the buttons do not shift when the data lands',
    /id="signOutBtn"/.test(html), 'sign-out missing from the early shell');
}
{
  // The previous page of this tab was connected: the footer holds still.
  const store = new Map([['taqwa_shell_source', 'api']]);
  const h = boot({ modules: ['js/app.js'], origin: API, fetch: () => new Promise(() => {}),
                   beforeModules: (doc, ctx) => { ctx.sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }; } });
  const html = h.ctx.document.body._lastShellHtml || '';
  ok('after a connected page, the early footer repeats "Connected to the database"',
    /Connected to the database/.test(html) && !/Connecting/.test(html), html.slice(html.indexOf('dataSource'), html.indexOf('dataSource') + 200));
}
{
  // ...but not after an offline one: no sign-out button is promised.
  const store = new Map([['taqwa_shell_source', 'local']]);
  const h = boot({ modules: ['js/app.js'], origin: API, fetch: () => new Promise(() => {}),
                   beforeModules: (doc, ctx) => { ctx.sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }; } });
  const html = h.ctx.document.body._lastShellHtml || '';
  ok('after an offline page, no early sign-out button and no claim to be connected',
    !/signOutBtn/.test(html) && /Connecting/.test(html), html.slice(html.indexOf('dataSource'), html.indexOf('dataSource') + 200));
}
{
  const h = boot({ modules: ['js/app.js'], origin: '' });     // no backend at all
  check('with no backend there is no wait, and no early shell', h.ctx.document.body._lastShellHtml, undefined);
  h.fireReady();
  await tick(5);
  const html = h.ctx.document.body._lastShellHtml || '';
  ok('   ...the shell is drawn as before, in the same tick', /class="nav__link/.test(html), '');
  ok('   ...without a placeholder', !/content-skeleton/.test(html), '');
}

/* ============================================================
   2. The early shell is completed, then revealed AFTER the page renders
   ============================================================ */
console.log('\n-- 2. completing the early shell --');
{
  const p = pageWithShell();
  const h = boot({ modules: ['js/app.js'], origin: API, beforeModules: p.beforeModules,
                   fetch: fakeApi({ rows: { customers: [{ id: 'CUS-0001', name: 'Rahim' }] } }) });
  // A page module registers after app.js, exactly as the real pages do.
  h.ctx.Storage.ready(() => p.log.push('module rendered'));
  const drawnBefore = h.ctx.document.body._lastShellHtml;
  h.fireReady();
  await tick(40);
  check('the app is on the database', h.ctx.Storage.mode, 'api');
  check('   ...and the shell was not drawn a second time', h.ctx.document.body._lastShellHtml, drawnBefore);
  const foot = h.els.get('dataSource');
  ok('the footer is updated in place to say so',
    foot && /Connected to the database/.test(foot.innerHTML) && !/sidebar__foot-dot--(local|pending)/.test(foot.innerHTML),
    foot && foot.innerHTML);
  ok('   ...the sign-out button drawn early is kept, and not added a second time',
    /id="signOutBtn"/.test(drawnBefore) && !p.parts.inserted && !p.parts.signOutRemoved, JSON.stringify(p.log));
  check('   ...and the business name filled in', p.parts.tagline.textContent, 'Taqwa ASC');
  const iModule = p.log.indexOf('module rendered'), iReveal = p.log.indexOf('-is-pending');
  ok('the content is revealed only AFTER the page module has rendered it',
    iModule !== -1 && iReveal > iModule, JSON.stringify(p.log));
  ok('   ...and the placeholder is removed as it is', p.log.indexOf('skeleton removed') !== -1
    && p.log.indexOf('skeleton removed') < p.log.indexOf('+is-revealed'), JSON.stringify(p.log));
}
{
  // The server is up but this browser is not signed in.
  const p = pageWithShell();
  const h = boot({ modules: ['js/app.js'], origin: API, beforeModules: p.beforeModules,
                   fetch: fakeApi({ authenticated: false }) });
  h.fireReady();
  await tick(40);
  check('signed out: the app is locked', h.ctx.Storage.mode, 'locked');
  check('   ...the shell behind the sign-in screen is inert', p.parts.shell.inert, true);
  ok('   ...and its content is never revealed', p.parts.classes.has('is-pending') && !p.log.includes('-is-pending'),
    JSON.stringify(p.log));
}
{
  // A failed load is shown as one, not hidden behind the placeholder.
  const p = pageWithShell();
  const toasts = [];
  const h = boot({ modules: ['js/app.js'], origin: API, beforeModules: p.beforeModules,
                   fetch: async () => { throw new Error('connection refused'); } });
  h.ctx.Utils.toast = (message, type) => toasts.push({ message, type });
  h.fireReady();
  await tick(40);
  check('server down: the app falls back to this browser', h.ctx.Storage.mode, 'local');
  ok('   ...the footer says so', /This browser only/.test((h.els.get('dataSource') || {}).innerHTML || '')
    && /sidebar__foot-dot--local/.test(h.els.get('dataSource').innerHTML), '');
  ok('   ...the warning is still raised', toasts.length === 1 && toasts[0].type === 'warning', JSON.stringify(toasts));
  ok('   ...and the early sign-out button is taken away: there is no session to end', p.parts.signOutRemoved === true, JSON.stringify(p.log));
  ok('   ...and the page is revealed rather than left on the placeholder', p.log.includes('-is-pending'), JSON.stringify(p.log));
}

/* ============================================================
   3. Two rounds of requests, not five
   ============================================================ */
console.log('\n-- 3. round trips per page load --');
{
  const held = heldFetch(fakeApi({ rows: { customers: [{ id: 'CUS-0001', name: 'Rahim' }] },
                                   settings: { businessName: 'Taqwa Automobile Service Center' } }));
  const h = boot({ origin: API, fetch: held.fetch });
  const done = h.ctx.Storage.hydrate();
  await tick(5);
  const round1 = held.calls.slice();
  ok('round 1 asks health AND session together', round1.includes('/api/health') && round1.includes('/api/session'),
    JSON.stringify(round1));
  ok('   ...and no business data yet', !round1.some(c => /customers|settings|bookings/.test(c)), JSON.stringify(round1));
  await held.releaseAll();
  const round2 = held.pending.map(p => p.path);
  ok('round 2 asks every collection, website bookings AND settings together',
    round2.includes('/api/customers') && round2.includes('/api/inventory-transactions')
    && round2.includes('/api/website-bookings') && round2.includes('/api/settings'), JSON.stringify(round2));
  await held.releaseAll();
  let rounds = 2;
  while (held.pending.length) { await held.releaseAll(); rounds++; }
  const result = await done;
  check('hydration completes in 2 rounds', rounds, 2);
  check('   ...on the database', result.mode, 'api');
  check('   ...with its rows', h.ctx.Storage.getData('customers').map(c => c.name), ['Rahim']);
  check('   ...and its settings', h.ctx.Storage.getSettings().businessName, 'Taqwa Automobile Service Center');
  check('   ...with no request sent twice', held.calls.length, new Set(held.calls).size);
}
{
  // The decisions are unchanged: a Worker that is down is offline, even if a
  // session answer came back alongside.
  const h = boot({ origin: API, fetch: fakeApi({ health: false, authenticated: false }) });
  const res = await h.ctx.Storage.hydrate();
  check('health fails: local, whatever the session said', [res.mode, res.reason], ['local', 'no_database']);
}
{
  const f = fakeApi({ authenticated: false });
  const h = boot({ origin: API, fetch: f });
  const res = await h.ctx.Storage.hydrate();
  check('signed out: locked', res.mode, 'locked');
  ok('   ...and not one business request was fired into the 401',
    !f.calls.some(c => /^\/(customers|job-cards|settings|parts)/.test(c.path)), JSON.stringify(f.calls.map(c => c.path)));
}
{
  // A collection fails part-way: nothing fetched alongside it may be kept.
  const inner = fakeApi({ rows: { customers: [{ id: 'CUS-0001' }] }, settings: { businessName: 'From The API' } });
  const flaky = async (url, init) => (/\/invoices/.test(String(url)) ? Promise.reject(new Error('down')) : inner(url, init));
  const h = boot({ origin: API, fetch: flaky });
  const res = await h.ctx.Storage.hydrate();
  check('a collection fails: local, naming it', [res.mode, res.collection], ['local', 'invoices']);
  ok('   ...and the settings fetched alongside are NOT applied',
    h.ctx.Storage.getSettings().businessName !== 'From The API', h.ctx.Storage.getSettings().businessName);
}

process.exit(summary('Navigation loading unit') === 0 ? 0 : 1);
})();
