/* ============================================================
   staff-form.js — the staff form's rules, shared
   ------------------------------------------------------------
   Loaded by the two pages that write staff: Add Staff (a new
   employee) and the Staff List (editing one). It holds the field
   limits, the suggested designations and departments, the
   browser's copy of the Worker's validation and the request body,
   so both pages refuse and send exactly the same things.

   The Worker (src/routes/staff.js) re-checks every rule and is the
   only judge; these checks only spare a round trip. Nothing here
   reads or writes data, the network or browser storage.
   ============================================================ */

const StaffForm = (() => {

  /* Field limits: the Worker's (src/routes/staff.js LIMITS) and the schema's
     CHECKs (0008) use the same numbers. */
  const LIMITS = { employeeCode: 20, designation: 60, department: 60, name: 120, phone: 20,
    email: 160, address: 500, notes: 1000, specialization: 80, search: 100 };
  const PHONE = /^[0-9+\-\s()]{6,20}$/;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const EMPLOYEE_CODE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
  const LABEL_TEXT = /^[\p{L}\p{M}\p{N} .,&/()'+-]+$/u;
  const EARLIEST_JOINING = '1980-01-01';
  const STATUSES = ['Active', 'Inactive'];

  // Offered as choices; any other designation or department can still be typed.
  const DESIGNATIONS = ['Mechanic', 'Senior Mechanic', 'Technician', 'Electrician', 'Helper', 'Service Advisor',
    'Receptionist', 'Accountant', 'Storekeeper', 'Office Assistant', 'Workshop Manager', 'Manager', 'Administrator'];
  const DEPARTMENTS = ['Workshop', 'Front Desk', 'Accounts', 'Stores', 'Management', 'Administration'];

  /**
   * The browser's copy of the Worker's rules. Returns { field: message }.
   * `mode: 'create'` also requires a joining date, as the Worker does for a
   * new employee; an edit may leave an old record's date unrecorded.
   */
  function validate(v, { isMechanic = false, mode = 'edit', today = Utils.todayStr() } = {}) {
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
    for (const [key, label] of [['designation', 'Designation'], ['department', 'Department']]) {
      if (!e[key] && v[key] && !LABEL_TEXT.test(v[key])) e[key] = 'Use letters, digits, spaces and . , & / ( ) \' + - only.';
      max(key, label);
    }
    if (isMechanic) { need('specialization', 'Specialization'); max('specialization', 'Specialization'); }
    if (mode === 'create') need('joiningDate', 'Joining date');
    if (v.joiningDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.joiningDate)) e.joiningDate = 'Enter a real date.';
      else if (v.joiningDate < EARLIEST_JOINING) e.joiningDate = 'Joining date looks too old.';
      else if (today && v.joiningDate > today) e.joiningDate = 'Joining date cannot be in the future.';
    }
    if (!STATUSES.includes(v.status)) e.status = 'Choose Active or Inactive.';
    max('address', 'Address'); max('notes', 'Notes');
    return e;
  }

  /** The request body for a create or an edit. Never carries pay, an id or anything else the Worker refuses. */
  function payload(v, { isMechanic = false, mode = 'create' } = {}) {
    const body = {
      name: v.name, phone: v.phone, email: v.email, address: v.address, joiningDate: v.joiningDate,
      status: v.status, notes: v.notes, employeeCode: v.employeeCode, designation: v.designation, department: v.department,
    };
    if (isMechanic) body.specialization = v.specialization;
    if (mode === 'create') body.isMechanic = !!isMechanic;
    return body;
  }

  return { LIMITS, STATUSES, DESIGNATIONS, DEPARTMENTS, EARLIEST_JOINING, validate, payload };
})();
