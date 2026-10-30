/* ============================================================
   equipment-inventory-ui.js — Workshop Assets › Equipment Inventory
   (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/equipment-inventory.html. Hands the shared
   engine (js/workshop-assets-demo.js) the FICTIONAL sample equipment
   below. Nothing is read from or written to the database or browser
   storage, and no request is made: Add Equipment and View Details are
   previews, and saving says that nothing was saved or sent.
   ============================================================ */

const EquipmentInventoryUI = (() => {
  const A = AssetDemo;

  const CATEGORIES = ['Lifting', 'Air & Pneumatics', 'Wheel & Tyre', 'AC & Cooling', 'Workshop Machinery'];
  const STATUSES = ['Available', 'In Use', 'Under Maintenance'];
  const CONDITIONS = ['Excellent', 'Good', 'Fair', 'Needs Service'];

  // Eight sample machines. Codes carry DEMO; brands and models are invented.
  const SAMPLE = [
    { name: 'Two Post Car Lift', code: 'DEMO-EQ-001', category: 'Lifting', brand: 'LiftPro TP-40', qty: 2, purchased: '2024-03-12', price: 385000, condition: 'Good', status: 'In Use', location: 'Bay 1 & 2', icon: 'package' },
    { name: 'Four Post Car Lift', code: 'DEMO-EQ-002', category: 'Lifting', brand: 'LiftPro FP-50', qty: 1, purchased: '2023-08-20', price: 520000, condition: 'Excellent', status: 'Available', location: 'Bay 3', icon: 'package' },
    { name: 'Air Compressor', code: 'DEMO-EQ-003', category: 'Air & Pneumatics', brand: 'AirMax 300L', qty: 1, purchased: '2022-11-05', price: 145000, condition: 'Fair', status: 'Under Maintenance', location: 'Compressor room', icon: 'cog' },
    { name: 'Wheel Alignment Machine', code: 'DEMO-EQ-004', category: 'Wheel & Tyre', brand: 'AlignTech 3D-X', qty: 1, purchased: '2025-01-18', price: 890000, condition: 'Excellent', status: 'In Use', location: 'Alignment bay', icon: 'cog' },
    { name: 'Tyre Changer', code: 'DEMO-EQ-005', category: 'Wheel & Tyre', brand: 'TyreKing TC-22', qty: 2, purchased: '2024-06-02', price: 165000, condition: 'Good', status: 'Available', location: 'Tyre corner', icon: 'cog' },
    { name: 'AC Recovery Machine', code: 'DEMO-EQ-006', category: 'AC & Cooling', brand: 'CoolServ R-134', qty: 1, purchased: '2025-07-09', price: 240000, condition: 'Good', status: 'Available', location: 'AC bay', icon: 'refresh' },
    { name: 'Hydraulic Press', code: 'DEMO-EQ-007', category: 'Workshop Machinery', brand: 'PressLine 20T', qty: 1, purchased: '2021-09-14', price: 98000, condition: 'Needs Service', status: 'Under Maintenance', location: 'Machine shop', icon: 'wrench' },
    { name: 'Engine Crane', code: 'DEMO-EQ-008', category: 'Lifting', brand: 'HoistCo 2T', qty: 1, purchased: '2026-10-12', price: 72000, condition: 'Excellent', status: 'In Use', location: 'Engine bay', icon: 'package' },
  ];

  /** The summary figures, counted from the rows (units, not lines). */
  function summary(rows) {
    const units = s => rows.filter(r => !s || r.status === s).reduce((n, r) => n + r.qty, 0);
    return {
      total: units(), available: units('Available'), inUse: units('In Use'), maintenance: units('Under Maintenance'),
      value: rows.reduce((n, r) => n + r.qty * r.price, 0),
    };
  }

  function addEquipment() {
    A.openModal({
      title: 'Add Equipment', submit: 'Save Equipment',
      body: A.form([
        { label: 'Equipment name', placeholder: 'e.g. Wheel Balancer' }, { label: 'Equipment code', placeholder: 'DEMO-EQ-009' },
        { label: 'Category', type: 'select', options: CATEGORIES }, { label: 'Brand / model', placeholder: 'Brand and model' },
        { label: 'Quantity', type: 'number', value: 1 }, { label: 'Purchase date', type: 'date' },
        { label: 'Purchase price (৳)', type: 'number', placeholder: '0' }, { label: 'Condition', type: 'select', options: CONDITIONS },
        { label: 'Status', type: 'select', options: STATUSES }, { label: 'Location', placeholder: 'Bay or room' },
        { label: 'Notes', type: 'textarea', wide: true },
      ]),
    });
  }

  function viewDetails(r) {
    A.openModal({
      title: r.name,
      body: A.details([
        ['Equipment code', r.code], ['Category', r.category], ['Brand / model', r.brand], ['Quantity', r.qty],
        ['Location', r.location], ['Purchase date', A.fmtDate(r.purchased)], ['Purchase price', A.money(r.price)],
        ['Total value', A.money(r.price * r.qty)], ['Condition', A.badge(r.condition)], ['Status', A.badge(r.status)],
      ]),
    });
  }

  function start() {
    const s = summary(SAMPLE);
    A.mount({
      title: 'Equipment Inventory', icon: 'package',
      subtitle: 'Large and permanent workshop equipment: lifts, compressors, alignment and tyre machines.',
      headerButtons: [{ label: 'Add Equipment', icon: 'plus', primary: true, id: 'eqAdd', onClick: addEquipment }],
      cards: [
        { label: 'Total Equipment', value: s.total, sub: `${SAMPLE.length} machine types`, icon: 'package', tone: 'info' },
        { label: 'Available', value: s.available, sub: 'Ready to use', icon: 'check', tone: 'good' },
        { label: 'In Use', value: s.inUse, sub: 'Working right now', icon: 'userCheck', tone: 'amber' },
        { label: 'Under Maintenance', value: s.maintenance, sub: 'Out of service', icon: 'alert', tone: 'bad' },
        { label: 'Total Purchase Value', value: A.money(s.value), money: true, sub: 'Sample figures', icon: 'coins', tone: 'violet' },
      ],
      rows: SAMPLE, noun: 'machines', emptyTitle: 'No equipment found', listLabel: 'Equipment list',
      search: { placeholder: 'Search equipment, code, brand or category…', fields: ['name', 'code', 'brand', 'category'] },
      filters: [
        { id: 'category', label: 'Filter by category', allLabel: 'All Categories', options: CATEGORIES, match: (r, v) => r.category === v },
        { id: 'status', label: 'Filter by status', allLabel: 'All Status', options: STATUSES, match: (r, v) => r.status === v },
      ],
      date: { label: 'Filter by purchase date', get: r => r.purchased, ranges: ['all', '30', '90', '365'] },
      columns: [
        { label: 'Equipment Name', cell: r => A.itemCell(r.icon, r.name, r.location), csv: r => r.name },
        { label: 'Equipment Code', cell: r => A.el('span', 'ad-code', r.code), csv: r => r.code },
        { label: 'Category', cell: r => r.category, csv: r => r.category },
        { label: 'Brand / Model', cell: r => r.brand, csv: r => r.brand },
        { label: 'Quantity', cls: 'ad-num', cell: r => r.qty, csv: r => r.qty },
        { label: 'Purchase Date', cls: 'ad-nowrap', cell: r => A.fmtDate(r.purchased), csv: r => r.purchased },
        { label: 'Purchase Price', cls: 'ad-num', cell: r => A.money(r.price), csv: r => r.price },
        { label: 'Condition', cell: r => A.badge(r.condition), csv: r => r.condition },
        { label: 'Status', cell: r => A.badge(r.status), csv: r => r.status },
      ],
      rowActions: [{ label: 'View details', icon: 'eye', run: viewDetails }],
    });
  }

  A.boot('equipment-inventory', start);
  return { SAMPLE, CATEGORIES, STATUSES, summary };
})();
