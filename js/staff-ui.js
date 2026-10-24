/* ============================================================
   staff-ui.js — Staff Management › Performance (UI PREVIEW ONLY)
   ------------------------------------------------------------
   Loaded by one Staff Management page (Performance). The page says
   which it is through <body data-page="...">, and this file fills
   it in from the DEMO data below.

   Overview, Staff List, Add Staff, User Accounts, Roles & Permissions,
   Attendance, Leave Management and Activity Log are NOT previews:
   they work from the workshop database through js/staff-overview.js,
   js/staff-list.js, js/staff-add.js, js/staff-accounts.js,
   js/staff-roles.js, js/staff-attendance.js, js/staff-leave.js and
   js/staff-activity-log.js and never load this file, so nothing here
   can reach them.

   What this file deliberately does NOT do:
     - read or write the workshop database (no Api, no Storage);
     - read or write browser storage;
     - send anything anywhere, or read a chosen file;
     - create staff, accounts, passwords, permissions or activity entries;
     - measure performance.

   Sorting and the empty-state switch work on the demo list in
   memory, so the layout can be judged with realistic amounts of
   content. All content is built with textContent -- nothing from
   the data is parsed as HTML.
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

  // Sample performance figures for the workshop's demo staff. Nothing is measured
  // yet; every number is invented so the layout can be judged.
  // [staff, completed jobs, of which on time, average turnaround in hours, labour value in Tk]
  const PERFORMANCE_PERIOD = 'October 2026 (demo)';
  const DEMO_PERFORMANCE = [
    ['DEMO-001', 46, 42, 5.2, 92000],
    ['DEMO-002', 38, 31, 6.8, 71500],
    ['DEMO-003', 33, 30, 5.9, 60500],
    ['DEMO-004', 27, 22, 7.4, 58000],
    ['DEMO-011', 12, 11, 4.1, 9600],
  ].map(([staffId, jobs, onTime, turnaround, labour]) => ({ staffId, jobs, onTime, turnaround, labour }));

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  const count = (list, pred) => list.filter(pred).length;
  const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

  /** Staff matching a search text and the three filters ('all' = no filter). */
  function filterStaff(list, { q = '', role = 'all', department = 'all', status = 'all' } = {}) {
    const needle = q.trim().toLowerCase();
    return list.filter(s =>
      (!needle || [s.id, s.name, s.designation, s.email, s.department].some(v => v.toLowerCase().includes(needle)))
      && (role === 'all' || s.role === role)
      && (department === 'all' || s.department === department)
      && (status === 'all' || s.status === status));
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

  const byId = id => DEMO_STAFF.find(s => s.id === id);

  /** Each staff member's sample figures plus their on-time percentage. */
  function performanceRows(list = DEMO_PERFORMANCE) {
    return list.map(p => Object.assign({ staff: byId(p.staffId), onTimePct: pct(p.onTime, p.jobs) }, p));
  }

  /** The workshop totals: jobs, on-time share, job-weighted average turnaround (one decimal) and labour value. */
  function performanceSummary(list = DEMO_PERFORMANCE) {
    const jobs = list.reduce((t, p) => t + p.jobs, 0);
    const onTime = list.reduce((t, p) => t + p.onTime, 0);
    const hours = list.reduce((t, p) => t + p.jobs * p.turnaround, 0);
    return { jobs, onTime, onTimePct: pct(onTime, jobs), turnaround: jobs ? Math.round((hours / jobs) * 10) / 10 : 0,
      labour: list.reduce((t, p) => t + p.labour, 0) };
  }

  /** Best first: most jobs, highest on-time share, shortest turnaround or most labour value. */
  function sortPerformance(rows, key) {
    const by = { jobs: (a, b) => b.jobs - a.jobs, onTime: (a, b) => b.onTimePct - a.onTimePct || b.jobs - a.jobs,
      turnaround: (a, b) => a.turnaround - b.turnaround, labour: (a, b) => b.labour - a.labour }[key] || ((a, b) => b.jobs - a.jobs);
    return rows.slice().sort(by);
  }

  /** Demo amounts in taka. Deliberately not Utils.money: that reads the workshop's saved settings. */
  const taka = n => `৳ ${n.toLocaleString('en-IN')}`;

  /* ---------- DOM helpers (text only, never HTML) ---------- */

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

  const roleBadge = role => h('span', { class: `stf-role stf-role--${roleSlot(role)}`, text: role });

  /** Avatar and name; `sub` (the staff ID unless told otherwise) underneath, or nothing. */
  function person(s, sub = s.id) {
    return h('div', { class: 'stf-person' },
      h('span', { class: `stf-avatar stf-avatar--${roleSlot(s.role)}`, 'aria-hidden': 'true', text: s.name.slice(-1) }),
      h('span', { class: 'stf-person__text' },
        h('span', { class: 'cell-main', text: s.name }),
        sub ? h('span', { class: 'cell-sub', text: sub }) : null));
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

  /* ---------- Performance ---------- */

  function renderPerformance() {
    const state = { empty: false };
    const sort = $('stfPerfSort');
    $('stfPerfPeriod').textContent = PERFORMANCE_PERIOD;

    function draw() {
      const source = state.empty ? [] : DEMO_PERFORMANCE;
      const s = performanceSummary(source);
      $('stfPerfJobs').textContent = String(s.jobs);
      $('stfPerfOnTime').textContent = `${s.onTimePct}%`;
      $('stfPerfOnTimeSub').textContent = `${s.onTime} of ${s.jobs} jobs (demo)`;
      $('stfPerfTurnaround').textContent = `${s.turnaround.toFixed(1)} h`;
      $('stfPerfLabour').textContent = taka(s.labour);
      $('stfPerfEmpty').hidden = source.length > 0;
      $('stfPerfCard').hidden = source.length === 0;
      const rows = sortPerformance(performanceRows(source), sort.value);
      fill($('stfPerfBody'), ...rows.map((r, i) => {
        const bar = h('span', { class: 'stf-bar__fill stf-bar__fill--good' });
        bar.style.width = `${r.onTimePct}%`;
        return h('tr', {},
          h('td', { class: 'num', text: String(i + 1) }),
          h('td', {}, person(r.staff)),
          h('td', {}, roleBadge(r.staff.role)),
          h('td', { class: 'num', text: String(r.jobs) }),
          h('td', { class: 'stf-perf__ontime' },
            h('span', { class: 'stf-perf__pct', text: `${r.onTimePct}%` }),
            h('span', { class: 'stf-bar', 'aria-hidden': 'true' }, bar)),
          h('td', { class: 'num stf-nowrap', text: `${r.turnaround.toFixed(1)} h` }),
          h('td', { class: 'num stf-nowrap', text: taka(r.labour) }));
      }));
    }
    sort.addEventListener('change', draw);
    emptyToggle(empty => { state.empty = empty; draw(); });
    draw();
  }

  /* ---------- every page ---------- */

  const RENDER = {
    'staff-performance': renderPerformance,
  };

  function init() {
    const page = document.body.dataset.page || '';
    if (!page.startsWith('staff-')) return;
    if (RENDER[page]) RENDER[page]();
  }

  return { DEMO_STAFF, ROLE_ORDER, filterStaff, paginate, fmtDay, init,
    PERFORMANCE_PERIOD, DEMO_PERFORMANCE, performanceRows, performanceSummary, sortPerformance, taka };
})();

// The page's markup is already parsed (this script is at the end of <body>),
// so it is filled in now -- before the shell reveals the content area.
if (typeof document !== 'undefined' && document.body && document.body.dataset) StaffUI.init();
