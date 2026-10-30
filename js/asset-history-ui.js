/* ============================================================
   asset-history-ui.js — Workshop Assets › Asset History
   (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/asset-history.html. Hands the shared engine
   (js/workshop-assets-demo.js) the FICTIONAL sample activities below
   and draws them as a timeline. Nothing is read from or written to
   the database or browser storage, and no request is made: the asset
   details view is a preview of sample data.
   ============================================================ */

const AssetHistoryUI = (() => {
  const A = AssetDemo;

  // Activity types: icon and tone of the timeline dot, and the item's title.
  const TYPES = {
    'Asset Purchased': ['cart', 'violet', 'New asset added to the workshop'],
    'Asset Assigned': ['userCheck', 'amber', 'Issued to a mechanic'],
    'Asset Returned': ['undo', 'good', 'Returned to the store'],
    'Maintenance Completed': ['check', 'info', 'Service completed'],
    'Repair Recorded': ['wrench', 'bad', 'Repair logged'],
    'Status Changed': ['refresh', 'neutral', 'Status updated'],
  };

  const ASSETS = {
    'DEMO-EQ-001': ['Two Post Car Lift', 'Lifting', 'In Use'],
    'DEMO-EQ-003': ['Air Compressor', 'Air & Pneumatics', 'Under Maintenance'],
    'DEMO-EQ-004': ['Wheel Alignment Machine', 'Wheel & Tyre', 'In Use'],
    'DEMO-EQ-006': ['AC Recovery Machine', 'AC & Cooling', 'Available'],
    'DEMO-EQ-007': ['Hydraulic Press', 'Workshop Machinery', 'Under Maintenance'],
    'DEMO-EQ-008': ['Engine Crane', 'Lifting', 'In Use'],
    'DEMO-TL-001': ['OBD-II Scanner', 'Diagnostic', 'Assigned'],
    'DEMO-TL-003': ['Hydraulic Floor Jack', 'Lifting', 'Overdue'],
    'DEMO-TL-005': ['Battery Tester', 'Electrical', 'Available'],
  };

  // Fourteen sample activities, newest first.
  const SAMPLE = [
    { date: '2026-10-29', type: 'Asset Assigned', code: 'DEMO-TL-001', by: 'Store Keeper (Demo)', text: 'Issued to Rahim Uddin (Demo) for a diagnostic job.' },
    { date: '2026-10-27', type: 'Status Changed', code: 'DEMO-TL-003', by: 'System (Demo)', text: 'Marked Overdue: expected return of 22 Oct passed.' },
    { date: '2026-10-24', type: 'Asset Returned', code: 'DEMO-TL-005', by: 'Store Keeper (Demo)', text: 'Returned by Rahim Uddin (Demo) in good condition.' },
    { date: '2026-10-21', type: 'Repair Recorded', code: 'DEMO-EQ-003', by: 'Karim Sheikh (Demo)', text: 'Pressure switch failed; sent for repair (estimate ৳18,500).' },
    { date: '2026-10-21', type: 'Status Changed', code: 'DEMO-EQ-003', by: 'Karim Sheikh (Demo)', text: 'Available → Under Maintenance.' },
    { date: '2026-10-15', type: 'Asset Assigned', code: 'DEMO-TL-003', by: 'Store Keeper (Demo)', text: 'Issued to Karim Sheikh (Demo), due back 22 Oct.' },
    { date: '2026-10-12', type: 'Asset Purchased', code: 'DEMO-EQ-008', by: 'Workshop Manager (Demo)', text: 'New engine crane bought for ৳72,000 (sample invoice).' },
    { date: '2026-10-12', type: 'Maintenance Completed', code: 'DEMO-EQ-008', by: 'Karim Sheikh (Demo)', text: 'Delivery inspection passed.' },
    { date: '2026-10-05', type: 'Maintenance Completed', code: 'DEMO-EQ-006', by: 'Salim Ahmed (Demo)', text: 'Filter drier checked; vacuum pump oil changed.' },
    { date: '2026-09-22', type: 'Repair Recorded', code: 'DEMO-EQ-001', by: 'External Vendor (Demo)', text: 'Replaced a worn equaliser cable (৳14,500).' },
    { date: '2026-08-15', type: 'Repair Recorded', code: 'DEMO-EQ-007', by: 'Karim Sheikh (Demo)', text: 'Hydraulic oil leak found; seal kit ordered.' },
    { date: '2026-08-15', type: 'Status Changed', code: 'DEMO-EQ-007', by: 'Karim Sheikh (Demo)', text: 'Available → Under Maintenance.' },
    { date: '2026-05-10', type: 'Maintenance Completed', code: 'DEMO-EQ-004', by: 'External Vendor (Demo)', text: 'Six-monthly sensor calibration done.' },
    { date: '2025-01-18', type: 'Asset Purchased', code: 'DEMO-EQ-004', by: 'Workshop Manager (Demo)', text: 'Wheel alignment machine bought for ৳890,000 (sample invoice).' },
  ].map(r => Object.assign(r, { asset: ASSETS[r.code][0] }));

  /** How many activities of each type. */
  function counts(rows) {
    const c = {};
    for (const t of Object.keys(TYPES)) c[t] = rows.filter(r => r.type === t).length;
    return c;
  }

  function assetPreview(code) {
    const [name, category, status] = ASSETS[code];
    const events = SAMPLE.filter(r => r.code === code);
    const wrap = A.el('div');
    wrap.appendChild(A.details([['Asset', name], ['Asset code', code], ['Category', category], ['Current status', A.badge(status)], ['Recorded activities', events.length]]));
    const list = A.el('ul', 'ad-mini ah-preview');
    for (const e of events) {
      const li = A.el('li');
      const text = A.el('span', 'ad-mini__text');
      text.append(A.el('span', 'ad-mini__title', e.type), A.el('span', 'ad-mini__sub', e.text));
      li.append(text, A.el('span', 'ad-mini__side', A.fmtDate(e.date)));
      list.appendChild(li);
    }
    wrap.appendChild(list);
    A.openModal({ title: `${name} — history`, body: wrap });
  }

  /** The timeline: one item per activity, grouped under its month. */
  function timeline(rows) {
    const ol = A.el('ol', 'ah-timeline');
    let month = '';
    for (const r of rows) {
      const m = A.fmtDate(r.date).replace(/^\d+ /, '');
      if (m !== month) {
        month = m;
        ol.appendChild(A.el('li', 'ah-month', m));
      }
      const [ic, tone, title] = TYPES[r.type];
      const li = A.el('li', `ah-item ad-tone--${tone}`);
      const dot = A.el('span', 'ah-dot'); dot.appendChild(A.icon(ic, 16));
      const body = A.el('div', 'ah-body');
      const top = A.el('div', 'ah-top');
      top.append(A.el('h3', 'ah-title', title), A.el('span', 'ah-type', r.type), A.el('time', 'ah-date', A.fmtDate(r.date)));
      top.querySelector('time').setAttribute('datetime', r.date);
      const asset = A.el('p', 'ah-asset');
      asset.append(A.el('span', 'ah-asset__name', r.asset), A.el('span', 'ad-code', r.code));
      const meta = A.el('p', 'ah-meta');
      meta.append(A.icon('user', 14), A.el('span', null, `Performed by ${r.by}`));
      const view = A.el('button', 'btn btn--ghost btn--sm ah-view');
      view.type = 'button';
      view.append(A.icon('eye', 15), A.el('span', null, 'Asset details'));
      view.setAttribute('aria-label', `Asset details: ${r.asset}`);
      view.addEventListener('click', () => assetPreview(r.code));
      body.append(top, asset, A.el('p', 'ah-text', r.text), meta, view);
      li.append(dot, body);
      ol.appendChild(li);
    }
    return ol;
  }

  function start() {
    const c = counts(SAMPLE);
    A.mount({
      title: 'Asset History', icon: 'history',
      subtitle: 'A timeline of purchases, assignments, returns, maintenance, repairs and status changes.',
      cards: [
        { label: 'Total Activities', value: SAMPLE.length, sub: 'Sample events', icon: 'history', tone: 'info' },
        { label: 'Purchases', value: c['Asset Purchased'], sub: 'New assets', icon: 'cart', tone: 'violet' },
        { label: 'Assignments', value: c['Asset Assigned'] + c['Asset Returned'], sub: `${c['Asset Assigned']} issued · ${c['Asset Returned']} returned`, icon: 'userCheck', tone: 'amber' },
        { label: 'Maintenance Events', value: c['Maintenance Completed'], sub: 'Completed services', icon: 'check', tone: 'good' },
        { label: 'Repairs', value: c['Repair Recorded'], sub: 'Recorded repairs', icon: 'wrench', tone: 'bad' },
      ],
      rows: SAMPLE, noun: 'activities', emptyTitle: 'No activities found', listLabel: 'Asset activity timeline',
      search: { placeholder: 'Search activity, asset, code or person…', fields: ['type', 'asset', 'code', 'by', 'text'] },
      filters: [
        { id: 'asset', label: 'Filter by asset', allLabel: 'All Assets', options: Object.entries(ASSETS).map(([code, [name]]) => [code, `${name} (${code})`]), match: (r, v) => r.code === v },
        { id: 'type', label: 'Filter by activity type', allLabel: 'All Activity Types', options: Object.keys(TYPES), match: (r, v) => r.type === v },
      ],
      date: { label: 'Filter by date range', get: r => r.date, ranges: ['all', '30', '90', '365'] },
      view: timeline,
    });
  }

  A.boot('asset-history', start);
  return { SAMPLE, TYPES, ASSETS, counts };
})();
