/* ============================================================
   staff-list.js — Staff Management › Staff List
   ------------------------------------------------------------
   Every employee: mechanics and all other staff, one list.

   Source of truth: the workshop database, and nothing else.
     - Staff are read on demand through Storage.load('staff')
       (GET /api/staff), ONLY when Storage is in 'api' mode. They are
       not part of the app-wide hydration, so if they cannot be read
       this page says so and every other page is unaffected.
     - In every other mode -- no backend, a backend that failed, a
       signed-out browser -- this page shows no one and saves nothing.
       There is no demo or browser-stored roster to fall back to.
     - Add, Edit and Activate / Deactivate go through Storage.create /
       update (POST / PUT /api/staff). The Worker re-checks every field,
       the phone and employee-code rules and the type; the checks here
       only spare a round trip.

   The model (migration 0008): a mechanic is the Mechanics page's own
   record (MEC-0001) plus an optional profile with employee code,
   designation and department; anyone else is a staff record
   (STF-0001). Editing a mechanic here edits that same record. Pay is
   never shown or sent from this page -- it stays on Mechanics.

   There is no delete. An employee who leaves is set Inactive, which
   keeps every job card, appointment and task that names them.
   ============================================================ */

const StaffList = (() => {

  const { esc } = Utils;

  /* Field limits: the Worker's (src/routes/staff.js LIMITS) and the schema's
     CHECKs (0008) use the same numbers. */
  const LIMITS = { employeeCode: 20, designation: 60, department: 60, name: 120, phone: 20,
    email: 160, address: 500, notes: 1000, specialization: 80, search: 100 };
  const PHONE = /^[0-9+\-\s()]{6,20}$/;
  const PHONE_QUERY = /^[0-9+\-\s()]+$/;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const EMPLOYEE_CODE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
  const EARLIEST_JOINING = '1980-01-01';

  const STATUSES = ['Active', 'Inactive'];
  const SORTS = ['name-asc', 'name-desc', 'joined-desc', 'joined-asc', 'status'];
  const PAGE_SIZES = [10, 25, 50, 100];
  const DEFAULT_PAGE_SIZE = 25;
  const COLS = 9;

  // Offered as suggestions only; any designation or department can be typed.
  const DESIGNATIONS = ['Mechanic', 'Senior Mechanic', 'Electrician', 'Service Advisor', 'Receptionist',
    'Accountant', 'Workshop Manager', 'Manager', 'Helper', 'Administrator'];
  const DEPARTMENTS = ['Workshop', 'Front Desk', 'Accounts', 'Management', 'Stores', 'Administration'];

  const svg = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    view: svg('M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z'),
    edit: svg('M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z'),
    off: svg('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.9 7.9 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.9 7.9 0 0 1 20 12c0 4.42-3.58 8-8 8z'),
    on: svg('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'),
    people: svg('M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z'),
    search: svg('M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'),
    alert: svg('M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'),
  };

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  const digits = s => String(s || '').replace(/\D/g, '');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** '2024-03-01' -> '01 Mar 2024'. Split, never parsed into a Date, so no time zone can move the day. */
  function fmtDay(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return '';
    const [y, m, d] = iso.split('-');
    return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
  }

  /** Does one staff record match the search text? Name, staff ID, code, email; phone digits for a phone-like query. */
  function matchesSearch(s, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    if ([s.name, s.id, s.employeeCode, s.email].some(v => String(v || '').toLowerCase().includes(q))) return true;
    const d = digits(q);
    return PHONE_QUERY.test(q) && d !== '' && digits(s.phone).includes(d);
  }

  /** Records matching the search and the three filters ('all' = no filter). */
  function filterRows(rows, { search = '', designation = 'all', department = 'all', status = 'all' } = {}) {
    return rows.filter(s => matchesSearch(s, search)
      && (designation === 'all' || s.designation === designation)
      && (department === 'all' || s.department === department)
      && (status === 'all' || s.status === status));
  }

  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    || String(a.id).localeCompare(String(b.id));

  /** A sorted copy. An unrecorded joining date sorts last either way. */
  function sortRows(rows, sort = 'name-asc') {
    const list = rows.slice();
    const joined = dir => (a, b) => {
      if (!a.joiningDate !== !b.joiningDate) return a.joiningDate ? -1 : 1;
      return (a.joiningDate === b.joiningDate ? 0 : (a.joiningDate < b.joiningDate ? -1 : 1) * dir) || byName(a, b);
    };
    const compare = {
      'name-asc': byName,
      'name-desc': (a, b) => byName(b, a),
      'joined-desc': joined(-1),
      'joined-asc': joined(1),
      status: (a, b) => (a.status === b.status ? 0 : a.status === 'Active' ? -1 : 1) || byName(a, b),
    }[sort] || byName;
    return list.sort(compare);
  }

  /** One page of a list; the page is clamped to what exists. */
  function paginate(list, page, size = DEFAULT_PAGE_SIZE) {
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = Math.min(Math.max(1, Number(page) || 1), pages);
    const items = list.slice((p - 1) * size, p * size);
    return { items, page: p, pages, total: list.length, from: items.length ? (p - 1) * size + 1 : 0, to: (p - 1) * size + items.length };
  }

  /** The designations and departments actually in use, for the filters. */
  function facets(rows) {
    const uniq = key => [...new Set(rows.map(r => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return { designations: uniq('designation'), departments: uniq('department') };
  }

  /**
   * The browser's copy of the Worker's rules, so most mistakes are caught
   * without a round trip. Returns { field: message }.
   */
  function validateStaff(v, { isMechanic = false, today = Utils.todayStr() } = {}) {
    const e = {};
    const need = (key, label) => { if (!String(v[key] || '').trim()) e[key] = `${label} is required.`; };
    const max = (key, label) => { if (String(v[key] || '').length > LIMITS[key]) e[key] = `${label} must be ${LIMITS[key]} characters or fewer.`; };
    need('name', 'Full name'); max('name', 'Full name');
    need('phone', 'Phone');
    if (v.phone && !e.phone && !PHONE.test(v.phone)) e.phone = 'Enter a valid phone number (digits, +, -, spaces).';
    if (v.email && !EMAIL.test(v.email)) e.email = 'Enter a valid email address.';
    max('email', 'Email');
    if (v.employeeCode) {
      if (!EMPLOYEE_CODE.test(v.employeeCode)) e.employeeCode = 'Use letters, digits, and - . / _ only, starting with a letter or digit.';
      max('employeeCode', 'Employee code');
    }
    if (!isMechanic) { need('designation', 'Designation'); need('department', 'Department'); }
    max('designation', 'Designation'); max('department', 'Department');
    if (isMechanic) { need('specialization', 'Specialization'); max('specialization', 'Specialization'); }
    if (v.joiningDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.joiningDate)) e.joiningDate = 'Enter a real date.';
      else if (v.joiningDate < EARLIEST_JOINING) e.joiningDate = 'Joining date looks too old.';
      else if (today && v.joiningDate > today) e.joiningDate = 'Joining date cannot be in the future.';
    }
    if (!STATUSES.includes(v.status)) e.status = 'Choose Active or Inactive.';
    max('address', 'Address'); max('notes', 'Notes');
    return e;
  }

  /** The request body for a create or an edit. Never carries pay. */
  function payload(v, { isMechanic = false, mode = 'create' } = {}) {
    const body = {
      name: v.name, phone: v.phone, email: v.email, address: v.address, joiningDate: v.joiningDate,
      status: v.status, notes: v.notes, employeeCode: v.employeeCode, designation: v.designation, department: v.department,
    };
    if (isMechanic) body.specialization = v.specialization;
    if (mode === 'create') body.isMechanic = !!isMechanic;
    return body;
  }

  /* ---------- markup ---------- */

  /** A colour slot per designation, so the avatars of one role match. */
  function slot(designation) {
    let n = 0;
    for (const ch of String(designation || '')) n = (n * 31 + ch.charCodeAt(0)) % 997;
    return (n % 6) + 1;
  }

  const muted = text => `<span class="stl-muted">${esc(text)}</span>`;
  const statusBadge = status => `<span class="badge ${status === 'Active' ? 'badge--good' : 'badge--bad'}">${esc(status)}</span>`;

  function rowHtml(s) {
    const active = s.status === 'Active';
    const initial = (String(s.name || '?').trim()[0] || '?').toUpperCase();
    return `
      <tr data-id="${esc(s.id)}">
        <td data-label="Staff ID / Code" class="stf-nowrap"><span class="cell-main">${esc(s.id)}</span><span class="cell-sub">${s.employeeCode ? esc(s.employeeCode) : 'No code'}</span></td>
        <td data-label="Name">
          <div class="stf-person">
            <span class="stf-avatar stf-avatar--${slot(s.designation)}" aria-hidden="true">${esc(initial)}</span>
            <span class="stf-person__text"><span class="cell-main">${esc(s.name)}</span><span class="cell-sub">${s.isMechanic ? 'Mechanic record' : 'Staff record'}</span></span>
          </div>
        </td>
        <td data-label="Designation">${s.designation ? esc(s.designation) : muted('Not set')}</td>
        <td data-label="Department">${s.department ? esc(s.department) : muted('Not set')}</td>
        <td data-label="Phone" class="stf-nowrap">${s.phone ? esc(s.phone) : muted('—')}</td>
        <td data-label="Email" class="stl-email">${s.email ? esc(s.email) : muted('—')}</td>
        <td data-label="Status">${statusBadge(s.status)}</td>
        <td data-label="Joining Date" class="stf-nowrap">${s.joiningDate ? esc(fmtDay(s.joiningDate)) : muted('Not recorded')}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <button type="button" class="icon-btn icon-btn--sm" data-action="view" data-id="${esc(s.id)}" title="View ${esc(s.name)}" aria-label="View ${esc(s.name)}">${ICON.view}</button>
            <button type="button" class="icon-btn icon-btn--sm" data-action="edit" data-id="${esc(s.id)}" title="Edit ${esc(s.name)}" aria-label="Edit ${esc(s.name)}">${ICON.edit}</button>
            <button type="button" class="icon-btn icon-btn--sm${active ? ' stl-danger' : ''}" data-action="${active ? 'deactivate' : 'activate'}" data-id="${esc(s.id)}"
              title="${active ? 'Deactivate' : 'Activate'} ${esc(s.name)}" aria-label="${active ? 'Deactivate' : 'Activate'} ${esc(s.name)}">${active ? ICON.off : ICON.on}</button>
          </div>
        </td>
      </tr>`;
  }

  function stateRow({ icon = ICON.people, title, text, retry = false, clear = false, add = false, signIn = false, tone = 'neutral' }) {
    const actions = [
      retry ? '<button type="button" class="btn btn--primary btn--sm" data-action="retry">Retry</button>' : '',
      signIn ? '<button type="button" class="btn btn--primary btn--sm" data-action="signin">Sign in again</button>' : '',
      add ? '<button type="button" class="btn btn--primary btn--sm" data-action="add">Add Staff</button>' : '',
      clear ? '<button type="button" class="btn btn--ghost btn--sm" data-action="clear">Clear filters</button>' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="stl-state-row">
        <td colspan="${COLS}">
          <div class="stl-state${tone === 'bad' ? ' stl-state--bad' : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">
            <span class="stl-state__icon">${icon}</span>
            <div class="stl-state__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${actions ? `<p class="stl-state__actions">${actions}</p>` : ''}
            </div>
          </div>
        </td>
      </tr>`;
  }

  /** Placeholder rows while the roster loads; hidden from assistive technology. */
  function skeletonRows(n = 6) {
    const cell = '<td><span class="stl-skel"></span></td>';
    return Array.from({ length: n }, () => `<tr class="stl-state-row stl-skel-row" aria-hidden="true">${cell.repeat(COLS)}</tr>`).join('');
  }

  /* ---------- the page ---------- */

  const state = { loaded: false, search: '', designation: 'all', department: 'all', status: 'all', sort: 'name-asc', page: 1, pageSize: DEFAULT_PAGE_SIZE };
  const $ = id => document.getElementById(id);
  let debounce = null;

  const CONTROLS = ['stlSearch', 'stlDesignation', 'stlDepartment', 'stlStatus', 'stlSort', 'stlClear', 'stlAdd'];
  function setControls(enabled) {
    for (const id of CONTROLS) { const el = $(id); if (el) el.disabled = !enabled; }
  }

  function setBody(html, busy = false) {
    const body = $('stlBody');
    if (body) body.innerHTML = html;
    const table = $('stlTable');
    if (table && table.setAttribute) table.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function note(text) { const el = $('stlCount'); if (el) el.textContent = text; }

  function setPager(p) {
    const foot = $('stlFoot');
    if (foot) foot.hidden = !p;
    if (!p) return;
    const range = $('stlRange'); if (range) range.textContent = `Showing ${p.from}–${p.to} of ${p.total}`;
    const prev = $('stlPrev'), next = $('stlNext');
    if (prev) prev.disabled = p.page <= 1;
    if (next) next.disabled = p.page >= p.pages;
  }

  const rows = () => Storage.getData('staff');

  /** Refill a filter's options from what is in use, keeping a still-valid choice. */
  function fillFilter(id, allLabel, values, key) {
    const el = $(id);
    if (!el) return;
    if (state[key] !== 'all' && !values.includes(state[key])) state[key] = 'all';
    el.innerHTML = `<option value="all">${esc(allLabel)}</option>` + values.map(v =>
      `<option value="${esc(v)}"${v === state[key] ? ' selected' : ''}>${esc(v)}</option>`).join('');
    el.value = state[key];
  }

  function refreshView() {
    const f = facets(rows());
    fillFilter('stlDesignation', 'All designations', f.designations, 'designation');
    fillFilter('stlDepartment', 'All departments', f.departments, 'department');
    renderList();
  }

  function renderList() {
    const all = rows();
    if (!all.length) {
      setPager(null);
      setBody(stateRow({ title: 'No staff yet', add: true,
        text: 'Add your mechanics, service advisors, accountants and everyone else who works at the workshop. They will be listed here.' }));
      note('0 staff');
      return;
    }
    const shown = sortRows(filterRows(all, state), state.sort);
    if (!shown.length) {
      setPager(null);
      setBody(stateRow({ icon: ICON.search, title: 'No staff match your search or filters', clear: true,
        text: 'Change or clear the search, designation, department or status filter to see more staff.' }));
      note(`No matches among ${all.length} staff`);
      return;
    }
    const p = paginate(shown, state.page, state.pageSize);
    state.page = p.page;
    setBody(p.items.map(rowHtml).join(''));
    setPager(p);
    note(`${shown.length} of ${all.length} staff`);
  }

  function renderLoading() {
    setControls(false);
    setPager(null);
    note('Loading staff…');
    setBody(skeletonRows(), true);
  }

  function renderUnavailable(code) {
    state.loaded = false;
    setControls(false);
    setPager(null);
    note('Search and filters are unavailable until the staff list loads.');
    if (code === 'no_api') {
      setBody(stateRow({ icon: ICON.alert, tone: 'bad', title: 'The Staff List needs the workshop database',
        text: 'This copy of the app is not connected to the workshop database, so no staff are shown and none can be added. Nothing stored in this browser is used in their place.' }));
    } else if (code === 'unauthorized') {
      setBody(stateRow({ icon: ICON.alert, tone: 'bad', title: 'Your session has ended', signIn: true,
        text: 'Sign in again to see the staff list. Nothing was changed.' }));
    } else {
      setBody(stateRow({ icon: ICON.alert, tone: 'bad', title: 'The staff list could not be loaded', retry: true,
        text: 'The workshop database did not answer, so no staff are shown. Nothing stored in this browser is used in their place. Try again in a moment.' }));
    }
  }

  async function load() {
    if (!Storage.isApi()) { renderUnavailable('no_api'); return false; }
    renderLoading();
    const res = await Storage.load('staff');
    if (!res.ok) { renderUnavailable(res.code); return false; }
    state.loaded = true;
    setControls(true);
    refreshView();
    return true;
  }

  /* ---------- dialogs ---------- */

  function field({ id, label, required = false, html, err, span = false, hint = '' }) {
    return `
      <div class="field${span ? ' span-2' : ''}"${err ? ` data-field="${err}"` : ''}>
        <label for="${id}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
        ${html}
        ${hint ? `<p class="stl-hint" id="${id}-hint">${esc(hint)}</p>` : ''}
        ${err ? `<div class="field__error" id="${id}-err" data-err="${err}" role="alert"></div>` : ''}
      </div>`;
  }

  const input = (id, name, value, { type = 'text', max = 0, required = false, list = '', extra = '' } = {}) =>
    `<input class="input" id="${id}" name="${name}" type="${type}" value="${esc(value ?? '')}"${max ? ` maxlength="${max}"` : ''}${required ? ' required aria-required="true"' : ''}${list ? ` list="${list}"` : ''} aria-describedby="${id}-err" autocomplete="off"${extra}>`;

  function datalist(id, values) {
    return `<datalist id="${id}">${[...new Set(values)].map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
  }

  function formHtml(s, { mode, isMechanic }) {
    const f = facets(rows());
    const specs = Storage.getData('mechanics').map(m => m && m.specialization).filter(Boolean);
    const typeBlock = mode === 'create'
      ? `<div class="stl-type">
           <label class="stl-check"><input type="checkbox" id="sf-mech" name="isMechanic"${isMechanic ? ' checked' : ''}> This person is a mechanic</label>
           <p class="stl-hint">Mechanics can be assigned to job cards and appointments, and appear on the Mechanics page. Pay is set there, not here.</p>
         </div>`
      : `<p class="stl-type-note">${isMechanic
        ? 'Mechanic record — also shown on the Mechanics page, where pay is managed.'
        : 'Staff record (not a mechanic).'} The type cannot be changed.</p>`;
    return `
      <form id="stlForm" novalidate>
        ${typeBlock}
        <h3 class="detail-section-title">Personal information</h3>
        <div class="form-grid">
          ${field({ id: 'sf-name', label: 'Full name', required: true, err: 'name', span: true, html: input('sf-name', 'name', s.name, { max: LIMITS.name, required: true }) })}
          ${field({ id: 'sf-phone', label: 'Phone', required: true, err: 'phone', html: input('sf-phone', 'phone', s.phone, { type: 'tel', max: LIMITS.phone, required: true }) })}
          ${field({ id: 'sf-email', label: 'Email', err: 'email', html: input('sf-email', 'email', s.email, { type: 'email', max: LIMITS.email }) })}
          ${field({ id: 'sf-joined', label: 'Joining date', err: 'joiningDate', html: input('sf-joined', 'joiningDate', s.joiningDate, { type: 'date', extra: ` min="${EARLIEST_JOINING}" max="${esc(Utils.todayStr())}"` }) })}
          ${field({ id: 'sf-status', label: 'Status', err: 'status', html: `
            <select class="select" id="sf-status" name="status" aria-describedby="sf-status-err">
              ${STATUSES.map(v => `<option${(s.status || 'Active') === v ? ' selected' : ''}>${v}</option>`).join('')}
            </select>` })}
          ${field({ id: 'sf-address', label: 'Address', err: 'address', span: true, html: input('sf-address', 'address', s.address, { max: LIMITS.address }) })}
        </div>
        <h3 class="detail-section-title">Employment</h3>
        <div class="form-grid">
          ${field({ id: 'sf-code', label: 'Employee code', err: 'employeeCode', hint: 'Optional. Must be unique, e.g. TQ-014.', html: input('sf-code', 'employeeCode', s.employeeCode, { max: LIMITS.employeeCode }) })}
          ${field({ id: 'sf-designation', label: 'Designation', required: true, err: 'designation', html: input('sf-designation', 'designation', s.designation, { max: LIMITS.designation, list: 'sf-designations' }) + datalist('sf-designations', [...DESIGNATIONS, ...f.designations]) })}
          ${field({ id: 'sf-department', label: 'Department', required: true, err: 'department', html: input('sf-department', 'department', s.department, { max: LIMITS.department, list: 'sf-departments' }) + datalist('sf-departments', [...DEPARTMENTS, ...f.departments]) })}
          ${field({ id: 'sf-spec', label: 'Specialization', required: true, err: 'specialization', html: input('sf-spec', 'specialization', s.specialization, { max: LIMITS.specialization, list: 'sf-specs' }) + datalist('sf-specs', specs) })}
          ${field({ id: 'sf-notes', label: 'Notes', err: 'notes', span: true, html: `<textarea class="textarea" id="sf-notes" name="notes" rows="2" maxlength="${LIMITS.notes}" aria-describedby="sf-notes-err">${esc(s.notes || '')}</textarea>` })}
        </div>
      </form>`;
  }

  /** Show the mechanic-only field, and which fields are required, for the chosen type. */
  function applyType(form, isMechanic) {
    const spec = form.querySelector('[data-field="specialization"]');
    if (spec) spec.hidden = !isMechanic;
    for (const key of ['designation', 'department']) {
      const wrap = form.querySelector(`[data-field="${key}"]`);
      const mark = wrap && wrap.querySelector('.req');
      if (mark) mark.hidden = isMechanic;
      const el = wrap && wrap.querySelector('input');
      if (el) {
        if (isMechanic) { el.removeAttribute('required'); el.removeAttribute('aria-required'); el.placeholder = key === 'designation' ? 'Mechanic' : 'Not set'; }
        else { el.setAttribute('required', ''); el.setAttribute('aria-required', 'true'); el.placeholder = ''; }
      }
    }
  }

  function readForm(form) {
    const val = name => { const el = form.querySelector(`[name="${name}"]`); return el ? String(el.value || '').trim() : ''; };
    return {
      name: val('name').replace(/\s+/g, ' '), phone: val('phone'), email: val('email'), joiningDate: val('joiningDate'),
      status: val('status'), address: val('address'), employeeCode: val('employeeCode'), designation: val('designation'),
      department: val('department'), specialization: val('specialization'), notes: val('notes'),
    };
  }

  /** Put messages on their fields, mark them invalid for assistive technology, focus the first. */
  function showErrors(form, errors) {
    form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    form.querySelectorAll('[data-err]').forEach(el => { el.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    Object.entries(errors).forEach(([key, msg]) => {
      const err = form.querySelector(`[data-err="${key}"]`);
      if (!err) return;
      err.textContent = msg;
      const wrap = err.closest('.field');
      if (wrap) wrap.classList.add('field--error');
    });
    markInvalid(form);
  }

  /** Sync aria-invalid with the error styling (also after Utils.wrote() placed server errors), and focus the first. */
  function markInvalid(form) {
    let first = null;
    form.querySelectorAll('.field').forEach(wrap => {
      const ctl = wrap.querySelector('input, select, textarea');
      if (!ctl) return;
      if (wrap.classList.contains('field--error') && !wrap.hidden) {
        ctl.setAttribute('aria-invalid', 'true');
        if (!first) first = ctl;
      } else ctl.removeAttribute('aria-invalid');
    });
    if (first && first.focus) first.focus();
  }

  function openForm(record = {}, { mode }) {
    let isMechanic = mode === 'create' ? false : !!record.isMechanic;
    const title = mode === 'create' ? 'Add Staff' : `Edit ${record.name || 'staff member'}`;
    const ov = Utils.Modal.open({
      title,
      size: 'lg',
      body: formHtml(record, { mode, isMechanic }),
      footer: `
        <button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="button" class="btn btn--primary" data-save>${mode === 'create' ? 'Add Staff' : 'Save Changes'}</button>`,
    });
    const form = ov.querySelector('#stlForm');
    applyType(form, isMechanic);
    const box = form.querySelector('#sf-mech');
    if (box) box.addEventListener('change', () => { isMechanic = box.checked; applyType(form, isMechanic); });
    form.addEventListener('submit', e => { e.preventDefault(); ov.querySelector('[data-save]').click(); });

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const values = readForm(form);
      const errors = validateStaff(values, { isMechanic });
      if (Object.keys(errors).length) { showErrors(form, errors); return; }
      showErrors(form, {});
      const body = payload(values, { isMechanic, mode });
      const res = mode === 'create' ? await Storage.create('staff', body) : await Storage.update('staff', record.id, body);
      if (!Utils.wrote(res, form)) { markInvalid(form); return; }
      Utils.Modal.close();
      Utils.toast(mode === 'create' ? `${res.record.name} was added (${res.record.id}).` : `${res.record.name} was saved.`, 'success');
      refreshView();
    }));
  }

  /** Run a row action with its button held disabled, without touching the icon inside it. */
  async function busy(btn, fn) {
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) {
      console.error('Staff action failed:', e);
      Utils.toast('Something went wrong. Please try again.', 'error');
    } finally { if (btn) btn.disabled = false; }
  }

  /** The full record (address, notes, specialization), read fresh from the database. */
  async function fetchOne(id) {
    const res = await Storage.loadOne('staff', id);
    if (!res.ok) {
      Utils.toast(res.code === 'not_found' ? 'That staff member no longer exists. The list has been refreshed.' : (res.message || 'Could not open this staff member.'), 'error');
      if (res.code === 'not_found') load();
      return null;
    }
    return res.record;
  }

  function detailHtml(s) {
    const item = (label, value, span = false) =>
      `<div class="detail-item${span ? ' span-2' : ''}"><span>${esc(label)}</span><strong>${value}</strong></div>`;
    const text = v => (v ? esc(v) : muted('Not recorded'));
    return `
      <div class="detail-grid">
        ${item('Staff ID', esc(s.id))}
        ${item('Employee code', text(s.employeeCode))}
        ${item('Designation', text(s.designation))}
        ${item('Department', text(s.department))}
        ${item('Phone', text(s.phone))}
        ${item('Email', text(s.email))}
        ${item('Status', statusBadge(s.status))}
        ${item('Joining date', s.joiningDate ? esc(fmtDay(s.joiningDate)) : muted('Not recorded'))}
        ${s.isMechanic ? item('Specialization', text(s.specialization)) : ''}
        ${s.isMechanic ? item('Employment type', text(s.employmentType)) : ''}
        ${item('Address', text(s.address), true)}
        ${item('Notes', text(s.notes), true)}
      </div>
      <p class="stl-type-note">${s.isMechanic
        ? 'Mechanic record. Pay and the other mechanic details are on the <a href="mechanics.html">Mechanics page</a>.'
        : 'Staff record (not a mechanic).'}</p>`;
  }

  async function openDetail(id, btn) {
    await busy(btn, async () => {
      const s = await fetchOne(id);
      if (!s) return;
      const ov = Utils.Modal.open({
        title: s.name, size: 'lg', body: detailHtml(s),
        footer: `
          <button type="button" class="btn btn--ghost" data-modal-close>Close</button>
          <button type="button" class="btn btn--primary" data-edit>Edit</button>`,
      });
      ov.querySelector('[data-edit]').addEventListener('click', () => openForm(s, { mode: 'edit' }));
    });
  }

  async function openEdit(id, btn) {
    await busy(btn, async () => {
      const s = await fetchOne(id);
      if (s) openForm(s, { mode: 'edit' });
    });
  }

  function setStatus(id, status, btn) {
    const s = Storage.getById('staff', id);
    if (!s) return;
    const save = async () => {
      const res = await Storage.update('staff', id, { status });
      if (!Utils.wrote(res)) return;
      Utils.toast(`${s.name} is now ${status}.`, 'success');
      refreshView();
    };
    if (status === 'Active') { busy(btn, save); return; }
    Utils.Modal.confirm({
      title: 'Deactivate staff member?',
      message: `<strong>${esc(s.name)}</strong> (${esc(s.id)}) will be marked Inactive. Nothing is deleted: their job cards, appointments and other records are kept, and they can be activated again later.`,
      confirmText: 'Deactivate',
      onConfirm: save,
    });
  }

  /* ---------- events ---------- */

  function resetPage() { state.page = 1; }

  function clearFilters() {
    clearTimeout(debounce);
    Object.assign(state, { search: '', designation: 'all', department: 'all', status: 'all', page: 1 });
    for (const [id, value] of [['stlSearch', ''], ['stlDesignation', 'all'], ['stlDepartment', 'all'], ['stlStatus', 'all']]) {
      const el = $(id); if (el) el.value = value;
    }
    renderList();
  }

  function bindEvents() {
    const search = $('stlSearch'), body = $('stlBody'), size = $('stlPageSize');
    if (search) search.addEventListener('input', e => {
      const value = String(e.target.value || '').slice(0, LIMITS.search);
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.search = value; resetPage(); renderList(); }, 200);
    });
    for (const [id, key, ok] of [['stlDesignation', 'designation'], ['stlDepartment', 'department'],
      ['stlStatus', 'status', v => v === 'all' || STATUSES.includes(v)], ['stlSort', 'sort', v => SORTS.includes(v)]]) {
      const el = $(id);
      if (el) el.addEventListener('change', e => {
        const v = String(e.target.value || 'all');
        state[key] = !ok || ok(v) ? v : (key === 'sort' ? 'name-asc' : 'all');
        resetPage(); renderList();
      });
    }
    if (size) size.addEventListener('change', e => {
      const n = Number(e.target.value);
      state.pageSize = PAGE_SIZES.includes(n) ? n : DEFAULT_PAGE_SIZE;
      resetPage(); renderList();
    });
    const clear = $('stlClear'), add = $('stlAdd'), prev = $('stlPrev'), next = $('stlNext');
    if (clear) clear.addEventListener('click', clearFilters);
    if (add) add.addEventListener('click', () => { if (state.loaded) openForm({}, { mode: 'create' }); });
    if (prev) prev.addEventListener('click', () => { state.page = Math.max(1, state.page - 1); renderList(); });
    if (next) next.addEventListener('click', () => { state.page += 1; renderList(); });
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn) return;
      const action = btn.dataset ? btn.dataset.action : btn.action;
      const id = btn.dataset ? btn.dataset.id : btn.id;
      switch (action) {
        case 'retry': load(); break;
        case 'signin': window.location.reload(); break;
        case 'clear': clearFilters(); break;
        case 'add': if (state.loaded) openForm({}, { mode: 'create' }); break;
        case 'view': openDetail(id, btn); break;
        case 'edit': openEdit(id, btn); break;
        case 'deactivate': setStatus(id, 'Inactive', btn); break;
        case 'activate': setStatus(id, 'Active', btn); break;
        default: break;
      }
    });
  }

  function start(outcome) {
    // Signed out: the sign-in screen covers the window and the app reloads
    // after signing in. Nothing has been read, so nothing is shown.
    if (outcome && outcome.mode === 'locked') return;
    bindEvents();
    load();
  }

  Storage.ready(start);

  return {
    LIMITS, SORTS, PAGE_SIZES, DEFAULT_PAGE_SIZE,
    fmtDay, matchesSearch, filterRows, sortRows, paginate, facets, validateStaff, payload, rowHtml,
    load, refreshView, renderList, clearFilters, state,
  };
})();
