/* ============================================================
   staff-roles.js — Staff Management › Roles & Permissions
   ------------------------------------------------------------
   What each role can do, read from the Worker -- never an example.

   Source of truth:
     - The areas and actions come from the routes the Worker really
       serves: GET /api/health lists them (it is public and reads no
       business data). An area or an action the app does not have is
       shown as not existing, rather than as "not allowed".
     - The roles are the ones the Worker accepts (src/lib/accounts.js
       ACCOUNT_ROLES): only 'Administrator', with full access, because
       nothing in the API restricts a signed-in caller by role.
     - Who holds each role comes from GET /api/accounts, which the Worker
       answers only for an administrator. Anyone else sees the roles and
       their permissions, and is told why the numbers are missing.

   Read-only. Nothing here changes who may do what: "Edit permissions"
   only explains why it is not available. The one rule the server checks
   by role -- only an administrator manages user accounts -- is shown as
   such; every other area is open to anyone signed in, and says so.
   ============================================================ */

const StaffRoles = (() => {

  const { esc } = Utils;

  // The roles the Worker accepts (src/lib/accounts.js ACCOUNT_ROLES).
  const ROLES = [{
    name: 'Administrator',
    description: 'Full access to every part of the app, including user accounts and settings.',
    notes: [
      'Every user account has this role. The shared workshop passphrase gives the same access.',
      'Only an administrator can create accounts, switch them on or off, or set a new password (checked by the server).',
      'At least one active administrator account must always remain (checked by the server).',
    ],
  }];

  // The areas the server allows only to an administrator (src/routes/accounts.js isAdmin).
  const ADMIN_ONLY = ['accounts'];

  // Names for the Worker's collections, in the order the sidebar shows them. A collection
  // missing here still appears (named from its path), so a new route is never hidden.
  const AREAS = [
    ['customers', 'Customers'], ['vehicles', 'Vehicles'], ['appointments', 'Appointments'],
    ['job-cards', 'Job Cards'], ['estimates', 'Estimates & Quotations'], ['services', 'Services'],
    ['parts', 'Inventory: Parts'], ['inventory-transactions', 'Inventory: Stock Movements'],
    ['invoices', 'Invoices'], ['invoice-adjustments', 'Invoice Adjustments'], ['payments', 'Payments'],
    ['expenses', 'Expenses'], ['follow-ups', 'CRM: Follow-ups'], ['follow-up-contacts', 'CRM: Contact Log'],
    ['follow-up-tasks', 'CRM: Tasks'], ['mechanics', 'Mechanics'], ['staff', 'Staff'],
    ['accounts', 'User Accounts'], ['settings', 'Settings'],
  ];
  const ACTION_NAMES = {
    status: 'Change status', void: 'Void', link: 'Link to invoice', complete: 'Complete', cancel: 'Cancel',
    contact: 'Log contact', start: 'Start', send: 'Send', approve: 'Approve', reject: 'Reject',
    convert: 'Convert to job card', password: 'Set new password',
  };
  // Signing in and the health check are open to everyone by design; they are not an area of the app.
  const PUBLIC = ['health', 'session'];
  const OPS = [['view', 'View'], ['create', 'Create'], ['edit', 'Edit'], ['remove', 'Delete']];
  const COLS = 7;

  const svg = d => `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    yes: svg('M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z'),
    no: svg('M19 13H5v-2h14v2z'),
    alert: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  };

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  const titleCase = key => String(key).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  /**
   * The areas of the app and what can be done in each, from the Worker's route list
   * ("GET /api/customers", "POST /api/job-cards/:id/status", ...). Unknown or malformed
   * entries are ignored; public routes are left out.
   */
  function capabilities(routes) {
    const found = new Map();
    for (const r of Array.isArray(routes) ? routes : []) {
      const m = /^(GET|POST|PUT|DELETE) \/api\/([a-z-]+)(\/:id(?:\/([a-z-]+))?)?$/.exec(String(r));
      if (!m) continue;
      const [, method, key, detail, action] = m;
      if (PUBLIC.includes(key)) continue;
      if (!found.has(key)) found.set(key, { key, view: false, create: false, edit: false, remove: false, actions: [] });
      const area = found.get(key);
      if (action) { if (method === 'POST' && !area.actions.includes(action)) area.actions.push(action); }
      else if (method === 'GET') area.view = true;
      else if (method === 'POST' && !detail) area.create = true;
      else if (method === 'PUT') area.edit = true;
      else if (method === 'DELETE' && detail) area.remove = true;
    }
    const order = AREAS.map(([k]) => k);
    const rank = k => (order.includes(k) ? order.indexOf(k) : order.length);
    return [...found.values()]
      .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
      .map(a => ({
        ...a,
        label: (AREAS.find(([k]) => k === a.key) || [])[1] || titleCase(a.key),
        actionLabels: a.actions.map(x => ACTION_NAMES[x] || titleCase(x)),
        adminOnly: ADMIN_ONLY.includes(a.key),
      }));
  }

  /** How many accounts hold a role, and how many of those can sign in. */
  function members(accounts, role) {
    const mine = (Array.isArray(accounts) ? accounts : []).filter(a => a && a.role === role);
    return { total: mine.length, active: mine.filter(a => a.status === 'Active').length };
  }

  function membersText(m) {
    if (!m) return '';
    const word = m.total === 1 ? 'account' : 'accounts';
    return m.total === m.active ? `${m.total} ${word}` : `${m.total} ${word} (${m.active} active)`;
  }

  /* ---------- markup ---------- */

  function mark(yes, op, area) {
    const words = yes ? 'allowed' : 'the app has no such action';
    return `<td class="stf-perm" data-label="${esc(op)}"><span class="stf-perm__mark ${yes ? 'is-yes' : 'is-no'}" title="${esc(`${op} ${area}: ${words}`)}">${yes ? ICON.yes : ICON.no}<span class="rop-sr-only">${esc(`${op}: ${words}`)}</span></span></td>`;
  }

  function rowHtml(a) {
    return `
      <tr data-area="${esc(a.key)}">
        <th scope="row">${esc(a.label)}</th>
        ${OPS.map(([k, op]) => mark(a[k], op, a.label)).join('')}
        <td class="rop-actions" data-label="Other actions">${a.actionLabels.length ? esc(a.actionLabels.join(', ')) : '<span class="rop-muted" aria-label="none">—</span>'}</td>
        <td class="rop-who" data-label="Who can use it">${a.adminOnly
          ? '<span class="badge badge--warn" title="The server refuses everyone else (403)">Administrators only</span>'
          : '<span class="badge badge--neutral">Anyone signed in</span>'}</td>
      </tr>`;
  }

  function stateRow({ title, text, retry = false, signIn = false }) {
    return `<tr class="rop-state-row"><td colspan="${COLS}"><div class="rop-state" role="status">
      <span class="rop-state__icon">${ICON.alert}</span>
      <div class="rop-state__text"><h3>${esc(title)}</h3><p>${esc(text)}</p>
        ${retry || signIn ? `<p class="rop-state__actions">${retry ? '<button type="button" class="btn btn--primary btn--sm" data-action="retry">Try again</button>' : ''}${signIn ? '<button type="button" class="btn btn--primary btn--sm" data-action="signin">Sign in again</button>' : ''}</p>` : ''}
      </div></div></td></tr>`;
  }

  const skeletonRows = () => Array.from({ length: 6 }, () =>
    `<tr class="rop-skel-row" aria-hidden="true">${'<td><span class="rop-skel"></span></td>'.repeat(COLS)}</tr>`).join('');

  /* ---------- the page ---------- */

  const $ = id => document.getElementById(id);
  const state = { loaded: false, areas: [], accounts: null, current: ROLES[0].name };

  function setText(id, text) { const el = $(id); if (el) el.textContent = text; }
  function setBusy(busy) {
    for (const id of ['ropMatrix', 'ropRoleList']) { const el = $(id); if (el) el.setAttribute('aria-busy', String(busy)); }
  }
  function alertBox(text) {
    const el = $('ropAlert');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  function who() {
    const me = Storage.account;
    setText('ropWho', me
      ? `You are signed in with the account “${me.username}” (${me.role}).`
      : 'You are signed in with the shared workshop passphrase.');
  }

  function renderRoleList() {
    const list = $('ropRoleList');
    if (!list) return;
    list.innerHTML = ROLES.map(r => {
      const m = state.accounts ? members(state.accounts, r.name) : null;
      const meta = `${m ? membersText(m) : 'Accounts not shown'} · ${state.areas.length} areas, full access`;
      const on = r.name === state.current;
      return `<button type="button" class="stf-rolecard${on ? ' is-active' : ''}" data-role="${esc(r.name)}" aria-pressed="${on}">
        <span class="stf-avatar stf-avatar--6" aria-hidden="true">${esc(r.name.charAt(0))}</span>
        <span class="stf-rolecard__text"><span class="stf-rolecard__name">${esc(r.name)}</span><span class="stf-rolecard__meta">${esc(meta)}</span></span>
      </button>`;
    }).join('');
  }

  function renderDetail() {
    const role = ROLES.find(r => r.name === state.current) || ROLES[0];
    setText('ropRoleName', role.name);
    setText('ropRoleDesc', role.description);
    setText('ropRoleMembers', state.accounts ? membersText(members(state.accounts, role.name)) : 'Accounts not shown');
    const notes = $('ropRoleNotes');
    if (notes) notes.innerHTML = role.notes.map(n => `<li>${esc(n)}</li>`).join('');
    const body = $('ropBody');
    if (body) body.innerHTML = state.areas.map(rowHtml).join('');
    setText('ropCount', `${state.areas.length} areas, read from the Worker`);
  }

  function renderUnavailable(code) {
    state.loaded = false;
    setBusy(false);
    setText('ropRoleMembers', '');
    setText('ropCount', '');
    const list = $('ropRoleList');
    if (list) list.innerHTML = '<p class="stf-muted">Roles are shown once the permissions load.</p>';
    const body = $('ropBody');
    if (!body) return;
    if (code === 'no_api') {
      body.innerHTML = stateRow({ title: 'Roles & Permissions needs the workshop database',
        text: 'This copy of the app is not connected to the workshop database, so no roles or permissions are shown.' });
    } else if (code === 'unauthorized') {
      body.innerHTML = stateRow({ title: 'Your session has ended', signIn: true,
        text: 'Sign in again to see roles and permissions. Nothing was changed.' });
    } else {
      body.innerHTML = stateRow({ title: 'The permissions could not be loaded', retry: true,
        text: 'The Worker did not answer, so no permissions are shown. Try again in a moment.' });
    }
  }

  async function load() {
    alertBox('');
    if (!Storage.isApi()) { renderUnavailable('no_api'); return false; }
    setBusy(true);
    setText('ropCount', 'Loading permissions…');
    const body = $('ropBody');
    if (body) body.innerHTML = skeletonRows();
    const list = $('ropRoleList');
    if (list) list.innerHTML = '<p class="stf-muted">Loading roles…</p>';

    const [health, acc] = await Promise.all([Api.probe(), Storage.load('accounts')]);
    const routes = health.ok && health.health ? health.health.routes : null;
    if (!Array.isArray(routes)) { renderUnavailable(health.code || 'network_error'); return false; }
    if (!acc.ok && acc.code === 'unauthorized') { renderUnavailable('unauthorized'); return false; }

    state.areas = capabilities(routes);
    state.accounts = acc.ok ? Storage.getData('accounts') : null;
    if (!acc.ok) {
      alertBox(acc.code === 'forbidden'
        ? 'Only an administrator can see who holds each role, so the number of accounts is not shown. The permissions below are complete.'
        : 'The accounts could not be loaded, so the number of people with each role is not shown. The permissions below are complete.');
    }
    state.loaded = true;
    setBusy(false);
    who();
    renderRoleList();
    renderDetail();
    return true;
  }

  function explainEdit() {
    Utils.toast('Permissions cannot be edited yet. Every account is an Administrator with full access, and the server does not check any narrower permission, so a change here would not restrict anyone. Nothing was changed.', 'info');
  }

  function bindEvents() {
    const edit = $('ropEdit'), list = $('ropRoleList'), body = $('ropBody');
    if (edit) edit.addEventListener('click', e => { e.preventDefault(); explainEdit(); });
    if (list) list.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-role]') : null;
      if (!btn || !state.loaded) return;
      state.current = btn.dataset.role;
      renderRoleList();
      renderDetail();
    });
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn) return;
      if (btn.dataset.action === 'retry') load();
      else if (btn.dataset.action === 'signin') window.location.reload();
    });
  }

  function start(outcome) {
    if (outcome && outcome.mode === 'locked') return;
    bindEvents();
    load();
  }

  Storage.ready(start);

  return { ROLES, ADMIN_ONLY, AREAS, capabilities, members, membersText, rowHtml, load, state };
})();
