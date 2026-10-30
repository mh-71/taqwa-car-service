/* ============================================================
   maintenance-repairs-ui.js — Workshop Assets › Maintenance & Repairs
   (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/maintenance-repairs.html. Hands the shared
   engine (js/workshop-assets-demo.js) the FICTIONAL sample maintenance
   records below. Nothing is read from or written to the database or
   browser storage, and no request is made: Schedule Maintenance and
   the details view are previews, and saving says nothing was saved.
   ============================================================ */

const MaintenanceRepairsUI = (() => {
  const A = AssetDemo;

  const TYPES = ['Preventive Service', 'Inspection', 'Calibration', 'Repair'];
  const STATUSES = ['Scheduled', 'Due Soon', 'Overdue', 'In Progress', 'Completed'];
  const TECHNICIANS = ['Rahim Uddin (Demo)', 'Karim Sheikh (Demo)', 'Salim Ahmed (Demo)', 'External Vendor (Demo)'];

  // Ten sample records against the sample equipment of Equipment Inventory.
  const SAMPLE = [
    { id: 'DEMO-MNT-101', equipment: 'Two Post Car Lift', code: 'DEMO-EQ-001', type: 'Preventive Service', last: '2026-07-30', next: '2026-11-04', tech: 'Rahim Uddin (Demo)', cost: 6500, status: 'Due Soon', notes: 'Check cables, pulleys and arm locks.' },
    { id: 'DEMO-MNT-102', equipment: 'Air Compressor', code: 'DEMO-EQ-003', type: 'Repair', last: '2026-10-21', next: '2026-11-02', tech: 'External Vendor (Demo)', cost: 18500, status: 'In Progress', notes: 'Pressure switch replacement; unit out of service.' },
    { id: 'DEMO-MNT-103', equipment: 'Hydraulic Press', code: 'DEMO-EQ-007', type: 'Repair', last: '2026-08-15', next: '2026-10-20', tech: 'Karim Sheikh (Demo)', cost: 9200, status: 'Overdue', notes: 'Seal kit ordered; hydraulic oil leak.' },
    { id: 'DEMO-MNT-104', equipment: 'Wheel Alignment Machine', code: 'DEMO-EQ-004', type: 'Calibration', last: '2026-05-10', next: '2026-11-10', tech: 'External Vendor (Demo)', cost: 12000, status: 'Scheduled', notes: 'Six-monthly sensor calibration.' },
    { id: 'DEMO-MNT-105', equipment: 'Tyre Changer', code: 'DEMO-EQ-005', type: 'Inspection', last: '2026-09-01', next: '2026-12-01', tech: 'Salim Ahmed (Demo)', cost: 1500, status: 'Scheduled', notes: 'Clamp jaws and bead breaker check.' },
    { id: 'DEMO-MNT-106', equipment: 'Four Post Car Lift', code: 'DEMO-EQ-002', type: 'Preventive Service', last: '2026-04-18', next: '2026-10-18', tech: 'Rahim Uddin (Demo)', cost: 7000, status: 'Overdue', notes: 'Lubrication and safety-lock test overdue.' },
    { id: 'DEMO-MNT-107', equipment: 'AC Recovery Machine', code: 'DEMO-EQ-006', type: 'Inspection', last: '2026-10-05', next: '2027-01-05', tech: 'Salim Ahmed (Demo)', cost: 1200, status: 'Completed', notes: 'Filter drier checked; vacuum pump oil changed.' },
    { id: 'DEMO-MNT-108', equipment: 'Engine Crane', code: 'DEMO-EQ-008', type: 'Inspection', last: '2026-10-12', next: '2027-04-12', tech: 'Karim Sheikh (Demo)', cost: 800, status: 'Completed', notes: 'Delivery inspection on arrival.' },
    { id: 'DEMO-MNT-109', equipment: 'Two Post Car Lift', code: 'DEMO-EQ-001', type: 'Repair', last: '2026-09-22', next: '2027-03-22', tech: 'External Vendor (Demo)', cost: 14500, status: 'Completed', notes: 'Replaced a worn equaliser cable.' },
    { id: 'DEMO-MNT-110', equipment: 'Air Compressor', code: 'DEMO-EQ-003', type: 'Preventive Service', last: '2026-06-02', next: '2026-12-02', tech: 'Salim Ahmed (Demo)', cost: 3500, status: 'Scheduled', notes: 'Drain tank, change intake filter.' },
  ];

  const isOpen = r => r.status !== 'Completed';
  /** Open records whose next service date has passed. */
  const overdue = (rows, today = A.DEMO_TODAY) => rows.filter(r => isOpen(r) && A.daysBetween(r.next, today) > 0);
  /** Open records due today or within the next 30 days. */
  const upcoming = (rows, today = A.DEMO_TODAY) => rows.filter(r => isOpen(r) && r.status !== 'In Progress'
    && A.daysBetween(today, r.next) >= 0 && A.daysBetween(today, r.next) <= 30);
  /** Completed repairs, newest first. */
  const recentRepairs = rows => rows.filter(r => r.type === 'Repair' && r.status === 'Completed').sort((a, b) => b.last.localeCompare(a.last));

  function details(r) {
    A.openModal({
      title: `${r.equipment} — ${r.type}`,
      body: A.details([
        ['Record', r.id], ['Equipment', `${r.equipment} (${r.code})`], ['Maintenance type', r.type],
        ['Last service', A.fmtDate(r.last)], ['Next service', A.fmtDate(r.next)], ['Assigned technician', r.tech],
        ['Estimated cost', A.money(r.cost)], ['Status', A.badge(r.status)], ['Notes', r.notes],
      ]),
    });
  }

  function schedule(r) {
    A.openModal({
      title: 'Schedule Maintenance', submit: 'Schedule',
      body: A.form([
        { label: 'Equipment', type: 'select', options: [...new Set(SAMPLE.map(x => x.equipment))], value: r && r.equipment },
        { label: 'Maintenance type', type: 'select', options: TYPES, value: r && r.type },
        { label: 'Service date', type: 'date' }, { label: 'Assigned technician', type: 'select', options: TECHNICIANS },
        { label: 'Estimated cost (৳)', type: 'number', placeholder: '0' }, { label: 'Priority', type: 'select', options: ['Normal', 'High', 'Urgent'] },
        { label: 'Notes', type: 'textarea', wide: true },
      ]),
    });
  }

  function start() {
    const open = SAMPLE.filter(isOpen);
    A.mount({
      title: 'Maintenance & Repairs', icon: 'wrench',
      subtitle: 'Maintenance schedules, repairs, costs and service history of workshop equipment.',
      headerButtons: [{ label: 'Schedule Maintenance', icon: 'calendar', primary: true, id: 'mrSchedule', onClick: () => schedule() }],
      cards: [
        { label: 'Total Maintenance Records', value: SAMPLE.length, sub: 'Sample records', icon: 'history', tone: 'info' },
        { label: 'Upcoming Maintenance', value: upcoming(SAMPLE).length, sub: 'Due in the next 30 days', icon: 'calendar', tone: 'amber' },
        { label: 'Overdue Maintenance', value: overdue(SAMPLE).length, sub: 'Past their service date', icon: 'alert', tone: 'bad' },
        { label: 'In Progress', value: SAMPLE.filter(r => r.status === 'In Progress').length, sub: 'Being worked on', icon: 'cog', tone: 'violet' },
        { label: 'Total Maintenance Cost', value: A.money(SAMPLE.reduce((n, r) => n + r.cost, 0)), money: true, sub: `${open.length} still open`, icon: 'coins', tone: 'good' },
      ],
      before(root) {
        const wrap = A.el('div', 'ad-panels');
        const side = r => A.el('span', null, A.fmtDate(r.next));
        wrap.append(
          A.panel('Upcoming Maintenance', 'calendar', 'amber', upcoming(SAMPLE).map(r => [r.equipment, `${r.type} · ${r.tech}`, side(r)]), 'Nothing due in the next 30 days.'),
          A.panel('Overdue Maintenance', 'alert', 'bad', overdue(SAMPLE).map(r => [r.equipment, `${r.type} · ${A.daysBetween(r.next, A.DEMO_TODAY)} days overdue`, side(r)]), 'Nothing overdue.'),
          A.panel('Recent Repairs', 'wrench', 'good', recentRepairs(SAMPLE).map(r => [r.equipment, r.notes, A.money(r.cost)]), 'No completed repairs.'),
        );
        root.appendChild(wrap);
        const h = A.el('h2', 'ad-section-title', 'Maintenance Schedule');
        root.appendChild(h);
      },
      rows: SAMPLE, noun: 'records', nameKey: 'equipment', emptyTitle: 'No maintenance records found', listLabel: 'Maintenance schedule',
      search: { placeholder: 'Search equipment, type or technician…', fields: ['equipment', 'code', 'type', 'tech', 'id'] },
      filters: [
        { id: 'status', label: 'Filter by status', allLabel: 'All Status', options: STATUSES, match: (r, v) => r.status === v },
      ],
      date: { label: 'Filter by next service date', get: r => r.next, ranges: ['all', 'future', '30', '90'] },
      columns: [
        { label: 'Equipment', cell: r => A.itemCell('wrench', r.equipment, r.code), csv: r => r.equipment },
        { label: 'Maintenance Type', cell: r => r.type, csv: r => r.type },
        { label: 'Last Service', cls: 'ad-nowrap', cell: r => A.fmtDate(r.last), csv: r => r.last },
        { label: 'Next Service', cls: 'ad-nowrap', cell: r => A.fmtDate(r.next), csv: r => r.next },
        { label: 'Assigned Technician', cell: r => A.person(r.tech), csv: r => r.tech },
        { label: 'Estimated Cost', cls: 'ad-num', cell: r => A.money(r.cost), csv: r => r.cost },
        { label: 'Status', cell: r => A.badge(r.status), csv: r => r.status },
      ],
      rowActions: [
        { label: 'View details', icon: 'eye', run: details },
        { label: 'Schedule maintenance', icon: 'calendar', run: schedule },
      ],
    });
  }

  A.boot('maintenance-repairs', start);
  return { SAMPLE, STATUSES, overdue, upcoming, recentRepairs };
})();
