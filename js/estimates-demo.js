/* ============================================================
   estimates-demo.js — Estimates & Quotations (DEMO ONLY)
   ------------------------------------------------------------
   Loaded by the three Estimates pages (pages/estimates.html,
   estimate-create.html, estimate-details.html). All three share
   <body data-page="estimates"> so the sidebar link stays active;
   which page this is comes from data-est-view on #page-content.

   What this file deliberately does NOT do:
     - call the API or the network (no fetch, no Api, no Storage);
     - read or write browser storage, cookies or IndexedDB;
     - save, send, approve, create Job Cards or Invoices, or touch
       Inventory.

   Every record below is fictional and lives only in this file.
   The calculator runs in the browser on the demo form values and
   mirrors the Job Card rules (line = qty x price; discount as an
   amount capped at the subtotal or a percentage rounded half-up to
   the paisa; VAT after the discount, rounded to whole taka).
   Every action that would change something only explains that it
   is a preview. Print opens the browser's own print dialog for the
   quotation sheet and nothing else.
   ============================================================ */

const EstimatesDemo = (() => {

  /* ---------- demo data (fictional; never saved) ---------- */

  // A fixed "today" so expiry and validity read the same on every visit.
  const DEMO_TODAY = '2026-10-20';

  const CUSTOMERS = ['A', 'B', 'C', 'D', 'E', 'F'].map((l, i) => ({
    id: `DC-${l}`, name: `Demo Customer ${l}`,
    phone: `01XXX-XXX2${String(i + 1).padStart(2, '0')}`, email: `demo.customer.${l.toLowerCase()}@example.com`,
  }));

  const VEHICLES = [
    { id: 'DV-1', customerId: 'DC-A', model: 'Demo Sedan',     reg: 'DEMO-1001', year: 2019 },
    { id: 'DV-2', customerId: 'DC-A', model: 'Demo Hatchback', reg: 'DEMO-1002', year: 2016 },
    { id: 'DV-3', customerId: 'DC-B', model: 'Demo SUV',       reg: 'DEMO-1003', year: 2021 },
    { id: 'DV-4', customerId: 'DC-C', model: 'Demo Microbus',  reg: 'DEMO-1004', year: 2015 },
    { id: 'DV-5', customerId: 'DC-D', model: 'Demo Sedan',     reg: 'DEMO-1005', year: 2018 },
    { id: 'DV-6', customerId: 'DC-E', model: 'Demo Pickup',    reg: 'DEMO-1006', year: 2020 },
    { id: 'DV-7', customerId: 'DC-F', model: 'Demo Hatchback', reg: 'DEMO-1007', year: 2017 },
    { id: 'DV-8', customerId: 'DC-F', model: 'Demo SUV',       reg: 'DEMO-1008', year: 2022 },
  ];

  // Generic catalogue for the Create page's suggestions; prices are invented.
  const PART_CATALOGUE = [
    ['Brake pad set (front)', 3200], ['Brake disc (each)', 4500], ['Engine oil 4L', 3800], ['Oil filter', 650],
    ['Air filter', 900], ['Spark plug (each)', 450], ['Wiper blade pair', 1200], ['Coolant 1L', 550],
    ['Battery 12V', 9500], ['Timing belt kit', 7800], ['Clutch plate', 6200], ['Shock absorber (each)', 5400],
  ].map(([name, price]) => ({ name, price }));
  const LABOUR_CATALOGUE = [
    ['General service', 1, 800], ['Brake service', 1.5, 800], ['Engine diagnostics', 1, 1000], ['Clutch replacement', 4, 900],
    ['Timing belt replacement', 3.5, 900], ['Suspension work', 2.5, 850], ['AC inspection', 1, 800], ['Wheel alignment', 0.75, 800],
  ].map(([name, hours, rate]) => ({ name, hours, rate }));

  const P = name => PART_CATALOGUE.find(p => p.name === name);
  const L = name => LABOUR_CATALOGUE.find(l => l.name === name);
  const part = (name, qty) => ({ name, qty, unitPrice: P(name).price });
  const labour = (name, hours) => ({ name, hours: hours ?? L(name).hours, rate: L(name).rate });

  const ESTIMATES = [
    { n: 1,  date: '2026-09-02', days: 15, c: 'DC-A', v: 'DV-1', status: 'Approved', desc: 'Front brakes grinding; pads and discs worn.',
      parts: [part('Brake pad set (front)', 1), part('Brake disc (each)', 2)], labour: [labour('Brake service')], disc: ['amount', 500], vat: 5 },
    { n: 2,  date: '2026-09-08', days: 15, c: 'DC-B', v: 'DV-3', status: 'Rejected', desc: 'Clutch slipping under load.',
      parts: [part('Clutch plate', 1)], labour: [labour('Clutch replacement')], disc: ['percent', 5], vat: 5 },
    { n: 3,  date: '2026-09-15', days: 15, c: 'DC-C', v: 'DV-4', status: 'Pending', desc: 'Routine service and air filter.',
      parts: [part('Engine oil 4L', 1), part('Oil filter', 1), part('Air filter', 1)], labour: [labour('General service')], disc: ['amount', 0], vat: 5 },
    { n: 4,  date: '2026-09-21', days: 15, c: 'DC-D', v: 'DV-5', status: 'Approved', desc: 'Timing belt due by mileage.',
      parts: [part('Timing belt kit', 1), part('Coolant 1L', 2)], labour: [labour('Timing belt replacement')], disc: ['percent', 7], vat: 5 },
    { n: 5,  date: '2026-09-28', days: 15, c: 'DC-E', v: 'DV-6', status: 'Pending', desc: 'Rear suspension noise over bumps.',
      parts: [part('Shock absorber (each)', 2)], labour: [labour('Suspension work')], disc: ['amount', 300], vat: 5 },
    { n: 6,  date: '2026-10-01', days: 15, c: 'DC-F', v: 'DV-7', status: 'Approved', desc: 'Battery weak; slow cranking.',
      parts: [part('Battery 12V', 1)], labour: [labour('Engine diagnostics', 0.5)], disc: ['amount', 0], vat: 5 },
    { n: 7,  date: '2026-10-04', days: 15, c: 'DC-A', v: 'DV-2', status: 'Rejected', desc: 'AC not cooling; inspection and service.',
      parts: [], labour: [labour('AC inspection'), labour('General service')], disc: ['amount', 0], vat: 5 },
    { n: 8,  date: '2026-10-07', days: 15, c: 'DC-B', v: 'DV-3', status: 'Pending', desc: 'Full service with spark plugs.',
      parts: [part('Engine oil 4L', 1), part('Oil filter', 1), part('Spark plug (each)', 4)], labour: [labour('General service')], disc: ['percent', 10], vat: 5 },
    { n: 9,  date: '2026-10-10', days: 15, c: 'DC-C', v: 'DV-4', status: 'Approved', desc: 'Steering pulls left after pothole.',
      parts: [], labour: [labour('Wheel alignment'), labour('Suspension work', 1)], disc: ['amount', 200], vat: 5 },
    { n: 10, date: '2026-10-12', days: 15, c: 'DC-D', v: 'DV-5', status: 'Pending', desc: 'Wipers smearing; coolant top-up.',
      parts: [part('Wiper blade pair', 1), part('Coolant 1L', 1)], labour: [], disc: ['amount', 0], vat: 5 },
    { n: 11, date: '2026-10-14', days: 15, c: 'DC-E', v: 'DV-6', status: 'Pending', desc: 'Engine warning light; diagnostics first.',
      parts: [], labour: [labour('Engine diagnostics')], disc: ['amount', 0], vat: 5 },
    { n: 12, date: '2026-10-16', days: 15, c: 'DC-F', v: 'DV-8', status: 'Approved', desc: 'Brake service and new wiper blades.',
      parts: [part('Brake pad set (front)', 1), part('Wiper blade pair', 1)], labour: [labour('Brake service')], disc: ['percent', 5], vat: 5 },
    { n: 13, date: '2026-10-18', days: 15, c: 'DC-A', v: 'DV-1', status: 'Pending', desc: 'Pre-trip check and oil change.',
      parts: [part('Engine oil 4L', 1), part('Oil filter', 1)], labour: [labour('General service'), labour('Wheel alignment')], disc: ['amount', 250], vat: 5 },
    { n: 14, date: '2026-10-19', days: 7,  c: 'DC-B', v: 'DV-3', status: 'Pending', desc: 'Suspension and alignment after accident repair.',
      parts: [part('Shock absorber (each)', 2)], labour: [labour('Suspension work'), labour('Wheel alignment')], disc: ['percent', 3], vat: 5 },
  ].map(e => ({
    id: `EST-DEMO-${String(e.n).padStart(3, '0')}`, date: e.date, validUntil: addDays(e.date, e.days),
    customerId: e.c, vehicleId: e.v, status: e.status, description: e.desc,
    parts: e.parts, labour: e.labour, discountType: e.disc[0], discountValue: e.disc[1], vatRate: e.vat,
  }));

  const TERMS = [
    'Prices are valid until the date shown and may change if further faults are found.',
    'Parts are subject to availability at the time of approval.',
    'Work starts only after the customer approves this estimate.',
    'This is an estimate, not a tax invoice.',
  ];

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function daysBetween(fromIso, toIso) {
    const t = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((t(toIso) - t(fromIso)) / 86400000);
  }

  /** Pending past its validity date reads as Expired; nothing is stored. */
  const effectiveStatus = (e, today = DEMO_TODAY) => (e.status === 'Pending' && e.validUntil < today ? 'Expired' : e.status);

  /** A percentage of an amount, rounded half-up to the paisa and capped at the amount (Job Card rule). */
  function percentDiscount(subtotal, rate) {
    const bp = Math.round(rate * 100);
    const paisa = Math.floor((Math.round(subtotal * 10000) * bp + 500000) / 1000000);
    return Math.min(paisa / 100, subtotal);
  }

  /** Totals for an estimate or a form snapshot. Mirrors the Job Card rules; browser-only. */
  function calc({ parts = [], labour = [], discountType = 'amount', discountValue = 0, vatRate = 0 }) {
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const partsTotal = parts.reduce((s, l) => s + num(l.qty) * num(l.unitPrice), 0);
    const labourTotal = labour.reduce((s, l) => s + num(l.hours) * num(l.rate), 0);
    const subtotal = partsTotal + labourTotal;
    const rate = num(vatRate);
    let discount, vat, total;
    if (discountType === 'percent') {
      discount = percentDiscount(subtotal, num(discountValue));
      const net = Math.round(subtotal * 100) - Math.round(discount * 100);
      vat = Math.round(net * rate / 10000);
      total = (net + vat * 100) / 100;
    } else {
      discount = Math.min(Math.max(num(discountValue), 0), subtotal);
      vat = Math.round((subtotal - discount) * rate / 100);
      total = subtotal - discount + vat;
    }
    return { partsTotal, labourTotal, subtotal, discount, vatRate: rate, vat, total };
  }

  function filterEstimates(list, { q = '', status = 'all', from = '', to = '' } = {}, today = DEMO_TODAY) {
    const needle = q.trim().toLowerCase();
    return list.filter(e => {
      const c = customer(e.customerId), v = vehicle(e.vehicleId);
      return (!needle || [e.id, e.description, c.name, v.model, v.reg].some(s => s.toLowerCase().includes(needle)))
        && (status === 'all' || effectiveStatus(e, today) === status)
        && (!from || e.date >= from) && (!to || e.date <= to);
    });
  }

  function paginate(list, page, size) {
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = Math.min(Math.max(1, page), pages);
    const rows = list.slice((p - 1) * size, p * size);
    return { rows, page: p, pages, from: rows.length ? (p - 1) * size + 1 : 0, to: (p - 1) * size + rows.length, total: list.length };
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDay = iso => { const [y, m, d] = iso.split('-'); return `${d} ${MONTHS[Number(m) - 1]} ${y}`; };
  /** ৳ with Indian grouping; paisa only when there are any. Own formatter: the shared one reads Settings through Storage. */
  function money(n) {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    const frac = Math.abs(v % 1) > 0.0001;
    return `৳ ${v.toLocaleString('en-IN', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 })}`;
  }
  const customer = id => CUSTOMERS.find(c => c.id === id) || { name: '—', phone: '', email: '' };
  const vehicle = id => VEHICLES.find(v => v.id === id) || { model: '—', reg: '', year: '' };

  /* ---------- DOM helpers (text only, never HTML) ---------- */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    view: 'M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z',
    more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    remove: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
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

  const STATUS_BADGE = { Pending: 'badge--warn', Approved: 'badge--good', Rejected: 'badge--bad', Expired: 'badge--neutral' };
  const statusBadge = s => h('span', { class: `badge ${STATUS_BADGE[s] || 'badge--neutral'}`, text: s });

  function emptyRow(cols, title, text) {
    return h('tr', { class: 'est-empty-row' },
      h('td', { colspan: String(cols) }, h('div', { class: 'est-empty-row__box' }, h('strong', { text: title }), h('span', { text: text }))));
  }

  /* ---------- Overview ---------- */

  function renderOverview() {
    const PAGE = 8;
    const state = { page: 1, empty: false };
    const eff = ESTIMATES.map(e => effectiveStatus(e));
    const count = s => eff.filter(x => x === s).length;
    $('estTotal').textContent = String(ESTIMATES.length);
    $('estPending').textContent = String(count('Pending'));
    $('estApproved').textContent = String(count('Approved'));
    $('estRejected').textContent = String(count('Rejected'));
    $('estExpired').textContent = String(count('Expired'));
    $('estPendingValue').textContent = money(ESTIMATES.filter(e => effectiveStatus(e) === 'Pending').reduce((s, e) => s + calc(e).total, 0));
    const q = $('estSearch'), status = $('estStatus'), from = $('estFrom'), to = $('estTo');

    function draw() {
      const source = state.empty ? [] : ESTIMATES.slice().sort((a, b) => b.date.localeCompare(a.date));
      const bad = from.value && to.value && from.value > to.value;
      $('estRangeError').hidden = !bad;
      const list = bad ? [] : filterEstimates(source, { q: q.value, status: status.value, from: from.value, to: to.value });
      const res = paginate(list, state.page, PAGE);
      state.page = res.page;
      $('estEmpty').hidden = source.length > 0;
      $('estListCard').hidden = source.length === 0;
      $('estCount').textContent = `${list.length} of ${source.length} estimates`;
      fill($('estBody'), ...(res.rows.length ? res.rows.map(e => {
        const t = calc(e), c = customer(e.customerId), v = vehicle(e.vehicleId), s = effectiveStatus(e);
        return h('tr', {},
          h('td', { class: 'est-nowrap' }, h('a', { class: 'est-link', href: `estimate-details.html?id=${encodeURIComponent(e.id)}`, text: e.id })),
          h('td', { class: 'est-nowrap', text: fmtDay(e.date) }),
          h('td', { text: c.name }),
          h('td', {}, h('span', { class: 'cell-main', text: v.model }), h('span', { class: 'cell-sub', text: v.reg })),
          h('td', { class: 'num', text: money(t.partsTotal) }),
          h('td', { class: 'num', text: money(t.labourTotal) }),
          h('td', { class: 'num est-strong', text: money(t.total) }),
          h('td', { class: 'est-nowrap', text: fmtDay(e.validUntil) }),
          h('td', {}, statusBadge(s)),
          h('td', {}, h('div', { class: 'row-actions' },
            h('a', { class: 'icon-btn icon-btn--sm', href: `estimate-details.html?id=${encodeURIComponent(e.id)}`, title: `View ${e.id}`, 'aria-label': `View ${e.id}` }, svgIcon('view')),
            h('button', { type: 'button', class: 'icon-btn icon-btn--sm', title: `More actions for ${e.id}`, 'aria-label': `More actions for ${e.id}`, 'data-preview': `More actions for ${e.id}` }, svgIcon('more')))));
      }) : [emptyRow(10, bad ? 'The date range is not valid' : 'No estimates match these filters',
        bad ? '"From" must be on or before "To".' : 'Try a different search, or clear the filters.')]));
      const prev = $('estPrev'), next = $('estNext');
      $('estRange').textContent = res.total ? `Showing ${res.from}–${res.to} of ${res.total}` : 'No results';
      prev.disabled = res.page <= 1; next.disabled = res.page >= res.pages;
      prev.onclick = () => { state.page -= 1; draw(); };
      next.onclick = () => { state.page += 1; draw(); };
    }
    [q, status, from, to].forEach(c => c.addEventListener(c === q ? 'input' : 'change', () => { state.page = 1; draw(); }));
    $('estClear').addEventListener('click', () => { q.value = ''; status.value = 'all'; from.value = ''; to.value = ''; state.page = 1; draw(); });
    const toggle = document.querySelector('[data-empty-toggle]');
    toggle.addEventListener('click', () => {
      state.empty = !state.empty; state.page = 1;
      toggle.textContent = state.empty ? 'Show the demo data' : 'Show the empty state';
      toggle.setAttribute('aria-pressed', String(state.empty));
      draw();
    });
    draw();
  }

  /* ---------- Create Estimate ---------- */

  function renderCreate() {
    const custSel = $('estCustomer'), vehSel = $('estVehicle');
    CUSTOMERS.forEach(c => custSel.appendChild(h('option', { value: c.id, text: c.name })));
    function fillVehicles() {
      vehSel.textContent = '';
      const own = VEHICLES.filter(v => v.customerId === custSel.value);
      vehSel.appendChild(h('option', { value: '', text: own.length ? 'Select a vehicle' : 'Select a customer first' }));
      own.forEach(v => vehSel.appendChild(h('option', { value: v.id, text: `${v.model} · ${v.reg}` })));
      vehSel.disabled = own.length === 0;
    }
    custSel.addEventListener('change', fillVehicles);
    fillVehicles();
    $('estDate').value = DEMO_TODAY;
    $('estValid').value = addDays(DEMO_TODAY, 15);
    PART_CATALOGUE.forEach(p => $('estPartList').appendChild(h('option', { value: p.name })));
    LABOUR_CATALOGUE.forEach(l => $('estLabourList').appendChild(h('option', { value: l.name })));

    const partsBody = $('estPartRows'), labourBody = $('estLabourRows');
    const numInput = (cls, label, step, value = '') => h('input', { class: `input ${cls}`, type: 'number', min: '0', step, value, 'aria-label': label, inputmode: 'decimal' });

    function addPart(seed = {}) {
      const name = h('input', { class: 'input est-l-name', type: 'text', list: 'estPartList', placeholder: 'Part name', 'aria-label': 'Part name', autocomplete: 'off', value: seed.name || '' });
      const qty = numInput('est-l-qty', 'Quantity', '1', seed.qty ?? 1);
      const price = numInput('est-l-price', 'Unit price', '0.01', seed.unitPrice ?? '');
      name.addEventListener('change', () => { const hit = PART_CATALOGUE.find(p => p.name === name.value); if (hit && !price.value) price.value = String(hit.price); update(); });
      partsBody.appendChild(lineRow([name, qty, price], 'part'));
      update();
    }
    function addLabour(seed = {}) {
      const name = h('input', { class: 'input est-l-name', type: 'text', list: 'estLabourList', placeholder: 'Labour description', 'aria-label': 'Labour description', autocomplete: 'off', value: seed.name || '' });
      const hours = numInput('est-l-qty', 'Hours', '0.25', seed.hours ?? 1);
      const rate = numInput('est-l-price', 'Rate per hour', '0.01', seed.rate ?? '');
      name.addEventListener('change', () => { const hit = LABOUR_CATALOGUE.find(l => l.name === name.value); if (hit) { if (!rate.value) rate.value = String(hit.rate); hours.value = String(hit.hours); } update(); });
      labourBody.appendChild(lineRow([name, hours, rate], 'labour'));
      update();
    }
    function lineRow(inputs, kind) {
      const total = h('td', { class: 'num est-l-total', text: money(0) });
      const remove = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', title: 'Remove this line', 'aria-label': `Remove this ${kind} line` }, svgIcon('remove'));
      const tr = h('tr', {}, ...inputs.map(i => h('td', {}, i)), total, h('td', {}, remove));
      inputs.forEach(i => i.addEventListener('input', update));
      remove.addEventListener('click', () => { tr.remove(); update(); });
      return tr;
    }
    const readRows = (body, a, b) => [...body.querySelectorAll('tr')].map(tr => ({
      name: tr.querySelector('.est-l-name').value, [a]: tr.querySelector('.est-l-qty').value, [b]: tr.querySelector('.est-l-price').value, tr,
    }));

    function update() {
      const parts = readRows(partsBody, 'qty', 'unitPrice');
      const labour = readRows(labourBody, 'hours', 'rate');
      parts.forEach(l => { l.tr.querySelector('.est-l-total').textContent = money((Number(l.qty) || 0) * (Number(l.unitPrice) || 0)); });
      labour.forEach(l => { l.tr.querySelector('.est-l-total').textContent = money((Number(l.hours) || 0) * (Number(l.rate) || 0)); });
      $('estNoParts').hidden = parts.length > 0;
      $('estNoLabour').hidden = labour.length > 0;
      const discountType = $('estDiscType').value;
      const discountValue = $('estDiscValue').value;
      const vatRate = $('estVat').value;
      const t = calc({ parts, labour, discountType, discountValue, vatRate });
      $('estPvParts').textContent = money(t.partsTotal);
      $('estPvLabour').textContent = money(t.labourTotal);
      $('estPvSubtotal').textContent = money(t.subtotal);
      $('estPvDiscount').textContent = `− ${money(t.discount)}`;
      $('estPvDiscLabel').textContent = discountType === 'percent' ? `Discount (${Number(discountValue) || 0}%)` : 'Discount';
      $('estPvVatLabel').textContent = `VAT (${t.vatRate}%)`;
      $('estPvVat').textContent = money(t.vat);
      $('estPvTotal').textContent = money(t.total);
      const notes = [];
      if (discountType === 'amount' && Number(discountValue) > t.subtotal) notes.push('The discount is larger than the subtotal, so it is capped at the subtotal.');
      if (discountType === 'percent' && (Number(discountValue) < 0 || Number(discountValue) > 100)) notes.push('A percentage discount must be between 0 and 100.');
      if (Number(vatRate) < 0 || Number(vatRate) > 100) notes.push('VAT must be between 0 and 100%.');
      if ($('estValid').value && $('estDate').value && $('estValid').value < $('estDate').value) notes.push('"Valid until" must be on or after the estimate date.');
      fill($('estPvNotes'), ...notes.map(n => h('li', { text: n })));
      $('estPvNotes').hidden = notes.length === 0;
      $('estValidDays').textContent = ($('estValid').value && $('estDate').value) ? `${daysBetween($('estDate').value, $('estValid').value)} days` : '';
    }
    ['estDiscType', 'estDiscValue', 'estVat', 'estDate', 'estValid'].forEach(id => $(id).addEventListener('input', update));
    $('estDiscType').addEventListener('change', update);
    $('estAddPart').addEventListener('click', () => addPart());
    $('estAddLabour').addEventListener('click', () => addLabour());
    addPart();
    addLabour();
  }

  /* ---------- Estimate Details ---------- */

  function renderDetails() {
    const id = new URLSearchParams(window.location.search).get('id') || ESTIMATES[0].id;
    const e = ESTIMATES.find(x => x.id === id);
    if (!e) { $('estDetail').hidden = true; $('estNotFound').hidden = false; $('estNotFoundId').textContent = id; return; }
    const s = effectiveStatus(e), c = customer(e.customerId), v = vehicle(e.vehicleId), t = calc(e);
    const left = daysBetween(DEMO_TODAY, e.validUntil);
    $('estCrumb').textContent = e.id;
    $('estDetailId').textContent = e.id;
    fill($('estDetailStatus'), statusBadge(s));
    $('estDetailValidity').textContent = s === 'Expired' ? `Expired ${-left} day${-left === 1 ? '' : 's'} ago (valid until ${fmtDay(e.validUntil)})`
      : (s === 'Pending' ? `Valid until ${fmtDay(e.validUntil)} · ${left} day${left === 1 ? '' : 's'} left` : `Valid until ${fmtDay(e.validUntil)}`);
    // Which actions a real estimate in this state would offer; every one is preview-only here.
    const ACTIONS = { Pending: ['Approve', 'Reject', 'Revise', 'Send to Customer'], Approved: ['Convert to Job Card', 'Create Invoice', 'Send to Customer'],
      Rejected: ['Revise'], Expired: ['Revise'] };
    fill($('estDetailActions'), ...ACTIONS[s].map((a, i) => h('button', { type: 'button', class: `btn ${i === 0 ? 'btn--primary' : 'btn--ghost'} btn--sm`, 'data-preview': a, text: a })));

    // The quotation sheet.
    $('estShNo').textContent = e.id;
    $('estShDate').textContent = fmtDay(e.date);
    $('estShValid').textContent = fmtDay(e.validUntil);
    $('estShStatus').textContent = s;
    fill($('estShCustomer'), h('strong', { text: c.name }), h('span', { text: c.phone }), h('span', { text: c.email }));
    fill($('estShVehicle'), h('strong', { text: v.model }), h('span', { text: `Reg. ${v.reg}` }), h('span', { text: `Year ${v.year}` }));
    $('estShDesc').textContent = e.description;
    fill($('estShParts'), ...(e.parts.length ? e.parts.map((l, i) => h('tr', {},
      h('td', { class: 'num', text: String(i + 1) }), h('td', { text: l.name }), h('td', { class: 'num', text: String(l.qty) }),
      h('td', { class: 'num', text: money(l.unitPrice) }), h('td', { class: 'num', text: money(l.qty * l.unitPrice) })))
      : [h('tr', {}, h('td', { colspan: '5', class: 'est-sh-none', text: 'No parts on this estimate.' }))]));
    fill($('estShLabour'), ...(e.labour.length ? e.labour.map((l, i) => h('tr', {},
      h('td', { class: 'num', text: String(i + 1) }), h('td', { text: l.name }), h('td', { class: 'num', text: String(l.hours) }),
      h('td', { class: 'num', text: money(l.rate) }), h('td', { class: 'num', text: money(l.hours * l.rate) })))
      : [h('tr', {}, h('td', { colspan: '5', class: 'est-sh-none', text: 'No labour on this estimate.' }))]));
    const rows = [['Parts', money(t.partsTotal)], ['Labour', money(t.labourTotal)], ['Subtotal', money(t.subtotal)],
      [e.discountType === 'percent' ? `Discount (${e.discountValue}%)` : 'Discount', `− ${money(t.discount)}`],
      [`VAT (${t.vatRate}%)`, money(t.vat)]];
    fill($('estShSummary'), ...rows.map(([k, val]) => h('tr', {}, h('th', { scope: 'row', text: k }), h('td', { class: 'num', text: val }))),
      h('tr', { class: 'est-sh-total' }, h('th', { scope: 'row', text: 'Estimated Total' }), h('td', { class: 'num', text: money(t.total) })));
    fill($('estShTerms'), ...TERMS.map(x => h('li', { text: x })));
    // The cost breakdown card beside the sheet.
    fill($('estBreakdown'), ...[['Parts', t.partsTotal], ['Labour', t.labourTotal], ['Subtotal', t.subtotal], ['Discount', -t.discount], ['VAT', t.vat]]
      .map(([k, val]) => h('div', { class: 'est-bd__row' }, h('span', { text: k }), h('strong', { text: val < 0 ? `− ${money(-val)}` : money(val) }))),
      h('div', { class: 'est-bd__row est-bd__total' }, h('span', { text: 'Estimated Total' }), h('strong', { text: money(t.total) })));
    $('estPrint').addEventListener('click', () => window.print());
  }

  /* ---------- every page ---------- */

  const RENDER = { overview: renderOverview, create: renderCreate, details: renderDetails };

  // Every action that would change something only explains that it is a preview.
  function explainPreview(ev) {
    const btn = ev.target.closest('[data-preview]');
    if (!btn) return;
    ev.preventDefault();
    Utils.toast(`Preview only — not available yet: "${btn.getAttribute('data-preview')}". Nothing was saved or sent.`, 'info');
  }

  function init() {
    if (document.body.dataset.page !== 'estimates') return;
    const content = document.getElementById('page-content');
    const view = content ? content.dataset.estView : '';
    document.addEventListener('click', explainPreview);
    if (RENDER[view]) RENDER[view]();
  }

  return { DEMO_TODAY, CUSTOMERS, VEHICLES, ESTIMATES, PART_CATALOGUE, LABOUR_CATALOGUE, calc, percentDiscount, effectiveStatus,
    filterEstimates, paginate, addDays, daysBetween, money, fmtDay, init };
})();

// The page's markup is already parsed (this script is at the end of <body>),
// so it is filled in now -- before the shell reveals the content area.
if (typeof document !== 'undefined' && document.body && document.body.dataset) EstimatesDemo.init();
