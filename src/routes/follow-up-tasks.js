/* ============================================================
   routes/follow-up-tasks.js — Customer CRM › Follow-up Tasks (0006)
   ------------------------------------------------------------
   GET  /api/follow-up-tasks[/:id]
   POST /api/follow-up-tasks
   PUT  /api/follow-up-tasks/:id
   POST /api/follow-up-tasks/:id/start
   POST /api/follow-up-tasks/:id/complete
   POST /api/follow-up-tasks/:id/cancel

   A task is a piece of workshop work: a title, an optional
   customer / vehicle / job card it is about, an optional mechanic it
   is assigned to, a priority and a due date. There is no DELETE: a
   task created by mistake is cancelled with a reason and kept.

   ---- the rules this route owns ----

   1. STRICT FIELDS. Every write names the keys it accepts; any other
      key is a 422, so a caller can never set a status, a timestamp or
      an id directly.

   2. ONE SUBMISSION, ONE ROW. A create requires `idempotencyKey` and
      stores a fingerprint of its normalised payload, exactly as
      follow-ups do (routes/follow-ups.js): same key + same payload is a
      200 replay of the same task, same key + other payload is a 409.

   3. REFERENCES AGREE, CHECKED IN THE WRITE. A vehicle or job card needs
      a customer; the vehicle must be that customer's; a job card must be
      that customer's and, when a vehicle is set, that vehicle's. A newly
      chosen customer, vehicle or mechanic must be Active. All of this is
      in the INSERT / UPDATE's own WHERE, so a request that loses a race
      writes nothing; only then is the refusal explained.

   4. STATUS MOVES ONLY FORWARD, THROUGH ACTIONS.
        Pending -> In Progress           (start)
        Pending | In Progress -> Completed  (complete)
        Pending | In Progress -> Cancelled  (cancel, reason required)
      Completed and Cancelled are final. Each action's UPDATE carries the
      statuses it may leave in its WHERE; anything else is a 409 that says
      what the task is now, which is how a repeated click learns it
      already happened.

   5. NO LOST EDITS. An edit may send `expectedUpdatedAt` (the version it
      was made from); the UPDATE is conditional on the row still being
      that version, so two people editing at once cannot silently
      overwrite each other.
   ============================================================ */

import { collectionRoutes } from '../lib/collection.js';
import {
  ok, fail, methodNotAllowed, noDatabase, readRecordId, conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readOptionalBody, readString, readEnum, readDate,
  nowIso, allocateId, constraintFailure,
} from '../lib/write.js';
import { readIdempotencyKey, fingerprint } from './follow-ups.js';

export const PENDING = 'Pending';
export const IN_PROGRESS = 'In Progress';
const COMPLETED = 'Completed';
const CANCELLED = 'Cancelled';
const OPEN = [PENDING, IN_PROGRESS];
const ACTIVE = 'Active';
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/* Field limits. The schema's CHECKs (0006) and the page's own validation use
   the same numbers. */
export const LIMITS = { title: 150, description: 2000, note: 500, reason: 500, name: 100 };

/* ---------------------------------------------------------------
   Records
   --------------------------------------------------------------- */

// The idempotency columns are internal and never leave the Worker.
const COLUMNS = `
  id, title, description, customer_id, vehicle_id, job_card_id, assigned_to,
  priority, due_date, status, started_at, completed_at, completion_note,
  cancelled_at, cancel_reason, created_by, updated_by, created_at, updated_at
`;

/** One D1 row -> the record shape the UI reads. */
export function toTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    customerId: row.customer_id ?? null,
    vehicleId: row.vehicle_id ?? null,
    jobCardId: row.job_card_id ?? null,
    assignedTo: row.assigned_to ?? null,
    priority: row.priority,           // low | medium | high | urgent
    dueDate: row.due_date,            // workshop calendar day, verbatim
    status: row.status,               // Pending | In Progress | Completed | Cancelled
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    completionNote: row.completion_note ?? '',
    cancelledAt: row.cancelled_at ?? null,
    cancelReason: row.cancel_reason ?? '',
    createdBy: row.created_by ?? '',
    updatedBy: row.updated_by ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const routes = collectionRoutes({
  table: 'follow_up_tasks',
  columns: COLUMNS,
  toRecord: toTask,
  singular: 'task',
  plural: 'follow-up-tasks',
});

export const listFollowUpTasks = routes.list;
export const getFollowUpTask = routes.detail;

/* ---------------------------------------------------------------
   Field readers
   --------------------------------------------------------------- */

/** Keys the server owns, refused by name with where the value comes from. */
const SERVER_OWNED = {
  id: '`id` is allocated by the server.',
  status: '`status` is set by the server. Use the start, complete or cancel operation.',
  startedAt: '`startedAt` is set by the start operation.',
  completedAt: '`completedAt` is set by the complete operation.',
  completionNote: '`completionNote` is set by the complete operation.',
  cancelledAt: '`cancelledAt` is set by the cancel operation.',
  cancelReason: '`cancelReason` is set by the cancel operation.',
  createdAt: '`createdAt` is set by the server.',
  updatedAt: '`updatedAt` is set by the server.',
  idempotencyFingerprint: '`idempotencyFingerprint` is calculated by the server.',
};

function unknownKeys(body, allowed) {
  const errors = {};
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors[key] = SERVER_OWNED[key] || `\`${key}\` is not accepted here.`;
  }
  return errors;
}

/** An optional record id: absent -> undefined (not sent), '' / null -> null. */
function readRef(body, field) {
  const raw = body[field];
  if (raw === undefined) return { value: undefined };
  if (raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string') return { error: `\`${field}\` must be a record id or null.` };
  const id = readRecordId(raw.trim());
  return id.error ? { error: `\`${field}\`: ${id.error}` } : { value: id.value };
}

/** Optional text: trimmed, '' stored as NULL. */
function readText(body, field, max) {
  const r = readString(body, field, { max });
  return r.error ? r : { value: r.value === '' ? null : r.value };
}

/** The references must agree in shape before the database is asked. */
function shapeErrors(refs) {
  const e = {};
  if (refs.vehicle_id && !refs.customer_id) e.vehicleId = 'Choose the customer before choosing a vehicle.';
  if (refs.job_card_id && !refs.customer_id) e.jobCardId = 'Choose the customer before choosing a job card.';
  return e;
}

/* ---------------------------------------------------------------
   Reference guard (SQL) and its explanation
   --------------------------------------------------------------- */

/**
 * The WHERE clause that makes a write conditional on its references agreeing.
 * `p` maps customer / vehicle / job / mechanic to placeholder numbers; `fresh`
 * says which references are newly chosen and must therefore be Active (one that
 * is merely kept may have been deactivated since, and stays).
 */
function referenceGuard(p, fresh) {
  const active = (name) => (fresh[name] ? ` AND status = '${ACTIVE}'` : '');
  return `
    (?${p.c} IS NULL OR EXISTS (SELECT 1 FROM customers WHERE id = ?${p.c}${active('customer')}))
    AND (?${p.v} IS NULL OR EXISTS (SELECT 1 FROM vehicles WHERE id = ?${p.v} AND customer_id = ?${p.c}${active('vehicle')}))
    AND (?${p.j} IS NULL OR EXISTS (SELECT 1 FROM job_cards WHERE id = ?${p.j} AND customer_id = ?${p.c}
                                     AND (?${p.v} IS NULL OR vehicle_id = ?${p.v})))
    AND (?${p.m} IS NULL OR EXISTS (SELECT 1 FROM mechanics WHERE id = ?${p.m}${active('mechanic')}))`;
}

const fieldError = (field, message) => unprocessable('Some task fields are not valid.', { [field]: message });

/** Why a set of references cannot take a task, or null if it can. */
async function explainReferences(env, refs, fresh) {
  const row = await env.DB.prepare(
    `SELECT (SELECT status FROM customers WHERE id = ?1)          AS customer_status,
            (SELECT customer_id FROM vehicles WHERE id = ?2)      AS vehicle_owner,
            (SELECT status FROM vehicles WHERE id = ?2)           AS vehicle_status,
            (SELECT customer_id FROM job_cards WHERE id = ?3)     AS job_customer,
            (SELECT vehicle_id FROM job_cards WHERE id = ?3)      AS job_vehicle,
            (SELECT status FROM mechanics WHERE id = ?4)          AS mechanic_status`
  ).bind(refs.customer_id ?? null, refs.vehicle_id ?? null, refs.job_card_id ?? null, refs.assigned_to ?? null).first();
  if (refs.customer_id) {
    if (!row || row.customer_status === null) return conflict('That customer does not exist.', { reason: 'customer_not_found' });
    if (fresh.customer && row.customer_status !== ACTIVE) {
      return conflict('That customer is Inactive. Reactivate the customer or choose another.', { reason: 'customer_inactive' });
    }
  }
  if (refs.vehicle_id) {
    if (row.vehicle_owner === null) return conflict('That vehicle does not exist.', { reason: 'vehicle_not_found' });
    if (row.vehicle_owner !== refs.customer_id) return fieldError('vehicleId', 'The selected vehicle does not belong to this customer.');
    if (fresh.vehicle && row.vehicle_status !== ACTIVE) {
      return conflict('That vehicle is Inactive. Choose an active vehicle or none.', { reason: 'vehicle_inactive' });
    }
  }
  if (refs.job_card_id) {
    if (row.job_customer === null) return conflict('That job card does not exist.', { reason: 'job_card_not_found' });
    if (row.job_customer !== refs.customer_id) return fieldError('jobCardId', 'The selected job card belongs to another customer.');
    if (refs.vehicle_id && row.job_vehicle !== refs.vehicle_id) return fieldError('jobCardId', 'The selected job card is for another vehicle.');
  }
  if (refs.assigned_to) {
    if (row.mechanic_status === null) return conflict('That staff member does not exist.', { reason: 'staff_not_found' });
    if (fresh.mechanic && row.mechanic_status !== ACTIVE) {
      return conflict('That staff member is Inactive. Assign the task to someone active.', { reason: 'staff_inactive' });
    }
  }
  return null;
}

async function readTaskRow(env, id) {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM follow_up_tasks WHERE id = ?1 LIMIT 1`).bind(id).first();
}

const closedConflict = (row) => conflict(
  `This task is already ${row.status}. A ${row.status.toLowerCase()} task cannot be changed; create a new task if more work is needed.`,
  { reason: 'task_closed', currentStatus: row.status },
);

/* ---------------------------------------------------------------
   POST /api/follow-up-tasks
   --------------------------------------------------------------- */

const CREATE_FIELDS = ['title', 'description', 'customerId', 'vehicleId', 'jobCardId', 'assignedTo',
  'priority', 'dueDate', 'createdBy', 'idempotencyKey'];

/** The stored replay of a create, or the refusal for a reused key; null if the key is new. */
async function replayCreate(env, key, fp) {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS}, idempotency_fingerprint FROM follow_up_tasks WHERE idempotency_key = ?1 LIMIT 1`
  ).bind(key).first();
  if (!row) return null;
  if (row.idempotency_fingerprint !== fp) {
    return conflict('This submission key was already used for a different task. Start a new submission.',
      { reason: 'idempotency_key_reused' });
  }
  return ok(toTask(row), { replayed: true }, 200);
}

export async function createFollowUpTask(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = unknownKeys(b, CREATE_FIELDS);
  const title = readString(b, 'title', { required: true, max: LIMITS.title });
  if (title.error) errors.title = title.error;
  const description = readText(b, 'description', LIMITS.description);
  if (description.error) errors.description = description.error;
  const refs = {};
  for (const [field, col] of [['customerId', 'customer_id'], ['vehicleId', 'vehicle_id'], ['jobCardId', 'job_card_id'], ['assignedTo', 'assigned_to']]) {
    const r = readRef(b, field);
    if (r.error) errors[field] = r.error; else refs[col] = r.value ?? null;
  }
  const priority = readEnum(b, 'priority', PRIORITIES, { fallback: 'medium' });
  if (priority.error) errors.priority = priority.error;
  const dueDate = readDate(b, 'dueDate', { required: true });
  if (dueDate.error) errors.dueDate = dueDate.error;
  const createdBy = readText(b, 'createdBy', LIMITS.name);
  if (createdBy.error) errors.createdBy = createdBy.error;
  const key = readIdempotencyKey(b);
  if (key.error) errors.idempotencyKey = key.error;
  Object.assign(errors, shapeErrors(refs));

  if (Object.keys(errors).length) return unprocessable('Some task fields are not valid.', errors);

  const fp = await fingerprint([
    'follow_up_task.create.v1', title.value, description.value, refs.customer_id, refs.vehicle_id,
    refs.job_card_id, refs.assigned_to, priority.value, dueDate.value, createdBy.value,
  ]);
  const fresh = { customer: true, vehicle: true, mechanic: true };

  try {
    // A retry finds its own row before anything else is checked.
    const replay = await replayCreate(env, key.value, fp);
    if (replay) return replay;

    const allocated = await allocateId(env, 'followUpTasks');
    if (allocated.error) {
      console.error('POST /api/follow-up-tasks could not allocate an id:', allocated.error);
      return fail('database_error', 'Could not create the task.', 500);
    }
    const at = nowIso();

    // ?1 id ?2 title ?3 description ?4 customer ?5 vehicle ?6 job card ?7 mechanic
    // ?8 priority ?9 due ?10 created_by ?11 key ?12 fingerprint ?13 now
    const row = await env.DB.prepare(
      `INSERT INTO follow_up_tasks
         (id, title, description, customer_id, vehicle_id, job_card_id, assigned_to, priority, due_date,
          status, created_by, idempotency_key, idempotency_fingerprint, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '${PENDING}', ?10, ?11, ?12, ?13, ?13
        WHERE ${referenceGuard({ c: 4, v: 5, j: 6, m: 7 }, fresh)}
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`
    ).bind(
      allocated.id, title.value, description.value, refs.customer_id, refs.vehicle_id, refs.job_card_id,
      refs.assigned_to, priority.value, dueDate.value, createdBy.value, key.value, fp, at,
    ).first();

    if (row) return ok(toTask(row), {}, 201);

    // Nothing was inserted: a concurrent request with the same key won, or a
    // reference was refused.
    const raced = await replayCreate(env, key.value, fp);
    if (raced) return raced;
    const refusal = await explainReferences(env, refs, fresh);
    if (refusal) return refusal;
    return conflict('A customer, vehicle, job card or staff member was changed by another request. Reload and try again.',
      { reason: 'concurrent_modification' });
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/follow-up-tasks failed:', err);
    return fail('database_error', 'Could not create the task.', 500);
  }
}

/* ---------------------------------------------------------------
   PUT /api/follow-up-tasks/:id
   --------------------------------------------------------------- */

const UPDATE_FIELDS = ['title', 'description', 'customerId', 'vehicleId', 'jobCardId', 'assignedTo',
  'priority', 'dueDate', 'updatedBy', 'expectedUpdatedAt'];

/**
 * Merge the permitted fields into an open task (Pending or In Progress). The
 * merged references must agree; a newly chosen customer, vehicle or mechanic
 * must be Active. Status is never changed here.
 */
export async function updateFollowUpTask(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = unknownKeys(b, UPDATE_FIELDS);
  if (b.idempotencyKey !== undefined) errors.idempotencyKey = '`idempotencyKey` is only used when creating a task.';
  if (b.createdBy !== undefined) errors.createdBy = '`createdBy` is recorded when the task is created.';
  const values = {};
  if (b.title !== undefined) {
    const v = readString(b, 'title', { required: true, max: LIMITS.title });
    if (v.error) errors.title = v.error; else values.title = v.value;
  }
  if (b.description !== undefined) {
    const v = readText(b, 'description', LIMITS.description);
    if (v.error) errors.description = v.error; else values.description = v.value;
  }
  for (const [field, col] of [['customerId', 'customer_id'], ['vehicleId', 'vehicle_id'], ['jobCardId', 'job_card_id'], ['assignedTo', 'assigned_to']]) {
    const r = readRef(b, field);
    if (r.error) errors[field] = r.error; else if (r.value !== undefined) values[col] = r.value;
  }
  if (b.priority !== undefined) {
    const v = readEnum(b, 'priority', PRIORITIES, { required: true });
    if (v.error) errors.priority = v.error; else values.priority = v.value;
  }
  if (b.dueDate !== undefined) {
    const v = readDate(b, 'dueDate', { required: true });
    if (v.error) errors.dueDate = v.error; else values.due_date = v.value;
  }
  const updatedBy = readText(b, 'updatedBy', LIMITS.name);
  if (updatedBy.error) errors.updatedBy = updatedBy.error;
  let expected = null;
  if (b.expectedUpdatedAt !== undefined && b.expectedUpdatedAt !== null && b.expectedUpdatedAt !== '') {
    if (typeof b.expectedUpdatedAt !== 'string' || b.expectedUpdatedAt.length > 40) {
      errors.expectedUpdatedAt = '`expectedUpdatedAt` must be the updatedAt value the edit was made from.';
    } else expected = b.expectedUpdatedAt;
  }
  if (Object.keys(errors).length) return unprocessable('Some task fields are not valid.', errors);
  if (!Object.keys(values).length) return unprocessable('No task fields were supplied to update.');

  try {
    const current = await readTaskRow(env, id.value);
    if (!current) return fail('not_found', 'No task with that id.', 404);
    if (!OPEN.includes(current.status)) return closedConflict(current);
    if (expected !== null && expected !== current.updated_at) {
      return conflict('This task was changed by someone else after you opened it. Reload it and try again.',
        { reason: 'concurrent_modification' });
    }

    const merged = {};
    for (const col of ['customer_id', 'vehicle_id', 'job_card_id', 'assigned_to']) {
      merged[col] = col in values ? values[col] : current[col];
    }
    const shape = shapeErrors(merged);
    if (Object.keys(shape).length) return unprocessable('Some task fields are not valid.', shape);
    const fresh = {
      customer: merged.customer_id !== current.customer_id,
      vehicle: merged.vehicle_id !== current.vehicle_id,
      mechanic: merged.assigned_to !== current.assigned_to,
    };

    const at = nowIso();
    const names = Object.keys(values);
    const binds = names.map((n) => values[n]);
    const assignments = names.map((n, i) => `${n} = ?${i + 1}`);
    assignments.push(`updated_at = ?${binds.push(at)}`);
    assignments.push(`updated_by = ?${binds.push(updatedBy.value)}`);
    const pId = binds.push(id.value);
    const pStatus = binds.push(current.status);
    const pVer = binds.push(current.updated_at);
    const p = {
      c: binds.push(merged.customer_id), v: binds.push(merged.vehicle_id),
      j: binds.push(merged.job_card_id), m: binds.push(merged.assigned_to),
    };

    const row = await env.DB.prepare(
      `UPDATE follow_up_tasks
          SET ${assignments.join(', ')}
        WHERE id = ?${pId} AND status = ?${pStatus} AND updated_at = ?${pVer}
          AND ${referenceGuard(p, fresh)}
    RETURNING ${COLUMNS}`
    ).bind(...binds).first();
    if (row) return ok(toTask(row));

    const now = await readTaskRow(env, id.value);
    if (!now) return fail('not_found', 'No task with that id.', 404);
    if (!OPEN.includes(now.status)) return closedConflict(now);
    if (now.updated_at !== current.updated_at) {
      return conflict('This task was changed by another request. Reload it and try again.',
        { reason: 'concurrent_modification' });
    }
    const refusal = await explainReferences(env, merged, fresh);
    if (refusal) return refusal;
    return conflict('A customer, vehicle, job card or staff member was changed by another request. Reload and try again.',
      { reason: 'concurrent_modification' });
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('PUT /api/follow-up-tasks/:id failed:', err);
    return fail('database_error', 'Could not update the task.', 500);
  }
}

/* ---------------------------------------------------------------
   POST /api/follow-up-tasks/:id/start | complete | cancel
   --------------------------------------------------------------- */

/**
 * Move a task from one of `from` to `to`, in one guarded UPDATE. A task that is
 * not in `from` is a 409 naming its current status.
 */
async function transition(env, id, { from, to, sets, binds, label }) {
  try {
    // ?1 new status, ?2 now, ?3.. the action's own values, then the allowed
    // current statuses, then the id.
    const n = binds.list.length;
    const placeholders = from.map((_, i) => `?${n + 3 + i}`).join(', ');
    const row = await env.DB.prepare(
      `UPDATE follow_up_tasks
          SET status = ?1, updated_at = ?2${sets}
        WHERE id = ?${n + 3 + from.length} AND status IN (${placeholders})
    RETURNING ${COLUMNS}`
    ).bind(to, binds.at, ...binds.list, ...from, id).first();
    if (row) return ok(toTask(row));

    const current = await readTaskRow(env, id);
    if (!current) return fail('not_found', 'No task with that id.', 404);
    if (!OPEN.includes(current.status)) return closedConflict(current);
    return conflict(`This task is ${current.status}; it cannot be ${label} from there.`,
      { reason: 'invalid_transition', currentStatus: current.status });
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error(`POST /api/follow-up-tasks/:id (${label}) failed:`, err);
    return fail('database_error', 'Could not update the task.', 500);
  }
}

/** Read an action body: only `allowed` keys; returns { values } or { response }. */
async function readActionBody(request, allowed, { required = false } = {}) {
  const body = required ? await readJsonBody(request) : await readOptionalBody(request);
  if (body.error) return { response: fail('invalid_body', body.error, 400) };
  const errors = unknownKeys(body.value, allowed);
  return { b: body.value, errors };
}

/** POST /api/follow-up-tasks/:id/start — Pending -> In Progress. Body optional: { by }. */
export async function startFollowUpTask(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();
  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);
  const r = await readActionBody(request, ['by']);
  if (r.response) return r.response;
  const by = readText(r.b, 'by', LIMITS.name);
  if (by.error) r.errors.by = by.error;
  if (Object.keys(r.errors).length) return unprocessable('Some fields are not valid.', r.errors);
  const at = nowIso();
  return transition(env, id.value, {
    from: [PENDING], to: IN_PROGRESS, label: 'started',
    sets: ', started_at = COALESCE(started_at, ?2), updated_by = ?3',
    binds: { at, list: [by.value] },
  });
}

/** POST /api/follow-up-tasks/:id/complete — open -> Completed. Body optional: { note, by }. */
export async function completeFollowUpTask(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();
  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);
  const r = await readActionBody(request, ['note', 'by']);
  if (r.response) return r.response;
  const note = readText(r.b, 'note', LIMITS.note);
  if (note.error) r.errors.note = note.error;
  const by = readText(r.b, 'by', LIMITS.name);
  if (by.error) r.errors.by = by.error;
  if (Object.keys(r.errors).length) return unprocessable('Some completion fields are not valid.', r.errors);
  const at = nowIso();
  return transition(env, id.value, {
    from: OPEN, to: COMPLETED, label: 'completed',
    sets: ', completed_at = ?2, completion_note = ?3, updated_by = ?4',
    binds: { at, list: [note.value, by.value] },
  });
}

/** POST /api/follow-up-tasks/:id/cancel — open -> Cancelled. Body: { reason (required), by }. */
export async function cancelFollowUpTask(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();
  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);
  const r = await readActionBody(request, ['reason', 'by'], { required: true });
  if (r.response) return r.response;
  const reason = readString(r.b, 'reason', { required: true, max: LIMITS.reason });
  if (reason.error) r.errors.reason = reason.error;
  const by = readText(r.b, 'by', LIMITS.name);
  if (by.error) r.errors.by = by.error;
  if (Object.keys(r.errors).length) return unprocessable('Some cancellation fields are not valid.', r.errors);
  const at = nowIso();
  return transition(env, id.value, {
    from: OPEN, to: CANCELLED, label: 'cancelled',
    sets: ', cancelled_at = ?2, cancel_reason = ?3, updated_by = ?4',
    binds: { at, list: [reason.value, by.value] },
  });
}
