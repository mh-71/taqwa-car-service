/* ============================================================
   lib/activity.js — the activity log's writer (migration 0012)
   ------------------------------------------------------------
   Records ONE entry after a Staff Management change has SUCCEEDED:

     staff            POST (add)          PUT /:id (edit)
     accounts         POST (create)       PUT /:id (edit)     POST /:id/password
     attendance       POST (record)       PUT /:id (correct)
     leave-requests   POST (submit)       POST /:id/approve   POST /:id/reject

   HOW IT IS SAFE
     * Server-side only. The router wraps those handlers (src/index.js);
       no route accepts an activity record, so nothing outside the Worker
       can write, edit or delete one.
     * Only after success: the handler runs first, untouched; an entry is
       written only for its 200 / 201 answer, built from the record it
       returned. A refused request (401, 403, 404, 409, 422, 5xx) records
       nothing -- so a duplicate submission the route refuses (409) is not
       logged twice.
     * Who is the caller the auth gate authenticated (principalOf), never a
       name the request claims.
     * Never sensitive: no password, hash, token, cookie or request body is
       stored. An edit names the fields it sent (their names, not their
       values); a password change says only that one was set.
     * Never changes the outcome: the business change is already saved
       when the entry is written. If writing the entry fails, the failure
       goes to the Worker log and the caller still gets the original
       answer. The trade-off is documented: in that rare case a change can
       be missing from the log; a change is never undone or refused because
       of the log.
   ============================================================ */

import { principalOf } from './auth.js';
import { nowIso } from './write.js';

// API collection -> the module an entry is filed under.
const MODULES = { staff: 'staff', accounts: 'accounts', attendance: 'attendance', 'leave-requests': 'leave' };

// Body keys that are never named in a summary, whatever the route.
const UNNAMED = new Set(['password', 'expectedUpdatedAt', 'note', 'by']);
const SUMMARY_MAX = 300;

const who = (d) => `${d.staffName || d.name || d.staffId || d.id} (${d.staffId || d.id})`;
const fields = (keys) => (keys && keys.length ? `: ${keys.join(', ')}` : '');

/* One summary per collection and operation, built ONLY from the saved record
   the route returned (and, for an edit, the names of the fields it was sent).
   A missing entry here means the operation is not logged. */
const SUMMARIES = {
  staff: {
    create: (d) => `Added ${d.name} (${d.id})${d.designation ? ` as ${d.designation}` : ''}`,
    update: (d, keys) => `Updated ${d.name} (${d.id})${fields(keys)}`,
  },
  accounts: {
    create: (d) => `Created account ${d.username} for ${who(d)}, role ${d.role}`,
    update: (d, keys) => `Updated account ${d.username} for ${who(d)}${fields(keys)} (now ${d.status}, ${d.role})`,
    password: (d) => `Set a new password for account ${d.username}`,
  },
  attendance: {
    create: (d) => `Recorded ${d.status} for ${who(d)} on ${d.date}`,
    update: (d, keys) => `Corrected the attendance of ${who(d)} on ${d.date}${fields(keys)} (now ${d.status})`,
  },
  'leave-requests': {
    create: (d) => `Submitted ${d.leaveType} leave for ${who(d)}, ${d.startDate} to ${d.endDate}`,
    approve: (d) => `Approved ${d.leaveType} leave ${d.id} for ${who(d)}, ${d.startDate} to ${d.endDate}`,
    reject: (d) => `Rejected ${d.leaveType} leave ${d.id} for ${who(d)}, ${d.startDate} to ${d.endDate}`,
  },
};

/** Is this collection operation one the log records? (op: create | update | an action name) */
export const isLogged = (collection, op) => Object.hasOwn(SUMMARIES, collection) && Object.hasOwn(SUMMARIES[collection], op);

/** The names (never the values) of the fields a JSON body sent, safe ones only. */
async function sentFieldNames(request) {
  try {
    const body = JSON.parse(await request.text());
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
    return Object.keys(body).filter((k) => /^[A-Za-z]{1,40}$/.test(k) && !UNNAMED.has(k)).slice(0, 12);
  } catch {
    return [];
  }
}

/** The caller as the log names them: an account's username and id, or the passphrase / token. */
function actorOf(request) {
  const p = principalOf(request);
  if (!p) return null;
  if (p.kind === 'account') {
    if (typeof p.id !== 'string' || !p.id.startsWith('USR-')) return null;
    return { kind: 'account', accountId: p.id, name: String(p.username || p.id).slice(0, 100) };
  }
  if (p.kind === 'passphrase') return { kind: 'passphrase', accountId: null, name: 'Workshop passphrase' };
  if (p.kind === 'token') return { kind: 'token', accountId: null, name: 'API token' };
  return null;
}

/**
 * Run `respond` (the route, already behind the auth gate) and, if it
 * succeeded, record one entry. Returns the route's own Response unchanged.
 */
export async function withActivity(request, env, collection, op, respond) {
  if (!isLogged(collection, op)) return respond();
  // An edit's body is read before the route consumes it -- for its field names only.
  const keys = op === 'update' ? await sentFieldNames(request.clone()) : null;
  const response = await respond();
  if (response.status !== 200 && response.status !== 201) return response;
  try {
    const actor = actorOf(request);
    if (!actor || !env.DB) return response;
    const body = await response.clone().json();
    const data = body && body.data;
    if (!data || typeof data.id !== 'string' || !data.id) return response;
    const summary = SUMMARIES[collection][op](data, keys).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX);
    await env.DB.prepare(
      `INSERT INTO activity_log (occurred_at, actor_kind, actor_account_id, actor_name, action, module, record_id, summary)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(nowIso(), actor.kind, actor.accountId, actor.name, op, MODULES[collection], data.id.slice(0, 40), summary).run();
  } catch (err) {
    // The change itself is saved; only its log entry is missing. Never turn that into a failure.
    console.error(`activity log: entry not recorded for ${collection} ${op}:`, err && err.message);
  }
  return response;
}
