/* ============================================================
   asset-reports-ui.js — Workshop Assets › Asset Reports
   (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/asset-reports.html. Hands the shared engine
   (js/workshop-assets-demo.js) the FICTIONAL sample assets and
   maintenance spending below and draws them as simple CSS bar charts,
   the same way the Reports page draws its revenue chart: no chart
   library is added. Nothing is read from or written to the database
   or browser storage, and no request is made: Export Preview only
   shows the sample rows as text.
   ============================================================ */

const AssetReportsUI = (() => {
  const A = AssetDemo;

  const CATEGORIES = ['Lifting', 'Air & Pneumatics', 'Wheel & Tyre', 'AC & Cooling', 'Workshop Machinery', 'Diagnostic', 'Hand Tools'];

  // Fourteen sample assets: the equipment of Equipment Inventory plus a few tools.
  // `use` is the sample utilisation: share of working hours in use last month.
  const SAMPLE = [
    { name: 'Two Post Car Lift', code: 'DEMO-EQ-001', category: 'Lifting', qty: 2, value: 770000, status: 'In Use', purchased: '2024-03-12', use: 86 },
    { name: 'Four Post Car Lift', code: 'DEMO-EQ-002', category: 'Lifting', qty: 1, value: 520000, status: 'Available', purchased: '2023-08-20', use: 54 },
    { name: 'Air Compressor', code: 'DEMO-EQ-003', category: 'Air & Pneumatics', qty: 1, value: 145000, status: 'Under Maintenance', purchased: '2022-11-05', use: 38 },
    { name: 'Wheel Alignment Machine', code: 'DEMO-EQ-004', category: 'Wheel & Tyre', qty: 1, value: 890000, status: 'In Use', purchased: '2025-01-18', use: 72 },
    { name: 'Tyre Changer', code: 'DEMO-EQ-005', category: 'Wheel & Tyre', qty: 2, value: 330000, status: 'Available', purchased: '2024-06-02', use: 61 },
    { name: 'AC Recovery Machine', code: 'DEMO-EQ-006', category: 'AC & Cooling', qty: 1, value: 240000, status: 'Available', purchased: '2025-07-09', use: 29 },
    { name: 'Hydraulic Press', code: 'DEMO-EQ-007', category: 'Workshop Machinery', qty: 1, value: 98000, status: 'Under Maintenance', purchased: '2021-09-14', use: 12 },
    { name: 'Engine Crane', code: 'DEMO-EQ-008', category: 'Lifting', qty: 1, value: 72000, status: 'In Use', purchased: '2026-10-12', use: 44 },
    { name: 'OBD-II Scanner', code: 'DEMO-TL-001', category: 'Diagnostic', qty: 3, value: 135000, status: 'In Use', purchased: '2025-03-03', use: 78 },
    { name: 'Coolant Pressure Tester', code: 'DEMO-TL-010', category: 'Diagnostic', qty: 1, value: 18000, status: 'Available', purchased: '2026-08-21', use: 22 },
    { name: 'Torque Wrench Set', code: 'DEMO-TL-004', category: 'Hand Tools', qty: 4, value: 48000, status: 'In Use', purchased: '2024-12-09', use: 69 },
    { name: 'Spark Plug Socket Kit', code: 'DEMO-TL-007', category: 'Hand Tools', qty: 3, value: 9000, status: 'Available', purchased: '2026-10-02', use: 35 },
    { name: 'Hydraulic Floor Jack', code: 'DEMO-TL-003', category: 'Lifting', qty: 4, value: 56000, status: 'In Use', purchased: '2023-02-14', use: 81 },
    { name: 'Timing Light', code: 'DEMO-TL-008', category: 'Diagnostic', qty: 1, value: 12000, status: 'Available', purchased: '2022-05-30', use: 9 },
  ];

  // Sample maintenance spending per month (whole Taka), oldest first.
  const MONTHLY = [
    ['2025-11', 8200], ['2025-12', 5400], ['2026-01', 12800], ['2026-02', 3900], ['2026-03', 9600], ['2026-04', 7000],
    ['2026-05', 13200], ['2026-06', 4800], ['2026-07', 6500], ['2026-08', 9200], ['2026-09', 15300], ['2026-10', 21100],
  ];
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Totals over a set of assets (units for counts, value for money). */
  function totals(rows) {
    const units = s => rows.filter(r => !s || r.status === s).reduce((n, r) => n + r.qty, 0);
    return { value: rows.reduce((n, r) => n + r.value, 0), assets: units(), available: units('Available'), inUse: units('In Use'), maintenance: units('Under Maintenance') };
  }

  /** The months of spending inside a date range ('all', '30', '90' or '365'). */
  function monthsIn(range) {
    const keep = { all: 12, 365: 12, 90: 3, 30: 1 }[range] || 12;
    return MONTHLY.slice(-keep);
  }

  /** Sum of a grouping: [[key, amount], ...] sorted largest first. */
  function groupSum(rows, key, amount) {
    const m = new Map();
    for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + amount(r));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  /** A horizontal bar list: items [label, value, display]. */
  function hbars(items, tone) {
    const max = Math.max(1, ...items.map(i => i[1]));
    const ul = A.el('ul', `ar-hbars ad-tone--${tone}`);
    for (const [label, v, shown] of items) {
      const li = A.el('li', 'ar-hbar');
      const head = A.el('div', 'ar-hbar__head');
      head.append(A.el('span', 'ar-hbar__label', label), A.el('span', 'ar-hbar__value', shown));
      const track = A.el('div', 'ar-hbar__track');
      const fill = A.el('div', 'ar-hbar__fill');
      fill.style.width = `${Math.round(v / max * 100)}%`;
      track.appendChild(fill);
      li.append(head, track);
      ul.appendChild(li);
    }
    return ul;
  }

  /** A vertical column chart: items [label, value, display]. */
  function columns(items) {
    const max = Math.max(1, ...items.map(i => i[1]));
    const wrap = A.el('div', 'ar-cols');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', items.map(([l, , s]) => `${l}: ${s}`).join(', '));
    for (const [label, v, shown] of items) {
      const col = A.el('div', 'ar-col');
      col.title = `${label}: ${shown}`;
      const barWrap = A.el('div', 'ar-col__wrap');
      const bar = A.el('div', 'ar-col__bar');
      bar.style.height = `${Math.max(2, Math.round(v / max * 100))}%`;
      barWrap.appendChild(bar);
      col.append(A.el('span', 'ar-col__value', shown), barWrap, A.el('span', 'ar-col__label', label));
      wrap.appendChild(col);
    }
    return wrap;
  }

  /** A two-part split bar: Available vs In Use (plus Under Maintenance). */
  function split(t) {
    const total = Math.max(1, t.assets);
    const wrap = A.el('div', 'ar-split');
    const bar = A.el('div', 'ar-split__bar');
    const legend = A.el('ul', 'ar-legend');
    for (const [label, n, cls] of [['Available', t.available, 'good'], ['In Use', t.inUse, 'amber'], ['Under Maintenance', t.maintenance, 'bad']]) {
      const seg = A.el('div', `ar-split__seg ad-tone--${cls}`);
      seg.style.width = `${n / total * 100}%`;
      seg.title = `${label}: ${n}`;
      bar.appendChild(seg);
      const li = A.el('li', `ad-tone--${cls}`);
      li.append(A.el('span', 'ar-legend__dot'), A.el('span', null, `${label}: ${n} (${Math.round(n / total * 100)}%)`));
      legend.appendChild(li);
    }
    wrap.append(bar, legend);
    return wrap;
  }

  function chartCard(title, iconName, content, wide) {
    const card = A.el('section', `card ar-chart${wide ? ' ar-chart--wide' : ''}`);
    const head = A.el('div', 'ad-panel__head');
    const ic = A.el('span', 'ad-panel__icon'); ic.appendChild(A.icon(iconName, 18));
    head.append(ic, A.el('h3', null, title));
    card.append(head, content);
    return card;
  }

  let currentRange = 'all';

  /** Everything below the toolbar, drawn from the assets the filters leave. */
  function report(rows) {
    const t = totals(rows);
    const months = monthsIn(currentRange);
    const spend = months.reduce((n, [, v]) => n + v, 0);
    const avgUse = Math.round(rows.reduce((n, r) => n + r.use, 0) / Math.max(1, rows.length));
    const top = [...rows].sort((a, b) => b.use - a.use)[0];

    const grid = A.el('div', 'ar-grid');
    const summary = A.el('section', 'card ar-chart ar-chart--wide ar-summary');
    const sh = A.el('div', 'ad-panel__head');
    const si = A.el('span', 'ad-panel__icon'); si.appendChild(A.icon('info', 18));
    sh.append(si, A.el('h3', null, 'Report Summary'));
    const ul = A.el('ul', 'ar-summary__list');
    for (const line of [
      `${t.assets} sample units across ${new Set(rows.map(r => r.category)).size} categories, worth ${A.money(t.value)}.`,
      `${t.available} available, ${t.inUse} in use and ${t.maintenance} under maintenance.`,
      `Maintenance spending in the period: ${A.money(spend)} over ${months.length} ${months.length === 1 ? 'month' : 'months'}.`,
      `Average utilisation ${avgUse}%${top ? `; busiest: ${top.name} (${top.use}%)` : ''}.`,
    ]) ul.appendChild(A.el('li', null, line));
    summary.append(sh, ul);
    grid.appendChild(summary);

    grid.append(
      chartCard('Asset Category Distribution', 'package', hbars(groupSum(rows, 'category', r => r.qty).map(([k, v]) => [k, v, `${v} ${v === 1 ? 'unit' : 'units'}`]), 'info')),
      chartCard('Available vs In Use', 'check', split(t)),
      chartCard('Monthly Maintenance Expenses', 'coins', columns(months.map(([m, v]) => [MONTH_NAMES[Number(m.slice(5)) - 1], v, A.money(v)])), true),
      chartCard('Asset Purchase Value', 'cart', hbars(groupSum(rows, 'category', r => r.value).map(([k, v]) => [k, v, A.money(v)]), 'violet')),
      chartCard('Equipment Utilization', 'chart', hbars([...rows].sort((a, b) => b.use - a.use).slice(0, 8).map(r => [r.name, r.use, `${r.use}%`]), 'amber')),
    );
    return grid;
  }

  function start() {
    const t = totals(SAMPLE);
    const view = A.mount({
      title: 'Asset Reports', icon: 'chart',
      subtitle: 'Asset value, availability, utilisation and maintenance spending at a glance.',
      cards: [
        { label: 'Total Asset Value', value: A.money(t.value), money: true, sub: 'Purchase value', icon: 'coins', tone: 'violet' },
        { label: 'Total Assets', value: t.assets, sub: `${SAMPLE.length} asset types`, icon: 'package', tone: 'info' },
        { label: 'Available Assets', value: t.available, sub: 'Ready to use', icon: 'check', tone: 'good' },
        { label: 'Assets In Use', value: t.inUse, sub: 'Working right now', icon: 'userCheck', tone: 'amber' },
        { label: 'Maintenance Expenses', value: A.money(MONTHLY.reduce((n, [, v]) => n + v, 0)), money: true, sub: 'Last 12 months', icon: 'wrench', tone: 'bad' },
      ],
      rows: SAMPLE, noun: 'assets', emptyTitle: 'No assets match these filters', listLabel: 'Asset reports',
      search: { placeholder: 'Search asset or code…', fields: ['name', 'code', 'category'] },
      filters: [
        { id: 'category', label: 'Filter by category', allLabel: 'All Categories', options: CATEGORIES, match: (r, v) => r.category === v },
      ],
      // The date range narrows the maintenance months; the assets are always the full register.
      date: { label: 'Report period', get: () => A.DEMO_TODAY, ranges: ['all', '30', '90', '365'] },
      columns: [
        { label: 'Asset', csv: r => r.name }, { label: 'Code', csv: r => r.code }, { label: 'Category', csv: r => r.category },
        { label: 'Quantity', csv: r => r.qty }, { label: 'Purchase Value', csv: r => r.value }, { label: 'Status', csv: r => r.status },
        { label: 'Utilisation %', csv: r => r.use },
      ],
      view: report,
    });
    const range = document.getElementById('adf-date');
    if (range && view) {
      range.addEventListener('change', () => { currentRange = range.value; view.draw(); });
    }
  }

  A.boot('asset-reports', start);
  return { SAMPLE, MONTHLY, totals, monthsIn, groupSum };
})();
