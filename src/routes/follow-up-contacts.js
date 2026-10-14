/* ============================================================
   routes/follow-up-contacts.js — follow-up contact history (0005)
   ------------------------------------------------------------
   GET  /api/follow-up-contacts[/:id]
   POST /api/follow-up-contacts/:id/void

   The contact history is append-only. A contact is recorded through
   POST /api/follow-ups/:id/contact (routes/follow-ups.js); here it is
   only read, or voided. There is no create, PUT or DELETE on this
   collection, so the router answers 405 for all three.

   Voiding keeps the row -- outcome, note and time untouched -- and
   moves only its status to Void, with the reason, the time and an
   optional name. In the same batch the follow-up's last_contact_at /
   last_outcome are recomputed from the contacts still Active, so the
   previous valid contact counts again. Nothing else on the follow-up
   changes: in particular its due date stays where it is.

   A contact can be voided whatever the follow-up's status, because
   correcting the record of a closed follow-up is still a correction.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';
import {
  ok, fail, methodNotAllowed, noDatabase, readRecordId, conflict, unprocessable,
} from '../lib/http.js';
import { readJsonBody, readString, nowIso, constraintFailure } from '../lib/write.js';
import {
  CONTACT_COLUMNS, toContact, toFollowUp, unknownKeys, LATEST_ACTIVE, LIMITS,
} from './follow-ups.js';

const ACTIVE = 'Active';
const VOID = 'Void';

const routes = collectionRoutes({
  table: 'follow_up_contacts',
  columns: CONTACT_COLUMNS,
  toRecord: toContact,
  singular: 'follow-up contact',
  plural: 'follow-up contacts',
});

export const listFollowUpContacts = routes.list;
export const getFollowUpContact = routes.detail;

const FOLLOW_UP_COLUMNS = `
  id, customer_id, vehicle_id, reason, notes, priority, due_date, status,
  last_contact_at, last_outcome, closed_at, close_note, created_at, updated_at
`;

/**
 * POST /api/follow-up-contacts/:id/void
 *
 * Body: `reason` (required) and `voidedBy` (optional free text). Voiding an
 * already-Void contact is a 409 contact_void -- the existing convention for a
 * repeated reversal (invoice-adjustments: adjustment_void).
 */
export async function voidFollowUpContact(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = unknownKeys(b, ['reason', 'voidedBy']);
  const reason = readString(b, 'reason', { required: true, max: LIMITS.voidReason });
  if (reason.error) errors.reason = reason.error;
  const voidedBy = readString(b, 'voidedBy', { max: LIMITS.name });
  if (voidedBy.error) errors.voidedBy = voidedBy.error;
  if (Object.keys(errors).length) {
    return unprocessable('Some void fields are not valid.', errors);
  }

  try {
    const contact = await env.DB.prepare(
      `SELECT id, follow_up_id, status, voided_at FROM follow_up_contacts WHERE id = ?1 LIMIT 1`
    ).bind(id.value).first();
    if (!contact) return fail('not_found', 'No follow-up contact with that id.', 404);
    if (contact.status === VOID) {
      return conflict('This contact is already voided.',
        { reason: 'contact_void', voidedAt: contact.voided_at });
    }

    const at = nowIso();
    const results = await env.DB.batch([
      // THE GATE: only an Active contact moves, so two concurrent voids
      // cannot both apply.
      env.DB.prepare(
        `UPDATE follow_up_contacts
            SET status = '${VOID}', void_reason = ?2, voided_at = ?3, voided_by = ?4
          WHERE id = ?1 AND status = '${ACTIVE}'`
      ).bind(id.value, reason.value, at, voidedBy.value || null),
      // Only the cache moves, and only if THIS request's void landed.
      env.DB.prepare(
        `UPDATE follow_ups
            SET last_contact_at = ${LATEST_ACTIVE('contacted_at')},
                last_outcome    = ${LATEST_ACTIVE('outcome')},
                updated_at      = ?2
          WHERE id = ?1
            AND EXISTS (SELECT 1 FROM follow_up_contacts
                         WHERE id = ?3 AND status = '${VOID}' AND voided_at = ?2)`
      ).bind(contact.follow_up_id, at, id.value),
    ]);

    if ((results[0]?.meta?.changes ?? 0) !== 1) {
      return conflict('This contact was voided by another request.', { reason: 'contact_void' });
    }

    const row = await env.DB.prepare(
      `SELECT ${CONTACT_COLUMNS} FROM follow_up_contacts WHERE id = ?1 LIMIT 1`
    ).bind(id.value).first();
    const followUp = await env.DB.prepare(
      `SELECT ${FOLLOW_UP_COLUMNS} FROM follow_ups WHERE id = ?1 LIMIT 1`
    ).bind(contact.follow_up_id).first();
    if (!row || !followUp) {
      console.error(`Voided contact ${id.value} could not be read back.`);
      return fail('database_error', 'Could not read the contact back.', 500);
    }
    return ok(toContact(row), { followUp: toFollowUp(followUp) });
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/follow-up-contacts/:id/void failed:', err);
    return fail('database_error', 'Could not void the contact.', 500);
  }
}
