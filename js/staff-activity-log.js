/* ============================================================
   staff-activity-log.js — Staff Management › Activity Log
   ------------------------------------------------------------
   Who did what, and when.

   Source of truth: the workshop database, and nothing else. Entries come
   from Storage.loadPage('activityLog', filters) (GET /api/activity-log),
   ONLY in 'api' mode, one page at a time: the Worker filters (day range,
   module, action, search) and pages, so the browser never downloads the
   whole history. In every other mode this page shows nothing.

   This page only READS. The Worker writes an entry itself after a Staff
   Management change succeeds (src/lib/activity.js); there is no way to add,
   edit or delete one from here, and nothing here claims an event was
   recorded that the server did not return.
   ============================================================ */

const StaffActivityLog = (() => {

  const { esc } = Utils;

  const PAGE = 25;
  const COLS = 6;
  const MODULES = ['staff', 'accounts', 'attendance', 'leave'];
  const ACTIONS = ['create', 'update', 'password', 'approve', 'reject'];
  const MODULE_LABEL = { staff: 'Staff', accounts: 'User Accounts', attendance: 'Attendance', leave: 'Leave' };
  const ACTION_LABEL = { create: 'Create', update: 'Update', password: 'Password', approve: 'Approve', reject: 'Reject' };
  const ACTION_BADGE = { create: 'badge--good', update: 'badge--info', password: 'badge--warn', approve: 'badge--good', reject: 'badge--bad' };
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  const svg = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    list: svg('M17 10H7v2h10v-2zm2-7h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zm-5-5H7v2h7v-2z'),
    search: svg('M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'),
    alert: svg('M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'),
  };

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  /** The query the Worker is asked for: only the filters that are set, plus the page. */
  function buildQuery({ q = '', from = '', to = '', module = 'all', action = 'all', page = 1 } = {}) {
    const out = {};
    const text = String(q || '').trim().slice(0, 100);
    if (text) out.q = text;
    if (DATE.test(from)) out.from = from;
    if (DATE.test(to)) out.to = to;
    if (MODULES.includes(module)) out.module = module;
    if (ACTIONS.includes(action)) out.action = action;
    out.limit = String(PAGE);
    out.offset = String((Math.max(1, page) - 1) * PAGE);
    return out;
  }

  /** "From" after "To" is not a range: nothing is asked of the server. */
  const rangeInvalid = (from, to) => DATE.test(from) && DATE.test(to) && from > to;

  /** An ISO instant as workshop time (Asia/Dhaka), e.g. "24 Oct 2026, 11:05". */
  function fmtWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dhaka' });
    return `${date}, ${time}`;
  }

  /** The page range a total covers: { from, to, pages }. */
  function pageInfo(total, page) {
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const p = Math.min(Math.max(1, page), pages);
    return { page: p, pages, from: total ? (p - 1) * PAGE + 1 : 0, to: Math.min(total, p * PAGE) };
  }

  /* ---------- markup ---------- */

  const actorSub = e => (e.actorKind === 'account' ? (e.actorAccountId ? `Account ${e.actorAccountId}` : 'Account') : 'Not an account');

  function rowHtml(e) {
    return `
      <tr data-id="${esc(e.id)}">
        <td data-label="Date &amp; Time" class="stf-nowrap">${esc(fmtWhen(e.occurredAt))}</td>
        <td data-label="User"><span class="cell-main">${esc(e.actorName)}</span><span class="cell-sub">${esc(actorSub(e))}</span></td>
        <td data-label="Action"><span class="badge ${ACTION_BADGE[e.action] || 'badge--neutral'}">${esc(ACTION_LABEL[e.action] || e.action)}</span></td>
        <td data-label="Module">${esc(MODULE_LABEL[e.module] || e.module)}<span class="cell-sub">${esc(e.recordId)}</span></td>
        <td data-label="Description" class="alg-desc">${esc(e.summary)}</td>
        <td data-label="Details"><button type="button" class="btn btn--ghost btn--sm" data-action="view" data-id="${esc(e.id)}" aria-label="View the details of entry ${esc(e.id)}">View</button></td>
      </tr>`;
  }

  function stateRow({ icon = ICON.list, title, text, retry = false, clear = false, signIn = false, tone = 'neutral' }) {
    const actions = [
      retry ? '<button type="button" class="btn btn--primary btn--sm" data-action="retry">Retry</button>' : '',
      signIn ? '<button type="button" class="btn btn--primary btn--sm" data-action="signin">Sign in again</button>' : '',
      clear ? '<button type="button" class="btn btn--ghost btn--sm" data-action="clear">Clear filters</button>' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="alg-state-row">
        <td colspan="${COLS}">
          <div class="alg-state${tone === 'bad' ? ' alg-state--bad' : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">
            <span class="alg-state__icon">${icon}</span>
            <div class="alg-state__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${actions ? `<p class="alg-state__actions">${actions}</p>` : ''}
            </div>
          </div>
        </td>
      </tr>`;
  }

  function skeletonRows(n = 5) {
    const cell = '<td><span class="alg-skel"></span></td>';
    return Array.from({ length: n }, () => `<tr class="alg-state-row alg-skel-row" aria-hidden="true">${cell.repeat(COLS)}</tr>`).join('');
  }

  /* ---------- the page ---------- */

  const state = { loaded: false, q: '', from: '', to: '', module: 'all', action: 'all', page: 1, total: 0 };
  const $ = id => document.getElementById(id);
  let debounce = null;
  let ticket = 0;   // only the newest request may draw the page

  const CONTROLS = ['algSearch', 'algFrom', 'algTo', 'algModule', 'algAction', 'algClear'];
  function setControls(enabled) { for (const id of CONTROLS) { const el = $(id); if (el) el.disabled = !enabled; } }
  function setBody(html, busy = false) {
    const el = $('algBody'); if (el) el.innerHTML = html;
    const table = $('algTable'); if (table && table.setAttribute) table.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  const note = text => { const el = $('algCount'); if (el) el.textContent = text; };
  function setCards(meta) {
    const c = meta && meta.counts;
    const put = (id, v) => { const el = $(id); if (el) el.textContent = meta ? String(v ?? 0) : '—'; };
    put('alg-total', meta && meta.total);
    put('alg-today', c && c.today);
    put('alg-people', c && c.staffAccounts);
    put('alg-days', c && c.attendanceLeave);
  }
  function setPager(info, total) {
    const prev = $('algPrev'), next = $('algNext'), range = $('algRange');
    if (range) range.textContent = info && total ? `Showing ${info.from}–${info.to} of ${total}` : '';
    if (prev) prev.disabled = !info || info.page <= 1;
    if (next) next.disabled = !info || info.page >= info.pages;
  }
  const hasFilters = () => Boolean(state.q || state.from || state.to || state.module !== 'all' || state.action !== 'all');

  function fillFilters() {
    const m = $('algModule');
    if (m) { m.innerHTML = '<option value="all">All modules</option>' + MODULES.map(k => `<option value="${k}">${esc(MODULE_LABEL[k])}</option>`).join(''); m.value = state.module; }
    const a = $('algAction');
    if (a) { a.innerHTML = '<option value="all">All actions</option>' + ACTIONS.map(k => `<option value="${k}">${esc(ACTION_LABEL[k])}</option>`).join(''); a.value = state.action; }
  }

  function renderUnavailable(code) {
    state.loaded = false;
    setCards(null);
    note('');
    setPager(null, 0);
    let row;
    if (code === 'no_api') {
      setControls(false);
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'The activity log needs the workshop database',
        text: 'This copy of the app is not connected to the workshop database, so no activity is shown.' });
    } else if (code === 'unauthorized') {
      setControls(false);
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'Your session has ended', signIn: true, text: 'Sign in again to see the activity log. Nothing was changed.' });
    } else if (code === 'forbidden') {
      setControls(false);
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'Only an administrator can read the activity log', text: 'Your account is not allowed to see the activity log.' });
    } else {
      row = stateRow({ icon: ICON.alert, tone: 'bad', title: 'The activity log could not be loaded', retry: true,
        text: 'The workshop database did not answer, so nothing is shown. Try again in a moment.' });
    }
    setBody(row);
  }

  /** Ask the Worker for the current page with the current filters, and draw it. */
  async function load() {
    if (!Storage.isApi()) { renderUnavailable('no_api'); return false; }
    const bad = rangeInvalid(state.from, state.to);
    const err = $('algRangeError'); if (err) err.hidden = !bad;
    if (bad) {
      setBody(stateRow({ icon: ICON.search, title: 'The date range is not valid', clear: true, text: '"From" must be on or before "To".' }));
      note(''); setPager(null, 0);
      return false;
    }
    const mine = ++ticket;
    note('Loading activity…');
    setBody(skeletonRows(), true);
    const res = await Storage.loadPage('activityLog', buildQuery(state));
    if (mine !== ticket) return false;            // a newer request has been made meanwhile
    if (!res.ok) { renderUnavailable(res.code); return false; }
    state.loaded = true;
    setControls(true);
    const total = Number(res.meta && res.meta.total) || 0;
    state.total = total;
    const info = pageInfo(total, state.page);
    if (info.page !== state.page && total) { state.page = info.page; return load(); }
    setCards(res.meta);
    if (!res.rows.length) {
      setBody(hasFilters()
        ? stateRow({ icon: ICON.search, title: 'No activity matches these filters', clear: true, text: 'Change or clear the search, dates, module or action.' })
        : stateRow({ title: 'No activity yet', text: 'An entry appears here once a Staff Management change succeeds: staff added or edited, an account created or changed, attendance recorded, leave submitted or decided.' }));
      note(hasFilters() ? '0 matching entries' : '0 entries');
    } else {
      setBody(res.rows.map(rowHtml).join(''));
      note(`${total} ${hasFilters() ? 'matching ' : ''}entr${total === 1 ? 'y' : 'ies'}`);
    }
    setPager(info, total);
    return true;
  }

  function showDetails(e) {
    const panel = $('algDetails'), list = $('algDetailsList');
    if (!panel || !list) return;
    const rows = [
      ['Entry', `#${e.id}`], ['Date & time', fmtWhen(e.occurredAt)], ['User', e.actorName],
      ['Signed in as', e.actorKind === 'account' ? `Account ${e.actorAccountId}` : (e.actorKind === 'passphrase' ? 'Workshop passphrase' : 'Machine token')],
      ['Action', ACTION_LABEL[e.action] || e.action], ['Module', MODULE_LABEL[e.module] || e.module], ['Record', e.recordId],
      ['Description', e.summary], ['Outcome', 'Succeeded (only successful changes are recorded)'],
    ];
    list.innerHTML = rows.map(([k, v]) => `<div class="stf-dl__row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    panel.hidden = false;
    if (panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest' });
    const close = $('algDetailsClose'); if (close && close.focus) close.focus();
  }

  /* ---------- events ---------- */

  function clearFilters() {
    clearTimeout(debounce);
    Object.assign(state, { q: '', from: '', to: '', module: 'all', action: 'all', page: 1 });
    for (const [id, v] of [['algSearch', ''], ['algFrom', ''], ['algTo', ''], ['algModule', 'all'], ['algAction', 'all']]) { const el = $(id); if (el) el.value = v; }
    return load();
  }

  function bindEvents() {
    const search = $('algSearch'), body = $('algBody');
    if (search) search.addEventListener('input', e => {
      const value = String(e.target.value || '').slice(0, 100);
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.q = value; state.page = 1; load(); }, 300);
    });
    for (const [id, key, ok] of [['algFrom', 'from', v => v === '' || DATE.test(v)], ['algTo', 'to', v => v === '' || DATE.test(v)],
      ['algModule', 'module', v => v === 'all' || MODULES.includes(v)], ['algAction', 'action', v => v === 'all' || ACTIONS.includes(v)]]) {
      const el = $(id);
      if (el) el.addEventListener('change', e => { const v = String(e.target.value || ''); state[key] = ok(v) ? v : (key === 'from' || key === 'to' ? '' : 'all'); state.page = 1; load(); });
    }
    const clear = $('algClear'), prev = $('algPrev'), next = $('algNext'), close = $('algDetailsClose');
    if (clear) clear.addEventListener('click', clearFilters);
    if (prev) prev.addEventListener('click', () => { state.page = Math.max(1, state.page - 1); load(); });
    if (next) next.addEventListener('click', () => { state.page += 1; load(); });
    if (close) close.addEventListener('click', () => { const p = $('algDetails'); if (p) p.hidden = true; });
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn || btn.disabled) return;
      const action = btn.dataset ? btn.dataset.action : btn.action;
      const id = btn.dataset ? btn.dataset.id : btn.id;
      switch (action) {
        case 'retry': load(); break;
        case 'signin': window.location.reload(); break;
        case 'clear': clearFilters(); break;
        case 'view': { const entry = Storage.getById('activityLog', id); if (entry) showDetails(entry); break; }
        default: break;
      }
    });
  }

  function start(outcome) {
    if (outcome && outcome.mode === 'locked') return;
    fillFilters();
    bindEvents();
    load();
  }

  Storage.ready(start);

  return { MODULES, ACTIONS, PAGE, buildQuery, rangeInvalid, fmtWhen, pageInfo, rowHtml, load, clearFilters, state };
})();
