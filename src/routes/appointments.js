/* ============================================================
   routes/appointments.js — GET /api/appointments[/:id]  (read-only)
   ------------------------------------------------------------
   The booking diary. List/detail plumbing comes from
   lib/collection.js; this file supplies the table, its column list
   and the row mapper.

   ---- relationships stay as ids ----

   Five reference columns: customer_id, vehicle_id and service_id are
   NOT NULL, mechanic_id and job_card_id are nullable. All five are
   returned as ids and nothing is joined. js/appointments.js says why
   in its own header: "Relationships are ID-based (customerId,
   vehicleId, serviceId, mechanicId); names are resolved at render
   time with safe fallbacks." The detail view calls vehInfo(),
   svcRec(), mecName() itself, so a joined name here would be a second
   copy of data the UI already looks up -- and one that goes stale the
   moment a customer is renamed.

   job_card_id is the Job Card integration hook and is written from
   the other side (job-cards.js:891 links, :1083 unlinks). It is
   reported as stored; this phase creates nothing and links nothing.

   ---- values are returned as stored ----

   Both `status` and `source` are returned verbatim. The frontend
   normalises each at READ time -- normStatus() maps the legacy
   'Pending'/'In Service' aliases, normSource() folds an unknown or
   missing value to 'Admin' -- but those exist for old localStorage
   records and rewrite nothing. In D1 both columns are NOT NULL with a
   CHECK, so a non-canonical value cannot be stored in the first
   place. Moving that normalisation into the API would mean reporting
   a value the database does not hold, and would quietly mask a row
   that somehow got past the CHECK. The five canonical sources are
   Admin, Phone, Walk-in, Facebook, Website; the six statuses are
   Scheduled, Confirmed, In Progress, Completed, Cancelled, No Show.

   ---- date and time are text, and stay text ----

   `date` is a local calendar day ('2026-09-18') and `time` is a
   local wall clock ('14:30'). Both are TEXT and are passed straight
   through: no Date parsing, no toISOString(), no timezone maths.
   Audit Finding 2 was about exactly this -- deriving a calendar day
   through UTC shifts it for anyone east of Greenwich, and the shop is
   in Dhaka (UTC+6). appointments.js contains no toISOString() call
   for the same reason, and this route keeps it that way.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';
import { collectionWrite, fieldSet } from '../lib/collection-write.js';
import { readString, readNumber, readEnum, readDate, todayInDhaka } from '../lib/write.js';
import { conflict, unprocessable } from '../lib/http.js';

const COLUMNS = `
  id, customer_id, vehicle_id, service_id, mechanic_id, job_card_id,
  date, time, duration, status, source, complaint, notes,
  reminder_sent, created_at, updated_at
`;

/**
 * One D1 row -> the record shape the app's UI modules already expect.
 *
 * Reference ids fall back to null, not ''. Every UI read of them is a
 * truthiness check (appointments.js:114, :660, :692), so either would render
 * the same, but '' is not an identifier and would be rejected by the foreign
 * key if it were ever written back. null is also what the app itself already
 * stores for an absent reference: seed-data.js writes `jobCardId: null` and
 * job-cards.js:702/:1083 writes null when unlinking.
 *
 * complaint and notes fall back to '' instead, because they are prose the UI
 * concatenates and renders directly.
 *
 * `duration` is NOT NULL DEFAULT 60, so it always arrives as a number. The UI's
 * `Number(a.duration) || 60` (:271, :383) is its own render-time default for
 * legacy records and is left to it.
 *
 * `reminder_sent` is the first boolean in this API. D1 has no boolean type, so
 * the schema stores INTEGER CHECK (reminder_sent IN (0, 1)) while the app has
 * always held a real boolean (seed-data.js: `reminderSent: false`). Converting
 * here keeps the seam honest: the UI keeps receiving a boolean, and nobody
 * downstream has to remember that 0 is falsy in JS but '0' would not be.
 */
function toRecord(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    serviceId: row.service_id,
    mechanicId: row.mechanic_id ?? null,
    jobCardId: row.job_card_id ?? null,
    date: row.date,
    time: row.time,
    duration: row.duration,
    status: row.status,
    source: row.source,
    complaint: row.complaint ?? '',
    notes: row.notes ?? '',
    reminderSent: row.reminder_sent === 1,
    createdAt: row.created_at,
    // Omitted rather than null until first updated, matching storage.js.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/* ---------- writes ----------------------------------------------------- */

/* Every constant below is copied from js/appointments.js rather than invented,
   because the form and the API have to agree about what a legal appointment
   is. Line references are to that file. */

// :18 — the six the column's CHECK also allows.
const STATUSES = ['Scheduled', 'Confirmed', 'In Progress', 'Completed', 'Cancelled', 'No Show'];
// :22 — the statuses that occupy the schedule. Terminal ones never block.
const BLOCKING = ['Scheduled', 'Confirmed', 'In Progress'];
// :26 — current status -> the statuses it may move to. Terminal ones are [].
const TRANSITIONS = {
  Scheduled: ['Confirmed', 'Cancelled', 'No Show'],
  Confirmed: ['In Progress', 'Cancelled', 'No Show'],
  'In Progress': ['Completed'],
  Completed: [],
  Cancelled: [],
  'No Show': [],
};
// :391 — a NEW appointment's status dropdown offers only these two.
const CREATE_STATUSES = ['Scheduled', 'Confirmed'];
// The five canonical origins, matching the column's CHECK.
const SOURCES = ['Admin', 'Phone', 'Walk-in', 'Facebook', 'Website'];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** :80 — 'HH:MM' -> minutes since midnight. */
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/** An optional reference: the form sends '' for "none", the column stores NULL. */
function referenceId(body, key) {
  const raw = body[key];
  if (raw === null || raw === undefined || raw === '') return { value: null };
  if (typeof raw !== 'string') return { error: `\`${key}\` must be an id.` };
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null };
  if (trimmed.length > 32) return { error: `\`${key}\` is too long.` };
  return { value: trimmed };
}

function readFields(body, mode) {
  const f = fieldSet(body, mode);
  const required = mode === 'create';

  // Linking an appointment to a job card is the Job Card phase's job, and it
  // is a two-table operation (appointments.job_card_id and
  // job_cards.appointment_id point at each other). Refused by name here rather
  // than ignored, so a caller cannot believe it created a link.
  if (body.jobCardId !== undefined) {
    f.reject('jobCardId', '`jobCardId` cannot be set here. Job card linking is a job card operation.');
  }

  f.take('customer_id', 'customerId', readString(body, 'customerId', { required, max: 32 }));
  f.take('vehicle_id', 'vehicleId', readString(body, 'vehicleId', { required, max: 32 }));
  f.take('service_id', 'serviceId', readString(body, 'serviceId', { required, max: 32 }));
  f.take('mechanic_id', 'mechanicId', referenceId(body, 'mechanicId'));

  f.take('date', 'date', readDate(body, 'date', { required }));
  f.take('time', 'time', readString(body, 'time', { required, max: 5 }));
  // :467 — the form's own bounds, which match the column's CHECK exactly.
  f.take('duration', 'duration', readNumber(body, 'duration', { required, min: 1, max: 600, integer: true }));

  // :391 — a new appointment may only be Scheduled or Confirmed. An update may
  // send any of the six; whether the move is legal from where it is now is a
  // question about the stored record, so it is answered in beforeWrite().
  f.take('status', 'status', readEnum(body, 'status', required ? CREATE_STATUSES : STATUSES,
    { fallback: required ? 'Scheduled' : null }));
  f.take('source', 'source', readEnum(body, 'source', SOURCES, { required }));

  f.take('complaint', 'complaint', readString(body, 'complaint', { max: 1000 }));
  f.take('notes', 'notes', readString(body, 'notes', { max: 1000 }));

  // The app's only boolean. D1 has no boolean type, so the API boundary keeps
  // the boolean and the column keeps 0/1 -- the same conversion the read route
  // already does in the other direction.
  if (body.reminderSent !== undefined) {
    f.take('reminder_sent', 'reminderSent',
      typeof body.reminderSent === 'boolean'
        ? { value: body.reminderSent ? 1 : 0 }
        : { error: '`reminderSent` must be true or false.' });
  } else if (required) {
    f.take('reminder_sent', 'reminderSent', { value: 0 });
  }

  if (f.values.time !== undefined && !TIME.test(f.values.time)) {
    f.reject('time', 'Enter a valid time (HH:MM).');
  }
  // :457 — only a NEW appointment is barred from the past; editing an old one
  // must stay possible. "Today" is the workshop's calendar day, not the
  // Worker's UTC one.
  if (required && f.values.date !== undefined && f.values.date < todayInDhaka()) {
    f.reject('date', 'New appointments cannot be in the past.');
  }
  return f;
}

/**
 * The scheduling rules, all of which are about the record as it will be AFTER
 * the write -- so on an update the stored row is read first and the supplied
 * fields merged over it. Judging the patch alone would let a request that
 * changes only the time slip past the overlap check.
 *
 * Four questions, one round trip (see the query below):
 *
 *   1. does the vehicle belong to the customer?      :446
 *   2. does the slot overlap a blocking appointment? :105
 *   3. is this an exact duplicate booking?           :123
 *   4. (update only) is the status move legal?       :26
 *
 * Existence of the customer, vehicle, service and mechanic is NOT checked
 * here: all four are foreign keys, three of them NOT NULL, so a bad reference
 * raises a FOREIGN KEY error that collection-write maps to 409 without a
 * preflight SELECT.
 */
async function beforeWrite(env, values, { mode, id }) {
  let current = null;
  if (mode === 'update') {
    current = await env.DB.prepare(
      `SELECT customer_id, vehicle_id, service_id, mechanic_id,
              date, time, duration, status
         FROM appointments WHERE id = ?1`
    ).bind(id).first();
    // Nothing to judge; the UPDATE itself reports the 404.
    if (!current) return null;
  }

  // `in` rather than ?? — clearing the mechanic sends an explicit null, which
  // must override the stored one rather than fall back to it.
  const pick = (column) => (column in values
    ? values[column]
    : (current ? current[column] : undefined));

  const merged = {
    customer_id: pick('customer_id'),
    vehicle_id: pick('vehicle_id'),
    service_id: pick('service_id'),
    mechanic_id: pick('mechanic_id') ?? null,
    date: pick('date'),
    time: pick('time'),
    duration: pick('duration'),
    status: pick('status'),
  };

  // ---- status transitions -------------------------------------------------
  // :587 — a move is legal only if TRANSITIONS lists it. Staying put is always
  // legal, which is what the edit form's [current, ...allowed] dropdown means.
  if (mode === 'update' && values.status !== undefined && values.status !== current.status) {
    const allowed = TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(values.status)) {
      return conflict(
        `Cannot change a ${current.status} appointment to ${values.status}.`,
        {
          reason: 'illegal_status_transition',
          from: current.status,
          to: values.status,
          allowed,
        }
      );
    }
  }

  const newStart = toMinutes(merged.time);
  const newEnd = newStart + Number(merged.duration);
  const blocking = BLOCKING.map((s) => `'${s}'`).join(', ');
  // Start minute of an existing row, from its 'HH:MM' text. Written once and
  // reused so the two halves of the overlap test cannot drift apart.
  const startMinutes =
    "(CAST(substr(time, 1, 2) AS INTEGER) * 60 + CAST(substr(time, 4, 2) AS INTEGER))";

  const check = await env.DB.prepare(
    `WITH clash AS (
       SELECT id,
              CASE WHEN ?5 IS NOT NULL AND mechanic_id = ?5 THEN 'mechanic'
                   ELSE 'vehicle' END AS reason
         FROM appointments
        WHERE date = ?1
          AND status IN (${blocking})
          AND (?2 IS NULL OR id <> ?2)
          AND ((?5 IS NOT NULL AND mechanic_id = ?5)
            OR (?6 IS NOT NULL AND vehicle_id = ?6))
          AND ${startMinutes} < ?4
          AND ${startMinutes} + duration > ?3
        LIMIT 1
     )
     SELECT
       (SELECT customer_id FROM vehicles WHERE id = ?6)   AS vehicle_owner,
       (SELECT id     FROM clash)                          AS clash_id,
       (SELECT reason FROM clash)                          AS clash_reason,
       (SELECT id FROM appointments
          WHERE (?2 IS NULL OR id <> ?2)
            AND customer_id = ?7 AND vehicle_id = ?6 AND service_id = ?8
            AND date = ?1 AND time = ?9
            AND status <> 'Cancelled'
          LIMIT 1)                                         AS duplicate_id`
  )
    .bind(
      merged.date, mode === 'update' ? id : null,
      newStart, newEnd,
      merged.mechanic_id, merged.vehicle_id,
      merged.customer_id, merged.service_id, merged.time
    )
    .first();

  // ---- the vehicle must belong to the customer ----------------------------
  // :446. Nothing in the schema expresses this -- there is no composite key --
  // so it is an application rule. A missing vehicle is left to the foreign key.
  if (check.vehicle_owner !== null && check.vehicle_owner !== merged.customer_id) {
    return unprocessable('Some appointment fields are not valid.', {
      vehicleId: 'This vehicle does not belong to the selected customer.',
    });
  }

  // ---- overlap ------------------------------------------------------------
  if (check.clash_id) {
    return conflict(
      `This slot overlaps appointment ${check.clash_id} for the same ${check.clash_reason}.`,
      { reason: 'schedule_conflict', conflictsWith: check.clash_id, resource: check.clash_reason }
    );
  }

  // ---- exact duplicate ----------------------------------------------------
  // :123 — same customer, vehicle, service, date and time. Only Cancelled is
  // ignored here, NOT every terminal status: a completed visit still blocks an
  // identical re-booking at the same minute.
  if (check.duplicate_id) {
    return conflict(
      `An identical appointment already exists: ${check.duplicate_id}.`,
      { reason: 'duplicate_appointment', conflictsWith: check.duplicate_id }
    );
  }

  return null;
}

/**
 * :610 — three things stop a delete, and none of them is a foreign key:
 *
 *   a linked job card   the appointment is part of a work record
 *   Completed          service history, kept permanently
 *   In Progress        "finish or cancel it before deleting"
 *
 * job_card_id is ON DELETE SET NULL, so the database would happily allow the
 * delete; the rule exists only in the app and therefore only here.
 */
async function beforeDelete(env, id) {
  const row = await env.DB.prepare(
    'SELECT job_card_id, status FROM appointments WHERE id = ?1'
  ).bind(id).first();
  if (!row) return null;                       // the DELETE reports the 404

  if (row.job_card_id) {
    return conflict(
      `This appointment is linked to job card ${row.job_card_id} and is kept permanently.`,
      { reason: 'linked_to_job_card', jobCardId: row.job_card_id }
    );
  }
  if (row.status === 'Completed') {
    return conflict('A completed appointment is part of your service history.',
      { reason: 'appointment_completed', status: row.status });
  }
  if (row.status === 'In Progress') {
    return conflict('Finish or cancel the appointment before deleting it.',
      { reason: 'appointment_in_progress', status: row.status });
  }
  return null;
}

const routes = collectionRoutes({
  table: 'appointments',
  columns: COLUMNS,
  toRecord,
  singular: 'appointment',
  plural: 'appointments',
});

const writes = collectionWrite({
  table: 'appointments',
  columns: COLUMNS,
  toRecord,
  singular: 'appointment',
  plural: 'appointments',
  collection: 'appointments',
  readFields,
  beforeWrite,
  beforeDelete,
});

export const listAppointments = routes.list;
export const getAppointment = routes.detail;
export const createAppointment = writes.create;
export const updateAppointment = writes.update;
export const deleteAppointment = writes.remove;
