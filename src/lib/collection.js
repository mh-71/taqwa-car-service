/* ============================================================
   collection.js — shared list/detail routes for a D1 table
   ------------------------------------------------------------
   Customers, vehicles and services differ only in four things: the
   table, its column list, how a row maps to a record, and the nouns
   used in messages. Everything else — method checks, binding checks,
   limit/offset validation, ordering, counting, error shapes — was
   identical in all three, so it lives here once.

   Deliberately small. It does not try to be an ORM, a query builder
   or a generic CRUD layer; it is the read half of one collection,
   parameterised by the four things that actually vary. Anything a
   collection needs beyond this (filters, joins, writes) belongs in
   that collection's own route module, not here.

   Two invariants every collection inherits:

   1. SQL is a fixed string and every request value goes through
      .bind(). The caller supplies an explicit column list rather
      than SELECT *, so an internal column can never leak.

   2. Ordering is newest first with `id` as the tie-breaker, so
      paging is stable when two records share a created_at.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId,
} from './http.js';

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/**
 * Build the list and detail handlers for one collection.
 *
 * @param {object}   spec
 * @param {string}   spec.table     D1 table name. Never taken from a request.
 * @param {string}   spec.columns   Explicit SELECT list.
 * @param {Function} spec.toRecord  row -> the record shape the UI expects.
 * @param {string}   spec.singular  e.g. 'customer' — used in messages.
 * @param {string}   spec.plural    e.g. 'customers' — used in messages.
 * @returns {{ list: Function, detail: Function }}
 */
export function collectionRoutes({ table, columns, toRecord, singular, plural }) {
  /** GET /api/<plural>?limit=&offset= */
  async function list(request, env, url) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    if (!env.DB) return noDatabase();

    const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
    if (limit.error) return fail('invalid_parameter', limit.error, 400);

    const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
    if (offset.error) return fail('invalid_parameter', offset.error, 400);

    try {
      const { results } = await env.DB.prepare(
        `SELECT ${columns}
           FROM ${table}
          ORDER BY created_at DESC, id DESC
          LIMIT ?1 OFFSET ?2`
      )
        .bind(limit.value, offset.value)
        .all();

      const rows = results ?? [];
      const total = await env.DB.prepare(
        `SELECT count(*) AS n FROM ${table}`
      ).first();

      return ok(rows.map(toRecord), {
        count: rows.length,
        total: total ? total.n : rows.length,
        limit: limit.value,
        offset: offset.value,
      });
    } catch (err) {
      // The client gets a stable code and a plain message; the detail goes
      // to the Worker log, not across the wire.
      console.error(`GET /api/${plural} failed:`, err);
      return fail('database_error', `Could not read ${plural}.`, 500);
    }
  }

  /** GET /api/<plural>/:id */
  async function detail(request, env, rawId) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    if (!env.DB) return noDatabase();

    const id = readRecordId(rawId);
    if (id.error) return fail('invalid_id', id.error, 400);

    try {
      const row = await env.DB.prepare(
        `SELECT ${columns}
           FROM ${table}
          WHERE id = ?1
          LIMIT 1`
      )
        .bind(id.value)
        .first();

      // readRecordId is shape-only, not prefix-specific, so a well-formed id
      // belonging to another collection lands here as a 404, not a 400.
      // The message names no table and confirms nothing about internals.
      if (!row) return fail('not_found', `No ${singular} with that id.`, 404);

      return ok(toRecord(row));
    } catch (err) {
      console.error(`GET /api/${plural}/:id failed:`, err);
      return fail('database_error', `Could not read ${singular}.`, 500);
    }
  }

  return { list, detail };
}
