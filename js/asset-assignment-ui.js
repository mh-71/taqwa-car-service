/* ============================================================
   asset-assignment-ui.js — Workshop Assets › Asset Assignment
   (DEMO PAGE, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/asset-assignment.html. Hands the shared engine
   (js/workshop-assets-demo.js) the FICTIONAL sample assignments below.
   The mechanics are invented names: the real Mechanics records are
   never read. Nothing is read from or written to the database or
   browser storage, and no request is made: Assign, Return and the
   details view are previews, and saving says nothing was saved.
   ============================================================ */

const AssetAssignmentUI = (() => {
  const A = AssetDemo;

  const MECHANICS = ['Rahim Uddin (Demo)', 'Karim Sheikh (Demo)', 'Salim Ahmed (Demo)', 'Jamal Hossain (Demo)'];
  const MECHANIC_ID = { 'Rahim Uddin (Demo)': 'DEMO-MEC-01', 'Karim Sheikh (Demo)': 'DEMO-MEC-02', 'Salim Ahmed (Demo)': 'DEMO-MEC-03', 'Jamal Hossain (Demo)': 'DEMO-MEC-04' };
  const CATEGORIES = ['Diagnostic', 'Electrical', 'Lifting', 'Hand Tools', 'Engine Tools'];
  const STATUSES = ['Assigned', 'Overdue', 'Returned', 'Available'];

  // Ten sample assets: seven issued (one overdue, two returned) and three on the shelf.
  const SAMPLE = [
    { name: 'OBD-II Scanner', code: 'DEMO-TL-001', category: 'Diagnostic', mechanic: 'Rahim Uddin (Demo)', issued: '2026-10-27', due: '2026-11-03', condition: 'Good', status: 'Assigned' },
    { name: 'Digital Multimeter', code: 'DEMO-TL-002', category: 'Electrical', mechanic: 'Salim Ahmed (Demo)', issued: '2026-10-29', due: '2026-10-31', condition: 'Good', status: 'Assigned' },
    { name: 'Hydraulic Floor Jack', code: 'DEMO-TL-003', category: 'Lifting', mechanic: 'Karim Sheikh (Demo)', issued: '2026-10-15', due: '2026-10-22', condition: 'Fair', status: 'Overdue' },
    { name: 'Torque Wrench Set', code: 'DEMO-TL-004', category: 'Hand Tools', mechanic: 'Jamal Hossain (Demo)', issued: '2026-10-28', due: '2026-11-04', condition: 'Excellent', status: 'Assigned' },
    { name: 'Battery Tester', code: 'DEMO-TL-005', category: 'Electrical', mechanic: 'Rahim Uddin (Demo)', issued: '2026-10-20', due: '2026-10-24', condition: 'Good', status: 'Returned', returned: '2026-10-24' },
    { name: 'Engine Compression Tester', code: 'DEMO-TL-006', category: 'Engine Tools', mechanic: 'Karim Sheikh (Demo)', issued: '2026-10-26', due: '2026-11-02', condition: 'Good', status: 'Assigned' },
    { name: 'Spark Plug Socket Kit', code: 'DEMO-TL-007', category: 'Hand Tools', mechanic: 'Salim Ahmed (Demo)', issued: '2026-10-10', due: '2026-10-17', condition: 'Good', status: 'Returned', returned: '2026-10-16' },
    { name: 'Timing Light', code: 'DEMO-TL-008', category: 'Engine Tools', mechanic: '', issued: '', due: '', condition: 'Good', status: 'Available' },
    { name: 'Transmission Jack', code: 'DEMO-TL-009', category: 'Lifting', mechanic: '', issued: '', due: '', condition: 'Excellent', status: 'Available' },
    { name: 'Coolant Pressure Tester', code: 'DEMO-TL-010', category: 'Diagnostic', mechanic: '', issued: '', due: '', condition: 'Good', status: 'Available' },
  ];

  /** Summary counts: an asset counts once, by its current status. */
  function summary(rows) {
    const n = s => rows.filter(r => r.status === s).length;
    return { total: rows.length, assigned: n('Assigned') + n('Overdue'), available: n('Available') + n('Returned'), overdue: n('Overdue') };
  }

  function details(r) {
    A.openModal({
      title: `${r.name} — assignment`,
      body: A.details([
        ['Asset', `${r.name} (${r.code})`], ['Category', r.category], ['Assigned to', r.mechanic || 'Not assigned'],
        ['Mechanic ID', MECHANIC_ID[r.mechanic] || ''], ['Assignment date', A.fmtDate(r.issued)], ['Expected return', A.fmtDate(r.due)],
        ['Returned on', r.returned ? A.fmtDate(r.returned) : ''], ['Condition at issue', A.badge(r.condition)], ['Assignment status', A.badge(r.status)],
      ]),
    });
  }

  function assign(r) {
    A.openModal({
      title: 'Assign Asset', submit: 'Assign',
      body: A.form([
        { label: 'Asset', type: 'select', options: SAMPLE.map(x => `${x.name} (${x.code})`), value: r && `${r.name} (${r.code})` },
        { label: 'Mechanic', type: 'select', options: MECHANICS }, { label: 'Assignment date', type: 'date' },
        { label: 'Expected return', type: 'date' }, { label: 'Quantity', type: 'number', value: 1 },
        { label: 'Condition at issue', type: 'select', options: ['Excellent', 'Good', 'Fair'] }, { label: 'Notes', type: 'textarea', wide: true },
      ]),
    });
  }

  function giveBack(r) {
    A.openModal({
      title: `Return Asset — ${r.name}`, submit: 'Record Return',
      body: A.form([
        { label: 'Returned by', type: 'select', options: MECHANICS, value: r.mechanic }, { label: 'Return date', type: 'date' },
        { label: 'Condition on return', type: 'select', options: ['Excellent', 'Good', 'Fair', 'Needs Service'] },
        { label: 'Notes', type: 'textarea', wide: true },
      ]),
    });
  }

  const issued = r => r.status === 'Assigned' || r.status === 'Overdue';

  function start() {
    const s = summary(SAMPLE);
    A.mount({
      title: 'Asset Assignment', icon: 'userCheck',
      subtitle: 'Which mechanic is using which workshop asset, since when and until when.',
      headerButtons: [{ label: 'Assign Asset', icon: 'plus', primary: true, id: 'aaAssign', onClick: () => assign() }],
      cards: [
        { label: 'Total Assets', value: s.total, sub: 'Sample tools and equipment', icon: 'package', tone: 'info' },
        { label: 'Assigned Assets', value: s.assigned, sub: 'With a mechanic now', icon: 'userCheck', tone: 'amber' },
        { label: 'Available Assets', value: s.available, sub: 'On the shelf', icon: 'check', tone: 'good' },
        { label: 'Overdue Returns', value: s.overdue, sub: 'Past the expected return', icon: 'alert', tone: 'bad' },
      ],
      rows: SAMPLE, noun: 'assets', emptyTitle: 'No assignments found', listLabel: 'Asset assignments',
      search: { placeholder: 'Search asset, code or mechanic…', fields: ['name', 'code', 'mechanic', r => MECHANIC_ID[r.mechanic] || ''] },
      filters: [
        { id: 'mechanic', label: 'Filter by mechanic', allLabel: 'All Mechanics', options: MECHANICS, match: (r, v) => r.mechanic === v },
        { id: 'category', label: 'Filter by asset category', allLabel: 'All Categories', options: CATEGORIES, match: (r, v) => r.category === v },
        { id: 'status', label: 'Filter by assignment status', allLabel: 'All Status', options: STATUSES, match: (r, v) => r.status === v },
      ],
      columns: [
        { label: 'Asset Name', cell: r => A.itemCell('wrench', r.name, r.category), csv: r => r.name },
        { label: 'Asset Code', cell: r => A.el('span', 'ad-code', r.code), csv: r => r.code },
        { label: 'Assigned To', cell: r => (r.mechanic ? A.person(r.mechanic) : '—'), csv: r => r.mechanic },
        { label: 'Mechanic ID', cell: r => A.el('span', 'ad-code', MECHANIC_ID[r.mechanic] || '—'), csv: r => MECHANIC_ID[r.mechanic] || '' },
        { label: 'Assignment Date', cls: 'ad-nowrap', cell: r => A.fmtDate(r.issued), csv: r => r.issued },
        { label: 'Expected Return', cls: 'ad-nowrap', cell: r => A.fmtDate(r.due), csv: r => r.due },
        { label: 'Condition at Issue', cell: r => A.badge(r.condition), csv: r => r.condition },
        { label: 'Assignment Status', cell: r => A.badge(r.status), csv: r => r.status },
      ],
      rowActions: [
        { label: 'View details', icon: 'eye', run: details },
        { label: 'Return asset', icon: 'undo', run: giveBack, when: issued },
        { label: 'Assign asset', icon: 'userCheck', run: assign, when: r => !issued(r) },
      ],
    });
  }

  A.boot('asset-assignment', start);
  return { SAMPLE, MECHANICS, MECHANIC_ID, STATUSES, summary };
})();
