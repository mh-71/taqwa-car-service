/* ============================================================
   staff-ui.js — Staff Management pages (UI PREVIEW ONLY)
   ------------------------------------------------------------
   Loaded by the six Staff Management pages. Each page says which
   it is through <body data-page="...">, and this file fills in
   that page from the DEMO data below.

   What this file deliberately does NOT do:
     - read or write the workshop database (no Api, no Storage);
     - read or write browser storage;
     - send anything anywhere, or read a chosen file;
     - create staff, accounts, passwords, permissions or log entries.

   Every action button carries data-preview and only explains that
   it is not available yet. Search, filters and paging work on the
   demo list in memory, so the layout can be judged with realistic
   amounts of content. All content is built with textContent --
   nothing from the data is parsed as HTML.
   ============================================================ */

const StaffUI = (() => {

  /* ---------- demo data (clearly fictional; never saved) ---------- */

  // Twelve fictional people. Names say "Demo Staff", e-mail addresses use the
  // reserved example.com domain and phone numbers are masked, so none of this
  // can be mistaken for a real employee.
  const DEMO_STAFF = [
    { id: 'DEMO-001', name: 'Demo Staff A', designation: 'Senior Mechanic',  role: 'Mechanic',        department: 'Workshop',   status: 'Active',   joined: '2023-02-06', account: 'Active' },
    { id: 'DEMO-002', name: 'Demo Staff B', designation: 'Mechanic',         role: 'Mechanic',        department: 'Workshop',   status: 'Active',   joined: '2023-05-15', account: 'Active' },
    { id: 'DEMO-003', name: 'Demo Staff C', designation: 'Mechanic',         role: 'Mechanic',        department: 'Workshop',   status: 'Active',   joined: '2024-01-08', account: 'Active' },
    { id: 'DEMO-004', name: 'Demo Staff D', designation: 'Electrician',      role: 'Mechanic',        department: 'Workshop',   status: 'Active',   joined: '2024-06-03', account: 'Active' },
    { id: 'DEMO-005', name: 'Demo Staff E', designation: 'Mechanic',         role: 'Mechanic',        department: 'Workshop',   status: 'Inactive', joined: '2024-09-16', account: 'Inactive' },
    { id: 'DEMO-006', name: 'Demo Staff F', designation: 'Service Advisor',  role: 'Service Advisor', department: 'Front Desk', status: 'Active',   joined: '2023-03-20', account: 'Active' },
    { id: 'DEMO-007', name: 'Demo Staff G', designation: 'Service Advisor',  role: 'Service Advisor', department: 'Front Desk', status: 'Active',   joined: '2025-02-10', account: 'Active' },
    { id: 'DEMO-008', name: 'Demo Staff H', designation: 'Accountant',       role: 'Accountant',      department: 'Accounts',   status: 'Active',   joined: '2023-08-01', account: 'Active' },
    { id: 'DEMO-009', name: 'Demo Staff I', designation: 'Workshop Manager', role: 'Manager',         department: 'Management', status: 'Active',   joined: '2022-11-14', account: 'Active' },
    { id: 'DEMO-010', name: 'Demo Staff J', designation: 'Administrator',    role: 'Admin',           department: 'Management', status: 'Active',   joined: '2022-10-03', account: 'Active' },
    { id: 'DEMO-011', name: 'Demo Staff K', designation: 'Helper',           role: 'Helper',          department: 'Workshop',   status: 'Active',   joined: '2025-07-21', account: null },
    { id: 'DEMO-012', name: 'Demo Staff L', designation: 'Helper',           role: 'Helper',          department: 'Workshop',   status: 'Inactive', joined: '2026-03-02', account: null },
  ].map(s => {
    const letter = s.name.slice(-1).toLowerCase();
    return Object.assign(s, {
      email: `demo.staff.${letter}@example.com`,
      phone: `01XXX-XXX${s.id.slice(-3)}`,
      username: s.account ? `demo.${letter}` : null,
    });
  });

  // The order and colour slot of each role wherever roles are charted or badged.
  const ROLE_ORDER = ['Mechanic', 'Service Advisor', 'Helper', 'Accountant', 'Manager', 'Admin'];
  const roleSlot = role => Math.max(0, ROLE_ORDER.indexOf(role)) + 1;

  const MODULES = ['Dashboard', 'Customers', 'Vehicles', 'Job Cards', 'Inventory', 'Invoices',
    'Payments', 'Expenses', 'Reports', 'Settings', 'Staff Management'];
  const ACTIONS = [['V', 'View'], ['C', 'Create'], ['E', 'Edit'], ['D', 'Delete']];

  // An EXAMPLE layout for the fixed roles, following the decisions recorded so
  // far (Mechanics see only their own job cards, Service Advisors take no
  // counter payments, Accountants see no salary or commission). Nothing here is
  // applied: access is not restricted by role in this release.
  const ROLES = [
    { name: 'Admin', description: 'Full access to every module, including staff, accounts and settings.',
      notes: ['Can manage staff, accounts and roles.', 'At least one active Admin must always remain.'],
      perms: { Dashboard: 'V', Customers: 'VCED', Vehicles: 'VCED', 'Job Cards': 'VCED', Inventory: 'VCED', Invoices: 'VCED',
        Payments: 'VCED', Expenses: 'VCED', Reports: 'V', Settings: 'VE', 'Staff Management': 'VCED' } },
    { name: 'Manager', description: 'Runs the workshop day to day; no access to settings or staff accounts.',
      notes: ['Sees reports for the whole workshop.', 'Cannot change settings or manage accounts.'],
      perms: { Dashboard: 'V', Customers: 'VCE', Vehicles: 'VCE', 'Job Cards': 'VCE', Inventory: 'VCE', Invoices: 'VCE',
        Payments: 'VC', Expenses: 'VC', Reports: 'V', Settings: '', 'Staff Management': 'V' } },
    { name: 'Service Advisor', description: 'Front desk: customers, vehicles, appointments and job cards.',
      notes: ['Cannot take counter payments.', 'Creates invoices for completed job cards.'],
      perms: { Dashboard: 'V', Customers: 'VCE', Vehicles: 'VCE', 'Job Cards': 'VCE', Inventory: 'V', Invoices: 'VC',
        Payments: 'V', Expenses: '', Reports: '', Settings: '', 'Staff Management': '' } },
    { name: 'Mechanic', description: 'Workshop floor: the job cards assigned to them and the parts they use.',
      notes: ['Sees only the job cards assigned to them.', 'No access to invoices, payments or expenses.'],
      perms: { Dashboard: 'V', Customers: '', Vehicles: 'V', 'Job Cards': 'VE', Inventory: 'V', Invoices: '',
        Payments: '', Expenses: '', Reports: '', Settings: '', 'Staff Management': '' } },
    { name: 'Accountant', description: 'Invoices, payments, expenses and financial reports.',
      notes: ['Cannot view salary or commission.', 'Records payments and expenses.'],
      perms: { Dashboard: 'V', Customers: 'V', Vehicles: 'V', 'Job Cards': 'V', Inventory: 'V', Invoices: 'VCE',
        Payments: 'VCE', Expenses: 'VCED', Reports: 'V', Settings: '', 'Staff Management': '' } },
  ];

  // Example activity, so the log's layout can be judged. Activity logging does
  // not exist yet; none of this happened.
  const DEMO_ACTIVITY = [
    ['2026-10-19 17:42', 'Demo Staff F', 'Create',  'Job Cards',  'Created job card JC-DEMO-0142 for a demo vehicle.'],
    ['2026-10-19 16:05', 'Demo Staff H', 'Payment', 'Payments',   'Recorded a demo payment against invoice INV-DEMO-0381.'],
    ['2026-10-19 15:30', 'Demo Staff A', 'Update',  'Job Cards',  'Moved job card JC-DEMO-0139 to In Progress.'],
    ['2026-10-19 11:12', 'Demo Staff I', 'Update',  'Inventory',  'Adjusted the stock of a demo part.'],
    ['2026-10-19 09:01', 'Demo Staff F', 'Sign in', 'Session',    'Signed in.'],
    ['2026-10-18 18:20', 'Demo Staff J', 'Update',  'Settings',   'Changed the invoice footer text.'],
    ['2026-10-18 16:47', 'Demo Staff G', 'Create',  'Customers',  'Added a demo customer.'],
    ['2026-10-18 14:33', 'Demo Staff H', 'Create',  'Expenses',   'Recorded a demo expense.'],
    ['2026-10-18 10:15', 'Demo Staff B', 'Update',  'Job Cards',  'Completed job card JC-DEMO-0131.'],
    ['2026-10-18 09:04', 'Demo Staff A', 'Sign in', 'Session',    'Signed in.'],
    ['2026-10-17 17:58', 'Demo Staff J', 'Create',  'Staff',      'Added staff record DEMO-012.'],
    ['2026-10-17 15:22', 'Demo Staff G', 'Create',  'Invoices',   'Created invoice INV-DEMO-0377.'],
    ['2026-10-17 12:40', 'Demo Staff I', 'Delete',  'Inventory',  'Removed a duplicate demo part.'],
    ['2026-10-17 09:10', 'Demo Staff H', 'Sign in', 'Session',    'Signed in.'],
    ['2026-10-16 16:02', 'Demo Staff F', 'Update',  'Vehicles',   'Updated the mileage of a demo vehicle.'],
    ['2026-10-16 08:55', 'Demo Staff I', 'Sign in', 'Session',    'Signed in.'],
  ].map(([when, user, action, module, description], i) =>
    ({ id: `ACT-DEMO-${String(i + 1).padStart(3, '0')}`, when, user, action, module, description }));

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  const count = (list, pred) => list.filter(pred).length;
  const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

  function summary(staff = DEMO_STAFF) {
    const total = staff.length;
    const active = count(staff, s => s.status === 'Active');
    const accounts = count(staff, s => !!s.account);
    const accountsActive = count(staff, s => s.account === 'Active');
    const byRole = ROLE_ORDER.map(role => ({ role, n: count(staff, s => s.role === role) })).filter(r => r.n);
    return { total, active, inactive: total - active, accounts, accountsActive, accountsInactive: accounts - accountsActive, byRole };
  }

  /** Staff matching a search text and the three filters ('all' = no filter). */
  function filterStaff(list, { q = '', role = 'all', department = 'all', status = 'all' } = {}) {
    const needle = q.trim().toLowerCase();
    return list.filter(s =>
      (!needle || [s.id, s.name, s.designation, s.email, s.department].some(v => v.toLowerCase().includes(needle)))
      && (role === 'all' || s.role === role)
      && (department === 'all' || s.department === department)
      && (status === 'all' || s.status === status));
  }

  /** Activity matching a search text, a user, an action and an inclusive date range. */
  function filterActivity(list, { q = '', user = 'all', action = 'all', from = '', to = '' } = {}) {
    const needle = q.trim().toLowerCase();
    return list.filter(a =>
      (!needle || [a.user, a.action, a.module, a.description].some(v => v.toLowerCase().includes(needle)))
      && (user === 'all' || a.user === user)
      && (action === 'all' || a.action === action)
      && (!from || a.when.slice(0, 10) >= from)
      && (!to || a.when.slice(0, 10) <= to));
  }

  /** One page of a list: the rows, and the 1-based range they cover. */
  function paginate(list, page, size) {
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = Math.min(Math.max(1, page), pages);
    const rows = list.slice((p - 1) * size, p * size);
    return { rows, page: p, pages, from: rows.length ? (p - 1) * size + 1 : 0, to: (p - 1) * size + rows.length, total: list.length };
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** '2024-01-08' -> '08 Jan 2024' (the demo dates are plain strings; no time zone is involved). */
  function fmtDay(iso) {
    const [y, m, d] = iso.split('-');
    return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
  }

  /* ---------- DOM helpers (text only, never HTML) ---------- */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    view: 'M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z',
    edit: 'M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z',
    more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    key: 'M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z',
    power: 'M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    dash: 'M19 13H5v-2h14v2z',
  };

  function svgIcon(name, size = 16) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  /** h('td', { class: 'num', text: '5' }, child, ...) -- attributes and text, never innerHTML. */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    Object.keys(props).forEach(k => {
      const v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    children.forEach(c => { if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  const $ = id => document.getElementById(id);
  function fill(el, ...nodes) { if (!el) return; el.textContent = ''; nodes.forEach(n => el.appendChild(n)); }

  const STATUS_BADGE = { Active: 'badge--good', Inactive: 'badge--bad' };
  const statusBadge = status => h('span', { class: `badge ${STATUS_BADGE[status] || 'badge--neutral'}`, text: status });
  const roleBadge = role => h('span', { class: `stf-role stf-role--${roleSlot(role)}`, text: role });
  const ACTION_BADGE = { Create: 'badge--good', Update: 'badge--info', Delete: 'badge--bad', Payment: 'badge--warn', 'Sign in': 'badge--neutral' };

  /** Avatar and name; `sub` (the staff ID unless told otherwise) underneath, or nothing. */
  function person(s, sub = s.id) {
    return h('div', { class: 'stf-person' },
      h('span', { class: `stf-avatar stf-avatar--${roleSlot(s.role)}`, 'aria-hidden': 'true', text: s.name.slice(-1) }),
      h('span', { class: 'stf-person__text' },
        h('span', { class: 'cell-main', text: s.name }),
        sub ? h('span', { class: 'cell-sub', text: sub }) : null));
  }

  /** An icon button that only explains it is a preview. */
  function previewBtn(icon, label, extraClass = '') {
    return h('button', { type: 'button', class: `icon-btn icon-btn--sm${extraClass}`, title: label, 'aria-label': label, 'data-preview': label }, svgIcon(icon));
  }

  function emptyRow(cols, title, text) {
    return h('tr', { class: 'stf-empty-row' },
      h('td', { colspan: String(cols) },
        h('div', { class: 'stf-empty-row__box' },
          h('strong', { text: title }),
          h('span', { text: text }))));
  }

  /** A donut chart: one conic-gradient ring plus a legend that carries the numbers. */
  function donut(container, legend, parts, centreLabel, describe) {
    const total = parts.reduce((t, p) => t + p.n, 0);
    let at = 0;
    const stops = parts.map(p => {
      const start = at; at += total ? (p.n / total) * 100 : 0;
      return `var(--stf-c${p.slot}) ${start.toFixed(2)}% ${at.toFixed(2)}%`;
    });
    const ring = h('div', { class: 'stf-donut__ring', role: 'img', 'aria-label': describe },
      h('div', { class: 'stf-donut__hole' },
        h('strong', { class: 'stf-donut__total', text: String(total) }),
        h('span', { text: centreLabel })));
    ring.style.background = total ? `conic-gradient(${stops.join(', ')})` : 'var(--line)';
    fill(container, ring);
    fill(legend, ...parts.map(p => h('li', { class: 'stf-legend__row' },
      h('span', { class: `stf-dot stf-dot--${p.slot}`, 'aria-hidden': 'true' }),
      h('span', { class: 'stf-legend__label', text: p.label }),
      h('span', { class: 'stf-legend__n', text: String(p.n) }),
      h('span', { class: 'stf-legend__pct', text: `${pct(p.n, total)}%` }))));
  }

  /** Wire a Previous / Next pager to a render(page) function. */
  function pager(prefix, result, onPage) {
    const prev = $(`${prefix}Prev`), next = $(`${prefix}Next`), range = $(`${prefix}Range`);
    if (range) range.textContent = result.total ? `Showing ${result.from}–${result.to} of ${result.total}` : 'No results';
    if (prev) { prev.disabled = result.page <= 1; prev.onclick = () => onPage(result.page - 1); }
    if (next) { next.disabled = result.page >= result.pages; next.onclick = () => onPage(result.page + 1); }
  }

  /** The "show the empty state" switch in a page's preview notice. */
  function emptyToggle(onChange) {
    const btn = document.querySelector('[data-empty-toggle]');
    if (!btn) return;
    let empty = false;
    btn.addEventListener('click', () => {
      empty = !empty;
      btn.textContent = empty ? 'Show the demo data' : 'Show the empty state';
      btn.setAttribute('aria-pressed', String(empty));
      onChange(empty);
    });
  }

  function options(select, values) {
    if (!select) return;
    values.forEach(v => select.appendChild(h('option', { value: v, text: v })));
  }

  /* ---------- Overview ---------- */

  function renderOverview() {
    const s = summary();
    $('stfTotal').textContent = String(s.total);
    $('stfTotalSub').textContent = `${s.byRole.length} roles`;
    $('stfActive').textContent = String(s.active);
    $('stfActiveSub').textContent = `${pct(s.active, s.total)}% of total`;
    $('stfInactive').textContent = String(s.inactive);
    $('stfInactiveSub').textContent = `${pct(s.inactive, s.total)}% of total`;
    $('stfAccounts').textContent = String(s.accounts);
    $('stfAccountsSub').textContent = `${pct(s.accounts, s.total)}% have an account`;
    $('stfActiveBar').style.width = `${pct(s.active, s.total)}%`;
    $('stfInactiveBar').style.width = `${pct(s.inactive, s.total)}%`;
    $('stfAccountsBar').style.width = `${pct(s.accounts, s.total)}%`;

    donut($('stfRoleChart'), $('stfRoleLegend'),
      s.byRole.map(r => ({ label: r.role, n: r.n, slot: roleSlot(r.role) })), 'Staff',
      `Demo staff by role: ${s.byRole.map(r => `${r.role} ${r.n}`).join(', ')}.`);
    donut($('stfStatusChart'), $('stfStatusLegend'),
      [{ label: 'Active', n: s.active, slot: 'active' }, { label: 'Inactive', n: s.inactive, slot: 'inactive' }], 'Staff',
      `Demo staff status: ${s.active} active, ${s.inactive} inactive.`);

    const recent = DEMO_STAFF.slice().sort((a, b) => b.joined.localeCompare(a.joined)).slice(0, 6);
    fill($('stfRecentBody'), ...recent.map(m => h('tr', {},
      h('td', {}, person(m)),
      h('td', {}, roleBadge(m.role)),
      h('td', { text: m.department }),
      h('td', { class: 'stf-nowrap', text: m.phone }),
      h('td', { text: m.email }),
      h('td', {}, statusBadge(m.status)),
      h('td', { class: 'stf-nowrap', text: fmtDay(m.joined) }),
      h('td', {}, h('div', { class: 'row-actions' }, previewBtn('more', `More actions for ${m.name}`))))));
  }

  /* ---------- Staff List ---------- */

  function renderStaffList() {
    const PAGE = 8;
    const state = { page: 1, empty: false };
    const q = $('stfSearch'), role = $('stfRole'), dept = $('stfDept'), status = $('stfStatus');
    options(role, ROLE_ORDER);
    options(dept, [...new Set(DEMO_STAFF.map(s => s.department))].sort());

    function draw() {
      const source = state.empty ? [] : DEMO_STAFF;
      const list = filterStaff(source, { q: q.value, role: role.value, department: dept.value, status: status.value });
      const res = paginate(list, state.page, PAGE);
      state.page = res.page;
      $('stfListEmpty').hidden = source.length > 0;
      $('stfListCard').hidden = source.length === 0;
      $('stfListCount').textContent = `${list.length} of ${source.length} staff`;
      fill($('stfListBody'), ...(res.rows.length ? res.rows.map(m => h('tr', {},
        h('td', { class: 'stf-nowrap', text: m.id }),
        h('td', {}, person(m, null)),
        h('td', { text: m.designation }),
        h('td', { text: m.department }),
        h('td', { class: 'stf-nowrap', text: m.phone }),
        h('td', { text: m.email }),
        h('td', {}, statusBadge(m.status)),
        h('td', { class: 'stf-nowrap', text: fmtDay(m.joined) }),
        h('td', {}, h('div', { class: 'row-actions' },
          previewBtn('view', `View ${m.name}`), previewBtn('edit', `Edit ${m.name}`), previewBtn('more', `More actions for ${m.name}`)))))
        : [emptyRow(9, 'No staff match these filters', 'Try a different search, or clear the filters.')]));
      pager('stfList', res, p => { state.page = p; draw(); });
    }
    [q, role, dept, status].forEach(c => c.addEventListener(c === q ? 'input' : 'change', () => { state.page = 1; draw(); }));
    $('stfListClear').addEventListener('click', () => { q.value = ''; role.value = 'all'; dept.value = 'all'; status.value = 'all'; state.page = 1; draw(); });
    emptyToggle(empty => { state.empty = empty; state.page = 1; draw(); });
    draw();
  }

  /* ---------- User Accounts ---------- */

  function renderAccounts() {
    const s = summary();
    $('stfAccTotal').textContent = String(s.accounts);
    $('stfAccActive').textContent = String(s.accountsActive);
    $('stfAccInactive').textContent = String(s.accountsInactive);
    $('stfAccNone').textContent = String(s.total - s.accounts);
    const withAccount = DEMO_STAFF.filter(m => m.account);
    const q = $('stfAccSearch'), role = $('stfAccRole'), status = $('stfAccStatus');
    options(role, ROLE_ORDER.filter(r => withAccount.some(m => m.role === r)));

    function draw() {
      const needle = q.value.trim().toLowerCase();
      const list = withAccount.filter(m =>
        (!needle || [m.name, m.id, m.username].some(v => v.toLowerCase().includes(needle)))
        && (role.value === 'all' || m.role === role.value)
        && (status.value === 'all' || m.account === status.value));
      $('stfAccCount').textContent = `${list.length} of ${withAccount.length} accounts`;
      fill($('stfAccBody'), ...(list.length ? list.map(m => h('tr', {},
        h('td', {}, person(m)),
        h('td', { class: 'stf-mono', text: m.username }),
        h('td', {}, roleBadge(m.role)),
        h('td', {}, statusBadge(m.account)),
        h('td', {}, h('div', { class: 'row-actions' },
          previewBtn('key', `Reset password for ${m.name}`),
          previewBtn('power', `${m.account === 'Active' ? 'Deactivate' : 'Activate'} the account of ${m.name}`)))))
        : [emptyRow(5, 'No accounts match these filters', 'Try a different search, or clear the filters.')]));
    }
    [q, role, status].forEach(c => c.addEventListener(c === q ? 'input' : 'change', draw));
    draw();
  }

  /* ---------- Roles & Permissions ---------- */

  function renderRoles() {
    const list = $('stfRoleList');
    let current = ROLES[0].name;

    function drawDetails() {
      const role = ROLES.find(r => r.name === current);
      const members = DEMO_STAFF.filter(m => m.role === role.name).length;
      $('stfRoleName').textContent = role.name;
      $('stfRoleDesc').textContent = role.description;
      $('stfRoleMembers').textContent = `${members} demo staff member${members === 1 ? '' : 's'}`;
      fill($('stfRoleNotes'), ...role.notes.map(n => h('li', { text: n })));
      fill($('stfMatrixBody'), ...MODULES.map(mod => h('tr', {},
        h('th', { scope: 'row', text: mod }),
        ...ACTIONS.map(([k, label]) => {
          const yes = (role.perms[mod] || '').includes(k);
          return h('td', { class: 'stf-perm' },
            h('span', { class: `stf-perm__mark ${yes ? 'is-yes' : 'is-no'}`, title: `${label}: ${yes ? 'allowed' : 'not allowed'}` },
              svgIcon(yes ? 'check' : 'dash', 14),
              h('span', { class: 'stf-sr-only', text: `${label} ${yes ? 'allowed' : 'not allowed'}` })));
        }))));
      [...list.querySelectorAll('button[data-role]')].forEach(b => {
        const on = b.getAttribute('data-role') === current;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }

    fill(list, ...ROLES.map(r => {
      const members = DEMO_STAFF.filter(m => m.role === r.name).length;
      const btn = h('button', { type: 'button', class: 'stf-rolecard', 'data-role': r.name, 'aria-pressed': 'false' },
        h('span', { class: `stf-avatar stf-avatar--${roleSlot(r.name)}`, 'aria-hidden': 'true', text: r.name.charAt(0) }),
        h('span', { class: 'stf-rolecard__text' },
          h('span', { class: 'stf-rolecard__name', text: r.name }),
          h('span', { class: 'stf-rolecard__meta', text: `${members} demo staff · ${MODULES.filter(m => r.perms[m]).length} modules` })));
      btn.addEventListener('click', () => { current = r.name; drawDetails(); });
      return btn;
    }));
    drawDetails();
  }

  /* ---------- Activity Log ---------- */

  function renderActivity() {
    const PAGE = 10;
    const state = { page: 1, empty: false };
    const today = DEMO_ACTIVITY[0].when.slice(0, 10);
    $('stfActTotal').textContent = String(DEMO_ACTIVITY.length);
    $('stfActToday').textContent = String(count(DEMO_ACTIVITY, a => a.when.startsWith(today)));
    $('stfActSignins').textContent = String(count(DEMO_ACTIVITY, a => a.action === 'Sign in'));
    $('stfActChanges').textContent = String(count(DEMO_ACTIVITY, a => a.action !== 'Sign in'));
    const q = $('stfActSearch'), user = $('stfActUser'), action = $('stfActAction'), from = $('stfActFrom'), to = $('stfActTo');
    options(user, [...new Set(DEMO_ACTIVITY.map(a => a.user))].sort());
    options(action, [...new Set(DEMO_ACTIVITY.map(a => a.action))].sort());

    function showDetails(a) {
      const panel = $('stfActDetails');
      const rows = [['Reference', a.id], ['Date & time', a.when], ['User', a.user], ['Action', a.action], ['Module', a.module], ['Description', a.description]];
      fill($('stfActDetailsList'), ...rows.map(([k, v]) => h('div', { class: 'stf-dl__row' }, h('dt', { text: k }), h('dd', { text: v }))));
      panel.hidden = false;
      panel.scrollIntoView({ block: 'nearest' });
      $('stfActDetailsClose').focus();
    }
    $('stfActDetailsClose').addEventListener('click', () => { $('stfActDetails').hidden = true; });

    function draw() {
      const source = state.empty ? [] : DEMO_ACTIVITY;
      const bad = from.value && to.value && from.value > to.value;
      $('stfActRangeError').hidden = !bad;
      const list = bad ? [] : filterActivity(source, { q: q.value, user: user.value, action: action.value, from: from.value, to: to.value });
      const res = paginate(list, state.page, PAGE);
      state.page = res.page;
      $('stfActEmpty').hidden = source.length > 0;
      $('stfActCard').hidden = source.length === 0;
      $('stfActCount').textContent = `${list.length} of ${source.length} entries`;
      fill($('stfActBody'), ...(res.rows.length ? res.rows.map(a => {
        const view = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': `View details of ${a.id}` }, 'View');
        view.addEventListener('click', () => showDetails(a));
        return h('tr', {},
          h('td', { class: 'stf-nowrap', text: a.when }),
          h('td', { text: a.user }),
          h('td', {}, h('span', { class: `badge ${ACTION_BADGE[a.action] || 'badge--neutral'}`, text: a.action })),
          h('td', { text: a.module }),
          h('td', { class: 'stf-desc', text: a.description }),
          h('td', {}, view));
      }) : [emptyRow(6, bad ? 'The date range is not valid' : 'No activity matches these filters',
        bad ? '"From" must be on or before "To".' : 'Try a different search, or clear the filters.')]));
      pager('stfAct', res, p => { state.page = p; draw(); });
    }
    [q, user, action, from, to].forEach(c => c.addEventListener(c === q ? 'input' : 'change', () => { state.page = 1; draw(); }));
    $('stfActClear').addEventListener('click', () => { q.value = ''; user.value = 'all'; action.value = 'all'; from.value = ''; to.value = ''; state.page = 1; draw(); });
    emptyToggle(empty => { state.empty = empty; state.page = 1; $('stfActDetails').hidden = true; draw(); });
    draw();
  }

  /* ---------- every page ---------- */

  const RENDER = {
    'staff-management': renderOverview,
    'staff-list': renderStaffList,
    'staff-accounts': renderAccounts,
    'staff-roles': renderRoles,
    'staff-activity-log': renderActivity,
  };

  // Every action that would change something only says it is not available.
  function explainPreview(e) {
    const btn = e.target.closest('[data-preview]');
    if (!btn) return;
    e.preventDefault();
    Utils.toast(`Preview only: "${btn.getAttribute('data-preview')}" is not available yet. Nothing was saved or sent.`, 'info');
  }

  function init() {
    const page = document.body.dataset.page || '';
    if (!page.startsWith('staff-')) return;
    document.addEventListener('click', explainPreview);
    if (RENDER[page]) RENDER[page]();
  }

  return { DEMO_STAFF, DEMO_ACTIVITY, ROLES, MODULES, ROLE_ORDER, summary, filterStaff, filterActivity, paginate, fmtDay, init };
})();

// The page's markup is already parsed (this script is at the end of <body>),
// so it is filled in now -- before the shell reveals the content area.
if (typeof document !== 'undefined' && document.body && document.body.dataset) StaffUI.init();
