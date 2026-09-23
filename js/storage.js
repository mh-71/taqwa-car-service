/* ============================================================
   storage.js — Centralized data layer for Taqwa Automobile SC
   ------------------------------------------------------------
   ALL persistence goes through this file. UI code never touches
   localStorage and never touches fetch(); it calls the same
   getData / getById / addData / updateData / deleteData it always
   has.

   ---- two sources, one interface ----

   MODE 'api'     the Worker + D1 are answering and this browser is
                  signed in. D1 is the source of truth for every
                  business record.
   MODE 'locked'  the Worker is answering but this browser has no
                  session. Nothing is read and nothing is cached;
                  the app shows a sign-in form.
   MODE 'local'   no backend is reachable at all. localStorage is
                  the source of truth, exactly as before this file
                  learned about the API.

   'locked' is deliberately NOT 'local'. Falling back to browser
   storage because the user has not signed in yet would hand them
   a private copy of an empty workshop and quietly accept writes
   into it -- which is the one thing this layer exists to prevent.

   The mode is decided once, by asking GET /api/health, and never
   flips underneath a running page. A page opened from disk, or
   with no Worker running, behaves precisely as it did before --
   that is the point: adding a backend must not take the app away
   from someone who does not have one.

   ---- why reads stayed synchronous ----

   256 call sites read through getData/getById, many of them inside
   .filter() and .map() callbacks that run per table row. Making
   them async would mean rewriting every UI module. So hydration
   pulls each collection ONCE into an in-memory cache before the
   first render, and the readers keep their signatures and read the
   cache. The network is crossed at startup, not per row.

   ---- why writes could not stay synchronous ----

   A write has to be told whether the server accepted it, and the
   server owns what the record becomes: its id, its totals, its
   balance, its stock. Guessing locally and reconciling later would
   mean showing the user a number the database never agreed to. So
   create/update/remove return promises, and the cache is updated
   from the RESPONSE -- never from what we sent.

   The old synchronous addData/updateData/deleteData remain, and in
   'local' mode they behave exactly as they always did. In 'api'
   mode they refuse rather than lie, because there is no honest
   synchronous answer to "did the server take this?".
   ============================================================ */

const Storage = (() => {
  const PREFIX = 'taqwa_';

  const COLLECTIONS = [
    'customers', 'vehicles', 'appointments', 'jobCards', 'services',
    'mechanics', 'parts', 'invoices', 'payments', 'expenses',
    'inventoryTransactions'   // stock movement audit trail (added with Inventory module)
  ];

  /**
   * Frontend collection name -> API path segment. The two differ only in
   * spelling (jobCards / job-cards), never in meaning, and this is the only
   * place that knows about the difference.
   */
  const API_PATHS = {
    customers: 'customers', vehicles: 'vehicles', appointments: 'appointments',
    jobCards: 'job-cards', services: 'services', mechanics: 'mechanics',
    parts: 'parts', invoices: 'invoices', payments: 'payments',
    expenses: 'expenses', inventoryTransactions: 'inventory-transactions'
  };

  /* ---------- mode ---------- */

  let mode = 'local';            // until hydrate() proves otherwise
  const isLocked = () => mode === 'locked';
  /**
   * Only 'local' reads and writes the browser store. 'locked' must not:
   * showing whatever this browser happened to have cached -- or seeded --
   * while refusing to talk to the database would be inventing a workshop.
   */
  const usesBrowserStore = () => mode === 'local';
  const cache = {};              // collection -> array, populated in 'api' mode
  let cachedSettings = null;     // the stored settings row in 'api' mode
  let hydration = null;          // the in-flight hydrate() promise

  const isApi = () => mode === 'api';

  /* ---------- low-level helpers ---------- */

  function read(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('Storage read failed:', key, e);
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('Storage write failed:', key, e);
      return false;
    }
  }

  /* ---------- public CRUD API (reads) ---------- */

  /** Get all records of a collection (always returns an array). */
  function getData(collection) {
    if (isApi()) return cache[collection] || [];
    if (usesBrowserStore()) return read(collection) || [];
    return [];                      // locked: nothing has been read, so nothing is shown
  }

  /** Overwrite an entire collection. localStorage only -- see seedIfEmpty. */
  function saveData(collection, records) {
    if (!usesBrowserStore()) return false;
    return write(collection, records);
  }

  /** Get one record by id. */
  function getById(collection, id) {
    return getData(collection).find(r => r.id === id) || null;
  }

  /* ---------- public CRUD API (legacy synchronous writes) ---------- */

  /**
   * The three synchronous writers the UI used before there was a backend.
   *
   * In 'local' mode they are unchanged, down to the returned value. In 'api'
   * mode there is no synchronous truth to return, so they refuse loudly
   * instead of writing to a localStorage nobody is reading -- a silent
   * success there is exactly the "localStorage and D1 silently diverge"
   * failure this layer exists to prevent.
   */
  /** A write attempted before signing in. Not a failure of the write. */
  const lockedRefusal = () => ({
    ok: false, code: 'unauthorized', message: 'Sign in to make changes.',
  });

  function refuseSync(name) {
    const message =
      `Storage.${name}() is synchronous and cannot be used against the API. ` +
      `Use Storage.${{ addData: 'create', updateData: 'update', deleteData: 'remove' }[name]}() instead.`;
    console.error(message);
    throw new Error(message);
  }

  /** Insert a new record. Assigns id + createdAt if missing. Returns the record. */
  function addData(collection, record) {
    if (!usesBrowserStore()) return refuseSync('addData');
    const records = getData(collection);
    if (!record.id) record.id = generateId(collection);
    if (!record.createdAt) record.createdAt = new Date().toISOString();
    records.push(record);
    saveData(collection, records);
    return record;
  }

  /** Merge changes into an existing record by id. Returns updated record or null. */
  function updateData(collection, id, changes) {
    if (!usesBrowserStore()) return refuseSync('updateData');
    const records = getData(collection);
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return null;
    records[idx] = { ...records[idx], ...changes, updatedAt: new Date().toISOString() };
    saveData(collection, records);
    return records[idx];
  }

  /** Delete a record by id. Returns true if something was removed. */
  function deleteData(collection, id) {
    if (!usesBrowserStore()) return refuseSync('deleteData');
    const records = getData(collection);
    const next = records.filter(r => r.id !== id);
    if (next.length === records.length) return false;
    saveData(collection, next);
    return true;
  }

  /* ---------- cache maintenance ----------

     Every one of these takes the record the SERVER returned. Nothing here
     computes a total, a balance or a stock level: if the server changed
     something we did not send, the response is what says so.            */

  function cachePut(collection, record) {
    if (!record || !record.id) return record;
    const list = cache[collection] || (cache[collection] = []);
    const idx = list.findIndex(r => r.id === record.id);
    if (idx === -1) list.unshift(record); else list[idx] = record;
    return record;
  }

  function cacheDrop(collection, id) {
    const list = cache[collection];
    if (!list) return false;
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    return true;
  }

  /* ---------- public CRUD API (asynchronous writes) ---------- */

  /**
   * The three writers that can talk to a server.
   *
   * Each resolves to { ok: true, record } or { ok: false, code, message,
   * fields? } -- never throws, never rejects. In 'local' mode they wrap the
   * synchronous writers so a caller can use one shape everywhere.
   */
  async function create(collection, record) {
    if (isLocked()) return lockedRefusal();
    if (!isApi()) {
      const saved = addData(collection, record);
      return { ok: true, record: saved };
    }
    const res = await Api.post(`/${API_PATHS[collection]}`, record);
    if (!res.ok) return res;
    return { ok: true, record: cachePut(collection, res.data) };
  }

  async function update(collection, id, changes) {
    if (isLocked()) return lockedRefusal();
    if (!isApi()) {
      const saved = updateData(collection, id, changes);
      return saved
        ? { ok: true, record: saved }
        : { ok: false, code: 'not_found', message: 'That record no longer exists.' };
    }
    const res = await Api.put(`/${API_PATHS[collection]}/${id}`, changes);
    if (!res.ok) return res;
    return { ok: true, record: cachePut(collection, res.data) };
  }

  async function remove(collection, id) {
    if (isLocked()) return lockedRefusal();
    if (!isApi()) {
      const gone = deleteData(collection, id);
      return gone
        ? { ok: true }
        : { ok: false, code: 'not_found', message: 'That record no longer exists.' };
    }
    const res = await Api.delete(`/${API_PATHS[collection]}/${id}`);
    if (!res.ok) return res;
    cacheDrop(collection, id);
    return { ok: true };
  }

  /**
   * POST /api/<collection>/<id>/<action> -- a business operation rather than
   * a field change: a job card's status, voiding an invoice, voiding or
   * linking a payment. These move several tables in one transaction, so the
   * server's answer is the only thing that knows what changed; `refresh`
   * names the collections to re-read afterwards.
   */
  async function action(collection, id, name, body = {}, refresh = []) {
    if (isLocked()) return lockedRefusal();
    if (!isApi()) {
      return { ok: false, code: 'no_api', message: 'This action needs the backend.' };
    }
    const res = await Api.post(`/${API_PATHS[collection]}/${id}/${name}`, body);
    if (!res.ok) return res;
    if (res.data && res.data.id) cachePut(collection, res.data);
    const stale = await refreshAll(...refresh);
    return { ok: true, record: res.data, ...(stale.length ? { stale } : {}) };
  }

  /* ---------- id generation ---------- */

  const ID_PREFIXES = {
    customers: 'CUS', vehicles: 'VEH', appointments: 'APT', jobCards: 'JOB',
    services: 'SRV', mechanics: 'MEC', parts: 'PRT', invoices: 'INV',
    payments: 'PAY', expenses: 'EXP', inventoryTransactions: 'STK'
  };

  /**
   * Sequential, human-readable ids like JOB-0007.
   *
   * 'local' mode only. In 'api' mode the server allocates from its own
   * id_counters table inside the same transaction as the insert, and the id
   * it chose comes back on the created record -- two counters handing out
   * the same number is precisely what that avoids.
   */
  function generateId(collection) {
    const prefix = ID_PREFIXES[collection] || 'REC';
    const counters = read('counters') || {};
    counters[collection] = (counters[collection] || 0) + 1;
    write('counters', counters);
    return `${prefix}-${String(counters[collection]).padStart(4, '0')}`;
  }

  /* ---------- settings ---------- */

  const DEFAULT_SETTINGS = {
    businessName: 'Taqwa Automobile Service Center',
    phone: '+880 1XXX-XXXXXX',
    email: 'info@taqwaauto.com',
    website: '',
    taxId: '',
    address: 'Sector #15, Block #C, Road #3/A, Plot #40, Diabari, Uttara, Dhaka',
    businessDescription: '',
    invoiceFooter: 'Thank you for servicing with Taqwa Automobile Service Center.',
    paymentTerms: '',
    taxRate: 5,
    currency: '৳',
    // Workshop-profile reference info only -- not read or enforced by
    // Appointments or Job Cards. Stored here so it can be recorded and
    // shown, without touching those modules' logic (see settings.js).
    defaultAppointmentDuration: 60,
    openingTime: '',
    closingTime: '',
    workingDays: []
  };

  /**
   * These are the BROWSER's display defaults, applied on top of whatever is
   * stored so a field the shop has never filled in still renders something.
   * They are not the database's defaults and are never sent to it: a PUT
   * carries only the fields the form actually holds.
   */
  function getSettings() {
    const stored = isApi() ? cachedSettings
      : usesBrowserStore() ? read('settings')
      : null;                       // locked: the browser's display defaults only
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  }

  /** Synchronous save -- 'local' mode only, kept for the offline path. */
  function saveSettings(settings) {
    if (!usesBrowserStore()) return refuseSync('saveSettings');
    return write('settings', { ...getSettings(), ...settings });
  }

  /**
   * PUT /api/settings merges: only the keys sent are changed. That is the
   * same contract saveSettings() has always had, so the form can keep
   * submitting exactly the fields it renders.
   */
  async function putSettings(settings) {
    if (isLocked()) return lockedRefusal();
    if (!isApi()) {
      return saveSettings(settings)
        ? { ok: true, record: getSettings() }
        : { ok: false, code: 'write_failed', message: 'Could not save settings.' };
    }
    const res = await Api.put('/settings', settings);
    if (!res.ok) return res;
    cachedSettings = res.data;
    return { ok: true, record: getSettings() };
  }

  /* ---------- theme ----------

     Browser-local on purpose, in both modes. A theme is a preference of the
     device looking at the data, not a property of the workshop: putting it
     in D1 would make one person's dark mode everybody's. The <head> of every
     page reads this same key directly to set the theme before first paint. */

  function getTheme() { return read('theme') || 'light'; }
  function saveTheme(theme) { write('theme', theme); }

  /* ---------- seed data (first run only) ---------- */

  function isSeeded() { return read('seeded') === true; }

  /**
   * Demo data, for a browser that has never run this app. Never in 'api'
   * mode: the database is the source of truth, an empty one is a legitimate
   * state (a new workshop), and POSTing fifty invented records into it
   * because it looked empty would be the worst kind of helpful.
   */
  function seedIfEmpty() {
    if (!usesBrowserStore()) return;
    if (isSeeded()) return;
    SeedData.load({ addData, saveData });
    write('seeded', true);
  }

  /**
   * Wipes every business collection and counter, then reloads the original
   * demo dataset -- the symmetric opposite of seedIfEmpty(). Settings and
   * theme are deliberately left untouched: this resets DEMO DATA, not the
   * shop's own configured Settings. Used only by Settings' "Reset to Seed
   * Data" action, which gates this behind a strong typed confirmation.
   *
   * Refused in 'api' mode. The API has no seed or reset endpoint, and
   * emptying a real database from a browser button is not something this
   * layer will improvise.
   */
  function resetToSeedData() {
    if (!usesBrowserStore()) return false;
    COLLECTIONS.forEach(c => write(c, []));
    write('counters', {});
    write('seeded', false);
    SeedData.load({ addData, saveData });
    write('seeded', true);
    return true;
  }

  /* ---------- hydration ---------- */

  /**
   * Read one collection completely.
   *
   * The list endpoint caps a page at 1000 rows and reports the true total,
   * so this follows the offset until it has them all rather than quietly
   * rendering the first page as if it were the whole table.
   */
  async function fetchAll(collection) {
    const path = `/${API_PATHS[collection]}`;
    const rows = [];
    let offset = 0;
    for (;;) {
      const res = await Api.get(`${path}?limit=1000&offset=${offset}`);
      if (!res.ok) return res;
      const page = Array.isArray(res.data) ? res.data : [];
      rows.push(...page);
      const total = Number(res.meta && res.meta.count);
      if (!page.length || !Number.isFinite(total) || rows.length >= total) break;
      offset += page.length;
    }
    return { ok: true, rows };
  }

  /**
   * Fetch website bookings from the website API and convert them to dashboard format.
   * Website bookings are merged with local appointments for a unified view.
   */
  async function fetchWebsiteBookings() {
    try {
      const response = await fetch('https://taqwa.blinto.workers.dev/api/bookings/list');
      if (!response.ok) return { ok: false, rows: [] };

      const data = await response.json();
      const bookings = Array.isArray(data.bookings) ? data.bookings : [];

      // Convert website bookings to dashboard appointment format
      return {
        ok: true,
        rows: bookings.map(b => ({
          id: `web_${b.id}`,              // Prefix to avoid collision with local IDs
          customerId: b.customer_name,     // Fallback: name instead of ID
          vehicleId: b.vehicle_type,       // Fallback: type instead of ID
          serviceId: b.service_type,       // Fallback: service name instead of ID
          mechanicId: null,                // No mechanic assigned yet
          jobCardId: null,                 // No job card linked
          date: b.preferred_date,
          time: b.preferred_time || '09:00',
          duration: 60,                    // Default duration
          status: 'Scheduled',             // Map website status to dashboard status
          source: 'Website',               // Source identifier
          complaint: `Email: ${b.customer_email}\nPhone: ${b.customer_phone}`,
          notes: `Website booking #${b.id}`,
          reminderSent: false,
          createdAt: b.created_at,
        }))
      };
    } catch (error) {
      console.error('Error fetching website bookings:', error);
      return { ok: false, rows: [] };
    }
  }

  /**
   * Re-read several collections the server also changed, and return the names
   * of any that could NOT be re-read.
   *
   * A failure here is not a failed write -- the write already succeeded. It
   * means the screen may now be showing a figure the database has moved on
   * from, which is worth saying out loud: silently keeping the old rows is
   * how a paid invoice goes on displaying its old balance.
   */
  async function refreshAll(...names) {
    const stale = [];
    for (const name of names) {
      const res = await reload(name);
      if (!res.ok) stale.push(name);
    }
    return stale;
  }

  /** Re-read one collection from the server. Used after a transaction. */
  async function reload(collection) {
    if (!isApi()) return { ok: false, code: 'no_api' };
    const res = await fetchAll(collection);
    if (!res.ok) return res;
    cache[collection] = res.rows;
    return { ok: true };
  }

  /**
   * Decide the mode and, if there is a backend, fill the cache before the
   * first render.
   *
   * A failure at any point leaves the mode at 'local'. That is the
   * conservative direction: a half-filled cache rendered as if it were the
   * database would show the user records that do not exist and hide records
   * that do.
   */
  let settled = false;   // the mode is decided and the cache, if any, is filled
  let outcome = null;    // what hydrate() decided, once it has

  function hydrate() {
    if (hydration) return hydration;

    // No API to ask means the answer is already known, and knowing it
    // WITHOUT a promise is what keeps a browser with no backend rendering in
    // a single tick -- exactly as it did when this file only knew about
    // localStorage. A page opened from disk must not wait on a microtask to
    // draw its first table.
    if (!Api.baseUrl) {
      settled = true;
      outcome = { mode: 'local', reason: 'no_api' };
      hydration = Promise.resolve(outcome);
      return hydration;
    }

    hydration = (async () => {
      const probe = await Api.probe();
      if (!probe.ok) return { mode: 'local', reason: probe.code };

      // The Worker is up. Are we allowed to read it? Asking /api/session is
      // how that is answered without firing eleven requests that would all
      // come back 401.
      const who = await Api.session();
      if (!who.ok) return { mode: 'local', reason: who.code || 'network_error' };
      if (!who.authenticated) {
        mode = 'locked';
        return { mode: 'locked', canSignIn: who.passphrase };
      }

      const results = await Promise.all(COLLECTIONS.map(fetchAll));
      const failed = results.findIndex(r => !r.ok);
      if (failed !== -1) {
        const why = results[failed].code;
        // A session that expired between the check above and the read is an
        // authentication problem, not an offline one: locking is honest,
        // falling back to browser storage would not be.
        if (why === 'unauthorized') {
          mode = 'locked';
          return { mode: 'locked', canSignIn: true };
        }
        return { mode: 'local', reason: why, collection: COLLECTIONS[failed] };
      }
      COLLECTIONS.forEach((c, i) => { cache[c] = results[i].rows; });

      // Fetch and merge website bookings with local appointments
      const websiteBookings = await fetchWebsiteBookings();
      if (websiteBookings.ok && websiteBookings.rows.length) {
        cache.appointments = [...cache.appointments, ...websiteBookings.rows];
      }

      // A settings row need not exist yet; 404 is a legitimate answer that
      // leaves the browser's own display defaults showing.
      const settings = await Api.get('/settings');
      cachedSettings = settings.ok ? settings.data : null;

      mode = 'api';
      return { mode: 'api', counts: Object.fromEntries(COLLECTIONS.map(c => [c, cache[c].length])) };
    })().then(result => { settled = true; outcome = result; return result; });
    return hydration;
  }

  /* ---------- signing in and out ---------- */

  /**
   * Sign in, then fill the cache.
   *
   * The hydration promise is reset first: the previous one resolved to
   * 'locked', and a caller asking whether the app is ready must not be
   * handed that stale answer once the session exists.
   */
  async function signIn(passphrase) {
    const res = await Api.login(passphrase);
    if (!res.ok) return res;
    hydration = null;
    settled = false;
    outcome = null;
    readiness = null;
    const result = await hydrate();
    return result.mode === 'api'
      ? { ok: true, result }
      : { ok: false, code: 'hydrate_failed',
          message: 'Signed in, but the workshop data could not be loaded.' };
  }

  /**
   * Sign out and forget everything read while signed in.
   *
   * Emptying the cache matters: the next person at this screen must not be
   * able to read the last one's customer list out of a stale render.
   */
  async function signOut() {
    const res = await Api.logout();
    COLLECTIONS.forEach(c => { delete cache[c]; });
    cachedSettings = null;
    mode = 'locked';
    hydration = null;
    settled = false;
    outcome = null;
    readiness = null;
    return res;
  }

  /* ---------- readiness ----------

     Page modules used to render on DOMContentLoaded. Hydration cannot
     finish by then, so they wait on this instead: it resolves once the DOM
     is parsed AND the mode is settled, in either mode.                    */

  function domReady() {
    if (typeof document === 'undefined') return Promise.resolve();
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise(res => document.addEventListener('DOMContentLoaded', res, { once: true }));
  }

  let readiness = null;
  function whenReady() {
    if (!readiness) readiness = Promise.all([domReady(), hydrate()]).then(([, h]) => h);
    return readiness;
  }

  /**
   * The page-module entry point, in place of a DOMContentLoaded listener:
   *
   *     Storage.ready(() => { bindEvents(); renderList(); });
   *
   * It runs `fn` once the DOM is parsed AND the data source is settled. When
   * there is no backend, settling needs no network and `fn` runs inside the
   * DOMContentLoaded handler itself -- the same tick a listener would have
   * had. When there is one, `fn` waits for the cache to be filled, so no
   * module ever renders an empty table it would then have to re-render.
   */
  function ready(fn) {
    const hydrated = hydrate();

    // `fn` receives what hydrate() decided -- which source is live and, when
    // it is not the expected one, why. Callers that do not care simply
    // ignore the argument.
    const run = () => {
      if (settled) {
        try { fn(outcome); } catch (e) { console.error('Page initialisation failed:', e); }
        return;
      }
      hydrated.then(result => fn(result))
        .catch(e => console.error('Page initialisation failed:', e));
    };

    if (typeof document === 'undefined' || document.readyState !== 'loading') { run(); return; }
    document.addEventListener('DOMContentLoaded', run, { once: true });
  }

  return {
    COLLECTIONS,
    getData, saveData, getById, addData, updateData, deleteData,
    create, update, remove, action, reload, refreshAll,
    generateId, getSettings, saveSettings, putSettings, getTheme, saveTheme,
    seedIfEmpty, resetToSeedData,
    hydrate, whenReady, ready, signIn, signOut,
    get mode() { return mode; },
    isApi, isLocked
  };
})();

/* Node's test harness loads this file as a script; the browser does not. */
if (typeof module !== 'undefined' && module.exports) module.exports = { Storage };
