/* ============================================================
   routes/attendance.js — Staff Management › Attendance
   ------------------------------------------------------------
     GET    /api/attendance          list (date | from+to, staffId, status, limit, offset)
     GET    /api/attendance/:id      one record
     POST   /api/attendance          { staffId, date, status, checkIn?, checkOut?, notes? }
     PUT    /api/attendance/:id      { status?, checkIn?, checkOut?, notes?, expectedUpdatedAt }
     (no DELETE: a wrong record is corrected, not removed)

   One record per staff member -- a mechanic (MEC-0001) or any other
   employee (STF-0001) -- per day, linked by foreign key and copying
   nothing about the person (migration 0010).

   WHO MAY CALL: anyone signed in, as for every other business route;
   the router's gate has already checked that. Nothing in the API
   restricts a signed-in caller by role (every account is an
   Administrator), so no narrower rule is claimed here.

   SAFETY RULES
     * One record per person per day. A second create for the same day is
       refused (409, naming the existing record) -- before the insert, and
       by the unique indexes if two requests race.
     * A record's person and date never change. Status, times and notes
       change only through PUT, which must send the updatedAt value the
       edit was made from: a record changed meanwhile is refused (409),
       never overwritten.
     * Only an ACTIVE staff member gets a new record, and never for a day
       after today (Asia/Dhaka).
     * Times are 'HH:MM' and only for a day that was worked (Present, Late,
       Half-day); a check-out needs an earlier check-in on the same day.
     * Nothing is calculated from a record: no pay, overtime or leave rule.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, conflict, unprocessable,
} from '../lib/http.js';
import { readJsonBody, readDate, nowIso, todayInDhaka, allocateId, constraintFailure } from '../lib/write.js';

export const ATTENDANCE_STATUSES = ['Present', 'Late', 'Half-day', 'Absent', 'On Leave', 'Holiday'];
const WORKED = ['Present', 'Late', 'Half-day'];
const ATTENDANCE_ID = /^ATT-\d{4,}$/;
const PERSON_ID = /^(MEC|STF)-\d{4,}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const NOTES_MAX = 500;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;
const MAX_RANGE_DAYS = 62;

const CREATE_KEYS = ['staffId', 'date', 'status', 'checkIn', 'checkOut', 'notes'];
const UPDATE_KEYS = ['status', 'checkIn', 'checkOut', 'notes', 'expectedUpdatedAt'];
const FIXED_KEYS = ['staffId', 'date'];

/* ---------- reading ---------- */

const SELECT = `
  SELECT a.id, a.mechanic_id, a.staff_id, a.attendance_date, a.status, a.check_in, a.check_out, a.notes,
         a.created_at, a.updated_at,
         COALESCE(m.name, s.name) AS person_name,
         COALESCE(p.department, s.department) AS department,
         COALESCE(p.designation, s.designation, CASE WHEN m.id IS NOT NULL THEN 'Mechanic' END) AS designation
    FROM attendance a
    LEFT JOIN mechanics m ON m.id = a.mechanic_id
    LEFT JOIN staff p ON p.mechanic_id = a.mechanic_id
    LEFT JOIN staff s ON s.id = a.staff_id`;

/** One row -> the record the page reads. */
function toRecord(row) {
  return {
    id: row.id,
    staffId: row.mechanic_id || row.staff_id,
    isMechanic: Boolean(row.mechanic_id),
    staffName: row.person_name ?? '',
    department: row.department ?? '',
    designation: row.designation ?? '',
    date: row.attendance_date,
    status: row.status,
    checkIn: row.check_in ?? '',
    checkOut: row.check_out ?? '',
    notes: row.notes ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const findRecord = (env, id) => env.DB.prepare(`${SELECT} WHERE a.id = ?1`).bind(id).first();

/** The existing record of one person on one day, if any. */
function findDay(env, staffId, date) {
  const column = staffId.startsWith('MEC-') ? 'a.mechanic_id' : 'a.staff_id';
  return env.DB.prepare(`${SELECT} WHERE ${column} = ?1 AND a.attendance_date = ?2`).bind(staffId, date).first();
}

const readId = (raw) => (typeof raw === 'string' && ATTENDANCE_ID.test(raw) ? raw : null);

/** A YYYY-MM-DD query parameter, or null if absent. */
function readDateParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return { value: null };
  const d = readDate({ [name]: raw.trim() }, name);
  return d.error ? { error: d.error } : { value: d.value };
}

const dayNumber = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;

/** GET /api/attendance */
export async function listAttendance(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const date = readDateParam(url, 'date');
  const from = readDateParam(url, 'from');
  const to = readDateParam(url, 'to');
  for (const p of [date, from, to]) if (p.error) return fail('invalid_parameter', p.error, 400);
  if (date.value !== null && (from.value !== null || to.value !== null)) {
    return fail('invalid_parameter', 'Use either `date` or `from` and `to`, not both.', 400);
  }
  if ((from.value === null) !== (to.value === null)) {
    return fail('invalid_parameter', '`from` and `to` go together.', 400);
  }
  if (from.value !== null) {
    if (to.value < from.value) return fail('invalid_parameter', '`from` must be on or before `to`.', 400);
    if (dayNumber(to.value) - dayNumber(from.value) + 1 > MAX_RANGE_DAYS) {
      return fail('invalid_parameter', `A range may cover at most ${MAX_RANGE_DAYS} days.`, 400);
    }
  }
  const rawStaff = url.searchParams.get('staffId');
  const staffId = rawStaff === null || rawStaff.trim() === '' ? null : rawStaff.trim();
  if (staffId !== null && !PERSON_ID.test(staffId)) return fail('invalid_parameter', '`staffId` is not a staff id.', 400);
  const rawStatus = url.searchParams.get('status');
  const status = rawStatus === null || rawStatus.trim() === '' ? null : rawStatus.trim();
  if (status !== null && !ATTENDANCE_STATUSES.includes(status)) {
    return fail('invalid_parameter', `\`status\` must be one of: ${ATTENDANCE_STATUSES.join(', ')}.`, 400);
  }

  const lo = date.value ?? from.value;
  const hi = date.value ?? to.value;
  const where = `
     WHERE (?1 IS NULL OR a.attendance_date >= ?1)
       AND (?2 IS NULL OR a.attendance_date <= ?2)
       AND (?3 IS NULL OR a.mechanic_id = ?3 OR a.staff_id = ?3)
       AND (?4 IS NULL OR a.status = ?4)`;
  try {
    const { results } = await env.DB.prepare(
      `${SELECT} ${where} ORDER BY a.attendance_date, person_name COLLATE NOCASE, a.id LIMIT ?5 OFFSET ?6`
    ).bind(lo, hi, staffId, status, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n FROM attendance a ${where}`).bind(lo, hi, staffId, status).first();
    const rows = results ?? [];
    return ok(rows.map(toRecord), {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
      statuses: ATTENDANCE_STATUSES, today: todayInDhaka(),
    });
  } catch (err) {
    console.error('GET /api/attendance failed:', err && err.message);
    return fail('database_error', 'Could not read attendance.', 500);
  }
}

/** GET /api/attendance/:id */
export async function getAttendance(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'That is not an attendance id.', 400);
  try {
    const row = await findRecord(env, id);
    if (!row) return fail('not_found', 'No attendance record with that id.', 404);
    return ok(toRecord(row));
  } catch (err) {
    console.error('GET /api/attendance/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the attendance record.', 500);
  }
}

/* ---------- writing ---------- */

/** Field errors for every key the route does not take (an id, a timestamp, ...). */
function unknownKeys(body, allowed) {
  const errors = {};
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    errors[key] = FIXED_KEYS.includes(key)
      ? 'The staff member and the date of a record cannot be changed.'
      : 'This is not an attendance field.';
  }
  return errors;
}

/** '' / null / undefined -> null; otherwise a trimmed string (or the raw value, for the type check). */
function optionalText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
}

/**
 * Check one record's status, times and notes together -- the same rules on
 * create and on the merged result of an update. Adds to `errors`.
 */
function checkDay({ status, checkIn, checkOut, notes }, errors) {
  if (!ATTENDANCE_STATUSES.includes(status)) errors.status = `Choose one of: ${ATTENDANCE_STATUSES.join(', ')}.`;
  for (const [key, value, label] of [['checkIn', checkIn, 'Check-in'], ['checkOut', checkOut, 'Check-out']]) {
    if (value !== null && (typeof value !== 'string' || !TIME.test(value))) errors[key] = `${label} must be a time like 09:30.`;
  }
  const worked = WORKED.includes(status);
  if (!errors.status && !worked) {
    if (checkIn !== null && !errors.checkIn) errors.checkIn = `No check-in time for ${status}.`;
    if (checkOut !== null && !errors.checkOut) errors.checkOut = `No check-out time for ${status}.`;
  }
  if (checkOut !== null && !errors.checkOut && !errors.checkIn) {
    if (checkIn === null) errors.checkOut = 'Enter the check-in time first.';
    else if (checkOut <= checkIn) errors.checkOut = 'Check-out must be after check-in.';
  }
  if (notes !== null && (typeof notes !== 'string' || notes.length > NOTES_MAX)) errors.notes = `Use at most ${NOTES_MAX} characters.`;
}

const duplicateDay = (id) => conflict('Attendance for this staff member on this day is already recorded. Edit that record instead.', {
  reason: 'already_recorded', field: 'staffId',
  fields: { staffId: 'Attendance for this day is already recorded.' }, ...(id ? { conflictsWith: id } : {}),
});
const staleConflict = () => conflict('This attendance record was changed by someone else after you opened it. Reload and try again.', {
  reason: 'concurrent_modification',
});

/** The person a new record would belong to: exists? active? */
async function findPerson(env, staffId) {
  return staffId.startsWith('MEC-')
    ? env.DB.prepare('SELECT id, status FROM mechanics WHERE id = ?1').bind(staffId).first()
    : env.DB.prepare('SELECT id, status FROM staff WHERE id = ?1 AND mechanic_id IS NULL').bind(staffId).first();
}

/** POST /api/attendance */
export async function createAttendance(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();

  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;

  const errors = unknownKeys(body, CREATE_KEYS);
  const staffId = typeof body.staffId === 'string' ? body.staffId.trim() : '';
  if (!PERSON_ID.test(staffId)) errors.staffId = 'Choose a staff member.';
  const date = readDate(body, 'date', { required: true });
  const today = todayInDhaka();
  if (date.error) errors.date = date.error;
  else if (date.value > today) errors.date = 'Attendance cannot be recorded for a future day.';
  const day = { status: body.status, checkIn: optionalText(body.checkIn), checkOut: optionalText(body.checkOut), notes: optionalText(body.notes) };
  checkDay(day, errors);
  if (Object.keys(errors).length) return unprocessable('Some attendance fields are not valid.', errors);

  try {
    const person = await findPerson(env, staffId);
    if (!person) return unprocessable('Some attendance fields are not valid.', { staffId: 'No such staff member.' });
    if (person.status !== 'Active') {
      return unprocessable('Some attendance fields are not valid.', { staffId: 'Attendance can only be recorded for an active staff member.' });
    }
    const existing = await findDay(env, staffId, date.value);
    if (existing) return duplicateDay(existing.id);

    const allocated = await allocateId(env, 'attendance');
    if (allocated.error) {
      console.error('POST /api/attendance could not allocate an id:', allocated.error);
      return fail('database_error', 'Could not record attendance.', 500);
    }
    const now = nowIso();
    const isMechanic = staffId.startsWith('MEC-');
    await env.DB.prepare(
      `INSERT INTO attendance (id, mechanic_id, staff_id, attendance_date, status, check_in, check_out, notes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
    ).bind(allocated.id, isMechanic ? staffId : null, isMechanic ? null : staffId, date.value, day.status,
      day.checkIn, day.checkOut, day.notes, now).run();
    return ok(toRecord(await findRecord(env, allocated.id)), {}, 201);
  } catch (err) {
    // Two creates for the same person and day at once: the unique index refuses the second.
    if (/UNIQUE constraint failed/i.test(String((err && err.message) || ''))) {
      const winner = await findDay(env, staffId, date.value).catch(() => null);
      return duplicateDay(winner ? winner.id : null);
    }
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/attendance failed:', err && err.message);
    return fail('database_error', 'Could not record attendance.', 500);
  }
}

/** PUT /api/attendance/:id -- correct the status, times or notes of an existing record. */
export async function updateAttendance(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'That is not an attendance id.', 400);

  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, UPDATE_KEYS);
  const expected = body.expectedUpdatedAt;
  if (typeof expected !== 'string' || expected === '' || expected.length > 40) {
    errors.expectedUpdatedAt = '`expectedUpdatedAt` is required: send the updatedAt value the edit was made from.';
  }
  if (!Object.keys(errors).length && !['status', 'checkIn', 'checkOut', 'notes'].some((k) => k in body)) {
    errors.status = 'Nothing to change.';
  }
  if (Object.keys(errors).length) return unprocessable('Some attendance fields are not valid.', errors);

  try {
    const row = await findRecord(env, id);
    if (!row) return fail('not_found', 'No attendance record with that id.', 404);
    if (row.updated_at !== expected) return staleConflict();
    const day = {
      status: 'status' in body ? body.status : row.status,
      checkIn: 'checkIn' in body ? optionalText(body.checkIn) : row.check_in,
      checkOut: 'checkOut' in body ? optionalText(body.checkOut) : row.check_out,
      notes: 'notes' in body ? optionalText(body.notes) : row.notes,
    };
    checkDay(day, errors);
    if (Object.keys(errors).length) return unprocessable('Some attendance fields are not valid.', errors);

    let now = nowIso();
    if (now <= row.updated_at) now = new Date(Date.parse(row.updated_at) + 1).toISOString();   // always a new value
    // The check and the change are one statement: an edit made meanwhile cannot be overwritten.
    const res = await env.DB.prepare(
      `UPDATE attendance
          SET status = ?3, check_in = ?4, check_out = ?5, notes = ?6, updated_at = ?7
        WHERE id = ?1 AND updated_at = ?2`
    ).bind(id, expected, day.status, day.checkIn, day.checkOut, day.notes, now).run();
    if (!res.meta || res.meta.changes !== 1) return staleConflict();
    return ok(toRecord(await findRecord(env, id)));
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('PUT /api/attendance/:id failed:', err && err.message);
    return fail('database_error', 'Could not update the attendance record.', 500);
  }
}
