/* ============================================================
   collection-write.js — shared POST/PUT/DELETE for a D1 table
   ------------------------------------------------------------
   The write half of collection.js, and deliberately the same shape:
   it owns the control flow that was identical for all six simple
   entities -- method checks, body parsing, id allocation,
   timestamps, the SET clause of a merge, not-found, constraint
   mapping, response envelopes -- and nothing else.

   Everything an entity does differently stays in that entity's own
   route module, passed in as three optional hooks:

     readFields(body, mode)  which columns this table accepts, and
                             what each one must look like
     beforeWrite(env, ...)   a rule the database cannot express
                             (the app-level uniqueness checks)
     beforeDelete(env, ...)  a delete rule beyond the schema's
                             foreign keys (parts' stock, expenses'
                             Void-only)

   So a reader looking for "why can't I delete this part" finds it
   in parts.js, not here. That is the whole point of the split.

   WHAT THIS IS NOT: not an ORM, not a schema DSL, not a repository,
   not a rule engine. There is no expression language and nothing is
   generated; a hook is an ordinary async function that returns a
   Response to stop the write, or null to let it through.

   ---- merge semantics ----

   PUT merges, matching Storage.updateData() (storage.js:71-78): a
   field that is absent from the body is left alone, a field that is
   present is written, and updated_at is refreshed either way. Full
   replacement would silently blank every column a form did not
   send, which is not how any caller in this app behaves.

   ---- one statement per operation ----

   INSERT and UPDATE both use RETURNING, so a create or an update
   costs exactly one round trip and the row that comes back is the
   row that was written -- no second SELECT, and no window in which
   another writer could change what we report. DELETE uses
   meta.changes to tell "removed" from "was not there".
   ============================================================ */

import { ok, fail, methodNotAllowed, noDatabase, readRecordId, unprocessable } from './http.js';
import { readJsonBody, allocateId, nowIso, constraintFailure } from './write.js';

/**
 * Collects one entity's fields into { values, errors }.
 *
 * `values` is keyed by COLUMN name, ready to bind. `mode` decides what an
 * absent key means: on 'create' the primitive's own fallback applies, on
 * 'update' the field is skipped entirely so the stored value survives the
 * merge.
 */
export function fieldSet(body, mode) {
  const values = {};
  const errors = {};
  return {
    values,
    errors,
    get ok() { return Object.keys(errors).length === 0; },
    get touched() { return Object.keys(values).length > 0; },
    /**
     * @param column  the D1 column to write
     * @param key     the camelCase key callers send
     * @param result  { value } | { error } from a src/lib/write.js primitive
     */
    take(column, key, result) {
      if (mode === 'update' && body[key] === undefined) return;   // merge: untouched
      if (result.error) { errors[key] = result.error; return; }
      values[column] = result.value;
    },
    /** Record a rule the primitives cannot express (a regex, a cross-field check). */
    reject(key, message) { errors[key] = message; },
  };
}

/**
 * Build create/update/remove handlers for one table.
 *
 * @param {object}   spec
 * @param {string}   spec.table       D1 table name. Never taken from a request.
 * @param {string}   spec.columns     Explicit column list, reused for RETURNING.
 * @param {Function} spec.toRecord    row -> the record shape the UI expects.
 * @param {string}   spec.singular    e.g. 'customer' — used in messages.
 * @param {string}   spec.plural      e.g. 'customers' — used in messages.
 * @param {string}   spec.collection  id_counters key, e.g. 'customers'.
 * @param {Function} spec.readFields  (body, mode) -> fieldSet
 * @param {Function} [spec.beforeWrite]  async (env, values, ctx) -> Response|null
 * @param {Function} [spec.beforeDelete] async (env, id) -> Response|null
 * @param {Function} [spec.deleteStatements] (env, id) -> D1 statements, for a
 *                   delete that must remove more than the row itself.
 */
export function collectionWrite({
  table, columns, toRecord, singular, plural, collection,
  readFields, beforeWrite = null, beforeDelete = null, deleteStatements = null,
}) {
  /** Shared preamble: method, binding, body, fields. */
  async function readBody(request, env, method, mode) {
    if (request.method !== method) return { stop: methodNotAllowed([method]) };
    if (!env.DB) return { stop: noDatabase() };

    const body = await readJsonBody(request);
    if (body.error) return { stop: fail('invalid_body', body.error, 400) };

    const fields = readFields(body.value, mode);
    if (!fields.ok) {
      return { stop: unprocessable(`Some ${singular} fields are not valid.`, fields.errors) };
    }
    return { fields };
  }

  /** POST /api/<plural> */
  async function create(request, env) {
    const read = await readBody(request, env, 'POST', 'create');
    if (read.stop) return read.stop;
    const { values } = read.fields;

    if (beforeWrite) {
      const stop = await beforeWrite(env, values, { mode: 'create', id: null });
      if (stop) return stop;
    }

    // Allocated before the insert, so a failed insert leaves a gap in the
    // sequence rather than reusing a number. storage.js's generateId() has
    // always behaved this way; see allocateId()'s note.
    const allocated = await allocateId(env, collection);
    if (allocated.error) {
      console.error(`POST /api/${plural} could not allocate an id:`, allocated.error);
      return fail('database_error', `Could not create the ${singular}.`, 500);
    }

    values.id = allocated.id;
    values.created_at = nowIso();

    const names = Object.keys(values);
    const holes = names.map((_, i) => `?${i + 1}`).join(', ');

    try {
      const row = await env.DB.prepare(
        `INSERT INTO ${table} (${names.join(', ')})
              VALUES (${holes})
           RETURNING ${columns}`
      )
        .bind(...names.map((n) => values[n]))
        .first();

      return ok(toRecord(row), {}, 201);
    } catch (err) {
      const mapped = constraintFailure(err);
      if (mapped) return mapped;
      console.error(`POST /api/${plural} failed:`, err);
      return fail('database_error', `Could not create the ${singular}.`, 500);
    }
  }

  /** PUT /api/<plural>/:id — merge, not replace. */
  async function update(request, env, rawId) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    if (!env.DB) return noDatabase();

    const id = readRecordId(rawId);
    if (id.error) return fail('invalid_id', id.error, 400);

    const read = await readBody(request, env, 'PUT', 'update');
    if (read.stop) return read.stop;
    const { values, touched } = read.fields;

    // An empty merge would only touch updated_at, which no caller means to do.
    if (!touched) {
      return unprocessable(`No ${singular} fields were supplied to update.`);
    }

    if (beforeWrite) {
      const stop = await beforeWrite(env, values, { mode: 'update', id: id.value });
      if (stop) return stop;
    }

    const names = Object.keys(values);
    const assignments = names.map((n, i) => `${n} = ?${i + 1}`);
    assignments.push(`updated_at = ?${names.length + 1}`);
    const binds = [...names.map((n) => values[n]), nowIso(), id.value];

    try {
      const row = await env.DB.prepare(
        `UPDATE ${table}
            SET ${assignments.join(', ')}
          WHERE id = ?${binds.length}
      RETURNING ${columns}`
      )
        .bind(...binds)
        .first();

      // No row came back, so the id matched nothing. Same 404 the read route
      // gives for an id that is well formed but does not exist.
      if (!row) return fail('not_found', `No ${singular} with that id.`, 404);

      return ok(toRecord(row));
    } catch (err) {
      const mapped = constraintFailure(err);
      if (mapped) return mapped;
      console.error(`PUT /api/${plural}/:id failed:`, err);
      return fail('database_error', `Could not update the ${singular}.`, 500);
    }
  }

  /** DELETE /api/<plural>/:id */
  async function remove(request, env, rawId) {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    if (!env.DB) return noDatabase();

    const id = readRecordId(rawId);
    if (id.error) return fail('invalid_id', id.error, 400);

    // A guard that needs the row itself reads it here; the schema's foreign
    // keys are NOT re-checked, they are left to raise and mapped to 409.
    if (beforeDelete) {
      const stop = await beforeDelete(env, id.value);
      if (stop) return stop;
    }

    try {
      if (deleteStatements) {
        // More than the row itself has to go. One batch, so either the whole
        // removal happens or none of it does.
        const statements = deleteStatements(env, id.value);
        const results = await env.DB.batch(statements);
        const removed = results[results.length - 1];
        if (!removed.meta || removed.meta.changes === 0) {
          return fail('not_found', `No ${singular} with that id.`, 404);
        }
      } else {
        const res = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?1`)
          .bind(id.value)
          .run();
        if (!res.meta || res.meta.changes === 0) {
          return fail('not_found', `No ${singular} with that id.`, 404);
        }
      }

      return ok({ id: id.value, deleted: true });
    } catch (err) {
      // A RESTRICT foreign key firing here IS the delete guard: something
      // still references this row. That is a 409, not a 500.
      const mapped = constraintFailure(err);
      if (mapped) return mapped;
      console.error(`DELETE /api/${plural}/:id failed:`, err);
      return fail('database_error', `Could not delete the ${singular}.`, 500);
    }
  }

  return { create, update, remove };
}
