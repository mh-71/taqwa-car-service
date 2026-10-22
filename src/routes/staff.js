/* ============================================================
   routes/staff.js — /api/staff[/:id]
   ------------------------------------------------------------
   The workshop's whole roster, for Staff Management › Staff List:
   mechanics AND every other employee, as one list. See migration
   0008 for the model; in short:

     * A mechanic stays in `mechanics` (MEC-0001), untouched, with an
       optional `staff` profile row under the same id that holds only
       employee code, designation and department. Name, phone, email,
       joining date and status are read from and written to the
       mechanic row itself -- never copied -- so the Mechanics page
       and the Staff List can never disagree about a person.
     * Any other employee is one `staff` row (STF-0001).

   Routes
     GET  /api/staff          list (filters: q, status, department,
                              designation; limit/offset paging)
     GET  /api/staff/:id      one, with address / notes (and, for a
                              mechanic, specialization, alt phone and
                              employment type)
     POST /api/staff          create; `isMechanic: true` creates the
                              mechanic row (validated by the Mechanics
                              route's own rules) and its profile
     PUT  /api/staff/:id      merge, like every PUT in this API
   There is no DELETE: an employee who leaves is set Inactive, which
   keeps every job card, appointment and task that names them.

   Pay is not part of this API. salary, salaryType and commissionRate
   are refused by name, and no response carries them; they stay on the
   Mechanics page.

   Rules the schema cannot express, checked here:
     * one ACTIVE employee per phone number across the whole roster
       (the Mechanics route's rule, widened to every employee);
     * an employee code is unique ignoring case (the schema's index is
       the final word; this check only gives the 409 a useful message);
     * a staff member's type (mechanic or not) is fixed once created.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId, conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readString, readEnum, readDate, nowIso, todayInDhaka, allocateId, constraintFailure,
} from '../lib/write.js';
import { fieldSet } from '../lib/collection-write.js';
import { readMechanicFields } from './mechanics.js';

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

const STATUSES = ['Active', 'Inactive'];
const PHONE = /^[0-9\+\-\s()]{6,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPLOYEE_CODE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const PHONE_QUERY = /^[0-9+\-\s()]+$/;
const EARLIEST_JOINING = '1980-01-01';
const LIMITS = { employeeCode: 20, designation: 60, department: 60, name: 120, phone: 20, email: 160, address: 500, notes: 1000, q: 100 };

/** Pay lives on the Mechanics page; naming it here is refused rather than ignored. */
const PAY_FIELDS = ['salary', 'salaryType', 'commissionRate'];

/** The mechanic fields the Staff List may write, through the Mechanics route's own rules. */
const MECHANIC_KEYS = ['name', 'phone', 'altPhone', 'email', 'address', 'specialization',
  'joiningDate', 'employmentType', 'notes', 'status'];

const digits = (phone) => String(phone || '').replace(/\D/g, '');

/** A phone column with the separators the app allows stripped, in SQL. */
const DIGITS_SQL = (col) =>
  `replace(replace(replace(replace(replace(${col}, '+', ''), '-', ''), ' ', ''), '(', ''), ')', '')`;

/**
 * Every employee as one row shape. Mechanics come first through a LEFT JOIN,
 * so one with no profile yet is still listed; then every employee who is not
 * a mechanic. Designation falls back to 'Mechanic' for a mechanic whose
 * profile does not set one, so lists and filters see one consistent value.
 * The column list is explicit: pay never enters it.
 */
const MECHANIC_COLUMNS = `
         m.id                                 AS id,
         1                                    AS is_mechanic,
         s.employee_code                      AS employee_code,
         m.name                               AS name,
         COALESCE(s.designation, 'Mechanic')  AS designation,
         s.department                         AS department,
         m.phone                              AS phone,
         m.email                              AS email,
         m.joining_date                       AS joining_date,
         m.status                             AS status,
         m.created_at                         AS created_at,
         CASE WHEN s.updated_at IS NOT NULL AND (m.updated_at IS NULL OR s.updated_at > m.updated_at)
              THEN s.updated_at ELSE m.updated_at END AS updated_at`;

const ROSTER = `
  SELECT ${MECHANIC_COLUMNS}
    FROM mechanics m
    LEFT JOIN staff s ON s.mechanic_id = m.id
  UNION ALL
  SELECT s.id, 0, s.employee_code, s.name, s.designation, s.department, s.phone, s.email,
         s.joining_date, s.status, s.created_at, s.updated_at
    FROM staff s
   WHERE s.mechanic_id IS NULL`;

const LIST_COLUMNS = `id, is_mechanic, employee_code, name, designation, department, phone, email,
  joining_date, status, created_at, updated_at`;

/** One roster row -> the record the Staff List reads. Text falls back to ''. */
function toRecord(row) {
  return {
    id: row.id,
    isMechanic: Number(row.is_mechanic) === 1,
    employeeCode: row.employee_code ?? '',
    name: row.name,
    designation: row.designation ?? '',
    department: row.department ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    joiningDate: row.joining_date ?? '',
    status: row.status,
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/** The detail shape: the list record plus the fields a View or Edit needs. */
function toDetail(row) {
  const record = { ...toRecord(row), address: row.address ?? '', notes: row.notes ?? '' };
  if (record.isMechanic) {
    record.specialization = row.specialization ?? '';
    record.altPhone = row.alt_phone ?? '';
    record.employmentType = row.employment_type ?? '';
  }
  return record;
}

/** Read one employee in the detail shape, or null. */
async function findStaff(env, id) {
  const mechanic = await env.DB.prepare(
    `SELECT ${MECHANIC_COLUMNS},
            m.address, m.notes, m.alt_phone, m.specialization, m.employment_type
       FROM mechanics m
       LEFT JOIN staff s ON s.mechanic_id = m.id
      WHERE m.id = ?1`
  ).bind(id).first();
  if (mechanic) return mechanic;
  return env.DB.prepare(
    `SELECT id, 0 AS is_mechanic, employee_code, name, designation, department, phone, email,
            joining_date, status, created_at, updated_at, address, notes
       FROM staff
      WHERE id = ?1 AND mechanic_id IS NULL`
  ).bind(id).first();
}

/* ---------- reads -------------------------------------------------------- */

/** An optional query-string filter: trimmed, bounded, or an error. */
function readFilter(url, name, max) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return { value: null };
  if (raw.length > max) return { error: `\`${name}\` must be ${max} characters or fewer.` };
  return { value: raw.trim() };
}

/** GET /api/staff?q=&status=&department=&designation=&limit=&offset= */
export async function listStaff(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);

  const q = readFilter(url, 'q', LIMITS.q);
  const status = readFilter(url, 'status', 20);
  const department = readFilter(url, 'department', LIMITS.department);
  const designation = readFilter(url, 'designation', LIMITS.designation);
  for (const f of [q, status, department, designation]) {
    if (f.error) return fail('invalid_parameter', f.error, 400);
  }
  if (status.value !== null && !STATUSES.includes(status.value)) {
    return fail('invalid_parameter', '`status` must be Active or Inactive.', 400);
  }

  const needle = q.value === null ? null : q.value.toLowerCase();
  // Only a query that looks like a phone number is matched against phone
  // digits, so "TQ-101" does not also find every number containing 101.
  const phoneNeedle = q.value !== null && PHONE_QUERY.test(q.value) && digits(q.value) !== '' ? digits(q.value) : null;
  const where = `
     WHERE (?1 IS NULL OR status = ?1)
       AND (?2 IS NULL OR department = ?2 COLLATE NOCASE)
       AND (?3 IS NULL OR designation = ?3 COLLATE NOCASE)
       AND (?4 IS NULL
            OR instr(lower(name), ?4) > 0
            OR instr(lower(id), ?4) > 0
            OR instr(lower(COALESCE(employee_code, '')), ?4) > 0
            OR instr(lower(COALESCE(email, '')), ?4) > 0
            OR (?5 IS NOT NULL AND instr(${DIGITS_SQL('phone')}, ?5) > 0))`;
  const filters = [status.value, department.value, designation.value, needle, phoneNeedle];

  try {
    const { results } = await env.DB.prepare(
      `WITH roster AS (${ROSTER})
       SELECT ${LIST_COLUMNS} FROM roster ${where}
        ORDER BY name COLLATE NOCASE, id
        LIMIT ?6 OFFSET ?7`
    ).bind(...filters, limit.value, offset.value).all();
    const rows = results ?? [];
    const total = await env.DB.prepare(
      `WITH roster AS (${ROSTER}) SELECT count(*) AS n FROM roster ${where}`
    ).bind(...filters).first();

    return ok(rows.map(toRecord), {
      count: rows.length,
      total: total ? total.n : rows.length,
      limit: limit.value,
      offset: offset.value,
    });
  } catch (err) {
    console.error('GET /api/staff failed:', err);
    return fail('database_error', 'Could not read staff.', 500);
  }
}

/** GET /api/staff/:id */
export async function getStaff(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);
  try {
    const row = await findStaff(env, id.value);
    if (!row) return fail('not_found', 'No staff member with that id.', 404);
    return ok(toDetail(row));
  } catch (err) {
    console.error('GET /api/staff/:id failed:', err);
    return fail('database_error', 'Could not read the staff member.', 500);
  }
}

/* ---------- writes ------------------------------------------------------- */

/** An optional text field where blank means "not recorded" (stored NULL). */
function optionalText(body, key, max) {
  const r = readString(body, key, { max, fallback: null });
  return r.error ? r : { value: r.value === '' ? null : r.value };
}

/**
 * Employee code, designation and department -- the fields every employee has.
 * For someone who is not a mechanic, designation and department are required;
 * for a mechanic, blank clears them (designation then reads as 'Mechanic').
 */
function readHrFields(body, mode, isMechanic) {
  const f = fieldSet(body, mode);
  f.take('employee_code', 'employeeCode', optionalText(body, 'employeeCode', LIMITS.employeeCode));
  if (f.values.employee_code && !EMPLOYEE_CODE.test(f.values.employee_code)) {
    f.reject('employeeCode', 'Use letters, digits, and - . / _ only, starting with a letter or digit.');
  }
  for (const [column, key] of [['designation', 'designation'], ['department', 'department']]) {
    const read = isMechanic
      ? optionalText(body, key, LIMITS[key])
      : readString(body, key, { required: true, max: LIMITS[key] });
    f.take(column, key, read);
  }
  return f;
}

/** The person, for an employee who is not a mechanic. Mirrors the Mechanics rules. */
function readPersonFields(body, mode) {
  const f = fieldSet(body, mode);
  const required = mode === 'create';
  f.take('name', 'name', readString(body, 'name', { required, max: LIMITS.name }));
  f.take('phone', 'phone', readString(body, 'phone', { required, max: LIMITS.phone }));
  f.take('email', 'email', optionalText(body, 'email', LIMITS.email));
  f.take('address', 'address', optionalText(body, 'address', LIMITS.address));
  f.take('joining_date', 'joiningDate', readDate(body, 'joiningDate', { fallback: null }));
  if (f.values.joining_date === '') f.values.joining_date = null;
  f.take('notes', 'notes', optionalText(body, 'notes', LIMITS.notes));
  f.take('status', 'status', readEnum(body, 'status', STATUSES, { fallback: 'Active' }));

  // An update that sends a blank name or phone means "clear it", which a
  // required field cannot be.
  if (mode === 'update') {
    if (body.name !== undefined && f.values.name === '') f.reject('name', '`name` cannot be blank.');
    if (body.phone !== undefined && f.values.phone === '') f.reject('phone', '`phone` cannot be blank.');
    if (body.status === null || body.status === '') f.reject('status', '`status` must be Active or Inactive.');
  }
  if (f.values.phone && !PHONE.test(f.values.phone)) {
    f.reject('phone', 'Enter a valid phone number (digits, +, -, spaces).');
  }
  if (f.values.email && !EMAIL.test(f.values.email)) {
    f.reject('email', 'Enter a valid email address.');
  }
  if (f.values.joining_date) {
    if (f.values.joining_date < EARLIEST_JOINING) f.reject('joiningDate', 'Joining date looks too old.');
    else if (f.values.joining_date > todayInDhaka()) f.reject('joiningDate', 'Joining date cannot be in the future.');
  }
  return f;
}

/** A mechanic's person fields, through the Mechanics route's own readFields. */
function readMechanicPerson(body, mode) {
  const picked = {};
  for (const key of MECHANIC_KEYS) if (body[key] !== undefined) picked[key] = body[key];
  const f = readMechanicFields(picked, mode);
  // The schema would refuse these as a bare CHECK failure; say which field.
  if (mode === 'update') {
    if (picked.name !== undefined && f.values.name === '') f.reject('name', '`name` cannot be blank.');
    if (picked.phone !== undefined && f.values.phone === '') f.reject('phone', '`phone` cannot be blank.');
  }
  return f;
}

/** Field errors for pay, and for an `isMechanic` that is not a boolean. */
function foreignFields(body) {
  const errors = {};
  for (const key of PAY_FIELDS) {
    if (body[key] !== undefined) errors[key] = 'Pay is managed on the Mechanics page, not in the staff list.';
  }
  if (body.isMechanic !== undefined && typeof body.isMechanic !== 'boolean') {
    errors.isMechanic = '`isMechanic` must be true or false.';
  }
  return { errors };
}

/** One ACTIVE employee per phone number, across mechanics and other staff. */
async function phoneClash(env, phone, selfId) {
  const d = digits(phone);
  if (!d) return null;
  const row = await env.DB.prepare(
    `WITH roster AS (${ROSTER})
     SELECT id FROM roster
      WHERE status = 'Active' AND ${DIGITS_SQL('phone')} = ?1 AND (?2 IS NULL OR id <> ?2)
      LIMIT 1`
  ).bind(d, selfId).first();
  const message = 'A staff member with this phone number already exists.';
  // `fields` puts the message on the form's phone input, as a 422 would.
  return row
    ? conflict(message, { conflictsWith: row.id, field: 'phone', fields: { phone: `${message} (${row.id})` } })
    : null;
}

/** An employee code is unique ignoring case. */
async function codeClash(env, code, selfId) {
  if (!code) return null;
  const row = await env.DB.prepare(
    `SELECT id FROM staff WHERE employee_code = ?1 COLLATE NOCASE AND (?2 IS NULL OR id <> ?2) LIMIT 1`
  ).bind(code, selfId).first();
  return row ? duplicateCode(row.id) : null;
}

const DUPLICATE_CODE = 'That employee code is already used by another staff member.';
const duplicateCode = (conflictsWith = null) =>
  conflict(DUPLICATE_CODE, {
    field: 'employeeCode',
    fields: { employeeCode: conflictsWith ? `${DUPLICATE_CODE} (${conflictsWith})` : DUPLICATE_CODE },
    ...(conflictsWith ? { conflictsWith } : {}),
  });

/** A constraint error from a write, with the employee-code index named for the form. */
function writeFailure(err, what) {
  if (/UNIQUE constraint failed/i.test(String(err && err.message)) && /employee_code/i.test(String(err.message))) {
    return duplicateCode();
  }
  const mapped = constraintFailure(err);
  if (mapped) return mapped;
  console.error(`${what} failed:`, err);
  return null;
}

const insertSql = (table, values) => {
  const names = Object.keys(values);
  return {
    sql: `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((_, i) => `?${i + 1}`).join(', ')})`,
    binds: names.map((n) => values[n]),
  };
};

/** Field errors from both halves of a write, or null. */
function fieldErrors(...sets) {
  const errors = Object.assign({}, ...sets.map((s) => s.errors));
  return Object.keys(errors).length ? unprocessable('Some staff fields are not valid.', errors) : null;
}

/** POST /api/staff */
export async function createStaff(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;

  const isMechanic = body.isMechanic === true;
  const hr = readHrFields(body, 'create', isMechanic);
  const person = isMechanic ? readMechanicPerson(body, 'create') : readPersonFields(body, 'create');
  // Every problem at once, so a form can mark all of them in one round trip.
  const invalid = fieldErrors(foreignFields(body), hr, person);
  if (invalid) return invalid;

  try {
    const clash = await phoneClash(env, person.values.phone, null) || await codeClash(env, hr.values.employee_code, null);
    if (clash) return clash;

    const allocated = await allocateId(env, isMechanic ? 'mechanics' : 'staff');
    if (allocated.error) {
      console.error('POST /api/staff could not allocate an id:', allocated.error);
      return fail('database_error', 'Could not create the staff member.', 500);
    }
    const id = allocated.id;
    const now = nowIso();

    if (isMechanic) {
      const mech = insertSql('mechanics', { ...person.values, id, created_at: now });
      const statements = [env.DB.prepare(mech.sql).bind(...mech.binds)];
      // The profile only exists once there is something to put in it.
      if (Object.values(hr.values).some((v) => v !== null && v !== undefined)) {
        const profile = insertSql('staff', { id, mechanic_id: id, ...hr.values, created_at: now });
        statements.push(env.DB.prepare(profile.sql).bind(...profile.binds));
      }
      await env.DB.batch(statements);
    } else {
      const row = insertSql('staff', { id, ...hr.values, ...person.values, created_at: now });
      await env.DB.prepare(row.sql).bind(...row.binds).run();
    }

    return ok(toDetail(await findStaff(env, id)), {}, 201);
  } catch (err) {
    return writeFailure(err, 'POST /api/staff') || fail('database_error', 'Could not create the staff member.', 500);
  }
}

/** PUT /api/staff/:id — merge, not replace. */
export async function updateStaff(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;

  try {
    const current = await findStaff(env, id.value);
    if (!current) return fail('not_found', 'No staff member with that id.', 404);
    const isMechanic = Number(current.is_mechanic) === 1;
    if (body.isMechanic !== undefined && body.isMechanic !== isMechanic) {
      return unprocessable('Some staff fields are not valid.', {
        isMechanic: 'Whether someone is a mechanic is fixed once they are added.',
      });
    }

    const hr = readHrFields(body, 'update', isMechanic);
    const person = isMechanic ? readMechanicPerson(body, 'update') : readPersonFields(body, 'update');
    const invalid = fieldErrors(foreignFields(body), hr, person);
    if (invalid) return invalid;
    if (!hr.touched && !person.touched) return unprocessable('No staff fields were supplied to update.');

    // The phone rule applies to whoever ends up Active: a changed number, or
    // someone being reactivated with the number they already had.
    const status = person.values.status ?? current.status;
    if (status === 'Active' && (person.values.phone !== undefined || person.values.status === 'Active')) {
      const clash = await phoneClash(env, person.values.phone ?? current.phone, id.value);
      if (clash) return clash;
    }
    if (hr.values.employee_code) {
      const clash = await codeClash(env, hr.values.employee_code, id.value);
      if (clash) return clash;
    }

    const now = nowIso();
    const statements = [];
    if (isMechanic) {
      if (person.touched) {
        const names = Object.keys(person.values);
        statements.push(env.DB.prepare(
          `UPDATE mechanics SET ${names.map((n, i) => `${n} = ?${i + 1}`).join(', ')}, updated_at = ?${names.length + 1}
            WHERE id = ?${names.length + 2}`
        ).bind(...names.map((n) => person.values[n]), now, id.value));
      }
      if (hr.touched) {
        const names = Object.keys(hr.values);
        const cols = ['id', 'mechanic_id', ...names, 'created_at', 'updated_at'];
        statements.push(env.DB.prepare(
          `INSERT INTO staff (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})
           ON CONFLICT(id) DO UPDATE SET ${names.map((n) => `${n} = excluded.${n}`).join(', ')}, updated_at = excluded.updated_at`
        ).bind(id.value, id.value, ...names.map((n) => hr.values[n]), now, now));
      }
    } else {
      const values = { ...hr.values, ...person.values };
      const names = Object.keys(values);
      statements.push(env.DB.prepare(
        `UPDATE staff SET ${names.map((n, i) => `${n} = ?${i + 1}`).join(', ')}, updated_at = ?${names.length + 1}
          WHERE id = ?${names.length + 2} AND mechanic_id IS NULL`
      ).bind(...names.map((n) => values[n]), now, id.value));
    }
    // One batch: a mechanic's person and profile change together or not at all.
    await env.DB.batch(statements);

    const row = await findStaff(env, id.value);
    if (!row) return fail('not_found', 'No staff member with that id.', 404);
    return ok(toDetail(row));
  } catch (err) {
    return writeFailure(err, 'PUT /api/staff/:id') || fail('database_error', 'Could not update the staff member.', 500);
  }
}
