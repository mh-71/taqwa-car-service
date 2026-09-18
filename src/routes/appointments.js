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

const routes = collectionRoutes({
  table: 'appointments',
  columns: COLUMNS,
  toRecord,
  singular: 'appointment',
  plural: 'appointments',
});

export const listAppointments = routes.list;
export const getAppointment = routes.detail;
