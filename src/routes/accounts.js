/* ============================================================
   routes/accounts.js — Staff Management › User Accounts
   ------------------------------------------------------------
     GET    /api/accounts                 list (q, status, role, limit, offset)
     GET    /api/accounts/:id             one account
     POST   /api/accounts                 { staffId, username, role, password }
     PUT    /api/accounts/:id             { status } and/or { role }
     POST   /api/accounts/:id/password    { password }  -- set a new password
     (no DELETE: an account is deactivated, never deleted)

   An account is a sign-in for ONE existing staff member -- a mechanic
   (MEC-0001) or any other employee (STF-0001) -- linked by foreign key
   and copying nothing about the person (migration 0009).

   WHO MAY CALL: an administrator -- the workshop passphrase session, the
   machine token, or an account whose role is Administrator. The router's
   gate has already authenticated the caller; this file AUTHORIZES, on
   every route, whatever the page shows or hides.

   WHAT NEVER LEAVES: password hashes, session versions, failed-attempt
   counts. A record says only whether the account is temporarily locked.

   SAFETY RULES
     * One account per staff member; usernames unique ignoring case.
     * Only an ACTIVE staff member can have an account created or
       re-activated; an account whose staff member becomes inactive can no
       longer sign in (the gate checks on every request).
     * Nobody can deactivate their own account or change their own role.
     * An account session cannot deactivate the last active administrator
       account. (The workshop passphrase still signs in, so its holder
       may -- nobody can be locked out.) The check and the change are one
       statement, so two requests at once cannot both pass it.
     * Deactivating an account or setting a new password ends that
       account's sessions everywhere (session_version + 1).
     * Password reset by e-mail does not exist: there is no e-mail
       delivery. An administrator sets a new password instead.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, conflict, unprocessable,
} from '../lib/http.js';
import { readJsonBody, nowIso, allocateId, constraintFailure } from '../lib/write.js';
import { principalOf } from '../lib/auth.js';
import {
  ACCOUNT_ROLES, ACCOUNT_STATUSES, ACCOUNT_ID, normaliseUsername, passwordProblem, hashPassword,
} from '../lib/accounts.js';

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;
const PERSON_ID = /^(MEC|STF)-\d{4,}$/;

const CREATE_KEYS = ['staffId', 'username', 'role', 'password'];
const UPDATE_KEYS = ['status', 'role'];
const PASSWORD_KEYS = ['password'];

/* ---------- authorization ---------- */

/** May this caller manage accounts? Only an administrator. */
function isAdmin(who) {
  if (!who) return false;
  if (who.kind === 'token' || who.kind === 'passphrase') return true;
  return who.kind === 'account' && who.role === 'Administrator';
}

const forbidden = () => fail('forbidden', 'Only an administrator can manage user accounts.', 403);

/* ---------- reading ---------- */

const SELECT = `
  SELECT a.id, a.mechanic_id, a.staff_id, a.username, a.role, a.status, a.last_login_at, a.locked_until,
         a.password_changed_at, a.created_at, a.updated_at,
         COALESCE(m.name, s.name) AS person_name,
         COALESCE(m.status, s.status) AS person_status,
         COALESCE(p.designation, s.designation, CASE WHEN m.id IS NOT NULL THEN 'Mechanic' END) AS designation
    FROM user_accounts a
    LEFT JOIN mechanics m ON m.id = a.mechanic_id
    LEFT JOIN staff p ON p.mechanic_id = a.mechanic_id
    LEFT JOIN staff s ON s.id = a.staff_id`;

/** One row -> what the page may see. Never a hash, a session version or a counter. */
function toRecord(row, who, now = new Date().toISOString()) {
  return {
    id: row.id,
    staffId: row.mechanic_id || row.staff_id,
    isMechanic: Boolean(row.mechanic_id),
    staffName: row.person_name ?? '',
    staffStatus: row.person_status ?? '',
    designation: row.designation ?? '',
    username: row.username,
    role: row.role,
    status: row.status,
    locked: Boolean(row.locked_until && row.locked_until > now),
    lastLoginAt: row.last_login_at ?? '',
    passwordChangedAt: row.password_changed_at ?? '',
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    self: Boolean(who && who.kind === 'account' && who.id === row.id),
  };
}

const findAccount = (env, id) => env.DB.prepare(`${SELECT} WHERE a.id = ?1`).bind(id).first();

function readFilter(url, name, max) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return { value: null };
  if (raw.length > max) return { error: `\`${name}\` must be ${max} characters or fewer.` };
  return { value: raw.trim() };
}

function readAccountId(raw) {
  return typeof raw === 'string' && ACCOUNT_ID.test(raw) ? raw : null;
}

/** Field errors for every key the route does not take (an id, a hash, a session version, ...). */
function unknownKeys(body, allowed) {
  const errors = {};
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors[key] = 'This is not an account field.';
  }
  return errors;
}

/** GET /api/accounts */
export async function listAccounts(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!isAdmin(who)) return forbidden();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const q = readFilter(url, 'q', 100);
  const status = readFilter(url, 'status', 20);
  const role = readFilter(url, 'role', 40);
  for (const f of [q, status, role]) if (f.error) return fail('invalid_parameter', f.error, 400);
  if (status.value !== null && !ACCOUNT_STATUSES.includes(status.value)) {
    return fail('invalid_parameter', '`status` must be Active or Inactive.', 400);
  }
  if (role.value !== null && !ACCOUNT_ROLES.includes(role.value)) {
    return fail('invalid_parameter', `\`role\` must be one of: ${ACCOUNT_ROLES.join(', ')}.`, 400);
  }

  const needle = q.value === null ? null : q.value.toLowerCase();
  const where = `
     WHERE (?1 IS NULL OR a.status = ?1)
       AND (?2 IS NULL OR a.role = ?2)
       AND (?3 IS NULL
            OR instr(lower(COALESCE(m.name, s.name, '')), ?3) > 0
            OR instr(lower(COALESCE(a.mechanic_id, a.staff_id)), ?3) > 0
            OR instr(a.username, ?3) > 0
            OR instr(lower(a.id), ?3) > 0)`;
  try {
    const { results } = await env.DB.prepare(
      `${SELECT} ${where} ORDER BY person_name COLLATE NOCASE, a.id LIMIT ?4 OFFSET ?5`
    ).bind(status.value, role.value, needle, limit.value, offset.value).all();
    const total = await env.DB.prepare(
      `SELECT count(*) AS n FROM user_accounts a
         LEFT JOIN mechanics m ON m.id = a.mechanic_id
         LEFT JOIN staff s ON s.id = a.staff_id ${where}`
    ).bind(status.value, role.value, needle).first();
    const rows = results ?? [];
    return ok(rows.map((r) => toRecord(r, who)), {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
      roles: ACCOUNT_ROLES,
    });
  } catch (err) {
    console.error('GET /api/accounts failed:', err && err.message);
    return fail('database_error', 'Could not read user accounts.', 500);
  }
}

/** GET /api/accounts/:id */
export async function getAccount(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!isAdmin(who)) return forbidden();
  const id = readAccountId(rawId);
  if (!id) return fail('invalid_id', 'That is not an account id.', 400);
  try {
    const row = await findAccount(env, id);
    if (!row) return fail('not_found', 'No account with that id.', 404);
    return ok(toRecord(row, who));
  } catch (err) {
    console.error('GET /api/accounts/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the account.', 500);
  }
}

/* ---------- writing ---------- */

/** The staff member an account would belong to: exists? active? already has an account? */
async function findPerson(env, staffId) {
  const isMechanic = staffId.startsWith('MEC-');
  const person = isMechanic
    ? await env.DB.prepare('SELECT id, name, status FROM mechanics WHERE id = ?1').bind(staffId).first()
    : await env.DB.prepare('SELECT id, name, status FROM staff WHERE id = ?1 AND mechanic_id IS NULL').bind(staffId).first();
  if (!person) return null;
  const existing = await env.DB.prepare(
    `SELECT id FROM user_accounts WHERE ${isMechanic ? 'mechanic_id' : 'staff_id'} = ?1`
  ).bind(staffId).first();
  return { ...person, isMechanic, accountId: existing ? existing.id : null };
}

const duplicateUsername = (id) => conflict('That username is already taken.', {
  field: 'username', fields: { username: 'That username is already taken.' }, ...(id ? { conflictsWith: id } : {}),
});
const duplicatePerson = (id) => conflict('This staff member already has an account.', {
  field: 'staffId', fields: { staffId: `This staff member already has an account${id ? ` (${id})` : ''}.` }, ...(id ? { conflictsWith: id } : {}),
});

/** A unique-constraint error from an insert, named for the form (two requests at once). */
function writeConflict(err) {
  const message = String((err && err.message) || '');
  if (/UNIQUE constraint failed/i.test(message)) {
    if (/username/i.test(message)) return duplicateUsername(null);
    if (/mechanic_id|staff_id/i.test(message)) return duplicatePerson(null);
  }
  return constraintFailure(err);
}

/** POST /api/accounts */
export async function createAccount(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();
  if (!isAdmin(principalOf(request))) return forbidden();

  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;

  const errors = unknownKeys(body, CREATE_KEYS);
  const staffId = typeof body.staffId === 'string' ? body.staffId.trim() : '';
  if (!PERSON_ID.test(staffId)) errors.staffId = 'Choose a staff member.';
  const username = normaliseUsername(body.username);
  if (!username) errors.username = 'Use 3-32 lower-case letters, digits, dots, dashes or underscores.';
  if (!ACCOUNT_ROLES.includes(body.role)) errors.role = `Choose one of: ${ACCOUNT_ROLES.join(', ')}.`;
  const weak = passwordProblem(body.password, username || '');
  if (weak) errors.password = weak;
  if (Object.keys(errors).length) return unprocessable('Some account fields are not valid.', errors);

  try {
    const person = await findPerson(env, staffId);
    if (!person) return unprocessable('Some account fields are not valid.', { staffId: 'No such staff member.' });
    if (person.status !== 'Active') {
      return unprocessable('Some account fields are not valid.', { staffId: 'Only an active staff member can have an account.' });
    }
    if (person.accountId) return duplicatePerson(person.accountId);
    const taken = await env.DB.prepare('SELECT id FROM user_accounts WHERE username = ?1').bind(username).first();
    if (taken) return duplicateUsername(taken.id);

    const hash = await hashPassword(body.password);
    const allocated = await allocateId(env, 'accounts');
    if (allocated.error) {
      console.error('POST /api/accounts could not allocate an id:', allocated.error);
      return fail('database_error', 'Could not create the account.', 500);
    }
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO user_accounts (id, mechanic_id, staff_id, username, role, status, password_hash, password_changed_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'Active', ?6, ?7, ?7)`
    ).bind(allocated.id, person.isMechanic ? staffId : null, person.isMechanic ? null : staffId, username, body.role, hash, now).run();
    return ok(toRecord(await findAccount(env, allocated.id), principalOf(request)), {}, 201);
  } catch (err) {
    const mapped = writeConflict(err);
    if (mapped) return mapped;
    console.error('POST /api/accounts failed:', err && err.message);
    return fail('database_error', 'Could not create the account.', 500);
  }
}

/** PUT /api/accounts/:id -- activate / deactivate, or set the role. */
export async function updateAccount(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!isAdmin(who)) return forbidden();
  const id = readAccountId(rawId);
  if (!id) return fail('invalid_id', 'That is not an account id.', 400);

  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, UPDATE_KEYS);
  if (body.status !== undefined && !ACCOUNT_STATUSES.includes(body.status)) errors.status = 'Choose Active or Inactive.';
  if (body.role !== undefined && !ACCOUNT_ROLES.includes(body.role)) errors.role = `Choose one of: ${ACCOUNT_ROLES.join(', ')}.`;
  if (!Object.keys(errors).length && body.status === undefined && body.role === undefined) {
    errors.status = 'Nothing to change.';
  }
  if (Object.keys(errors).length) return unprocessable('Some account fields are not valid.', errors);

  try {
    const row = await findAccount(env, id);
    if (!row) return fail('not_found', 'No account with that id.', 404);
    const self = who.kind === 'account' && who.id === id;
    if (self && body.status === 'Inactive') {
      return conflict('You cannot deactivate your own account.', { field: 'status', fields: { status: 'You cannot deactivate your own account.' } });
    }
    if (self && body.role !== undefined && body.role !== row.role) {
      return conflict('You cannot change your own role.', { field: 'role', fields: { role: 'You cannot change your own role.' } });
    }
    if (body.status === 'Active' && row.status !== 'Active' && row.person_status !== 'Active') {
      return conflict('This staff member is inactive. Activate them in the Staff List first.', {
        field: 'status', fields: { status: 'This staff member is inactive. Activate them in the Staff List first.' },
      });
    }

    const status = body.status ?? row.status;
    const role = body.role ?? row.role;
    const deactivating = row.status === 'Active' && status === 'Inactive';
    const demoting = row.role === 'Administrator' && role !== 'Administrator';
    // An account session may not leave the workshop without an active administrator account.
    const guardLastAdmin = who.kind === 'account' && row.status === 'Active' && row.role === 'Administrator' && (deactivating || demoting);
    const now = nowIso();
    const res = await env.DB.prepare(
      `UPDATE user_accounts
          SET status = ?2, role = ?3, updated_at = ?4,
              session_version = session_version + ?5
        WHERE id = ?1
          AND (?6 = 0 OR (SELECT count(*) FROM user_accounts
                           WHERE status = 'Active' AND role = 'Administrator' AND id <> ?1) > 0)`
    ).bind(id, status, role, now, deactivating ? 1 : 0, guardLastAdmin ? 1 : 0).run();
    if (!res.meta || res.meta.changes !== 1) {
      return conflict('This is the last active administrator account. Add or activate another administrator first.', {
        field: 'status', fields: { status: 'This is the last active administrator account.' },
      });
    }
    return ok(toRecord(await findAccount(env, id), who));
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('PUT /api/accounts/:id failed:', err && err.message);
    return fail('database_error', 'Could not update the account.', 500);
  }
}

/** POST /api/accounts/:id/password -- an administrator sets a new password; every session of that account ends. */
export async function setAccountPassword(request, env, rawId) {
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!isAdmin(who)) return forbidden();
  const id = readAccountId(rawId);
  if (!id) return fail('invalid_id', 'That is not an account id.', 400);

  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, PASSWORD_KEYS);
  try {
    const row = await findAccount(env, id);
    if (!row) return fail('not_found', 'No account with that id.', 404);
    const weak = passwordProblem(body.password, row.username);
    if (weak) errors.password = weak;
    if (Object.keys(errors).length) return unprocessable('Some account fields are not valid.', errors);
    const hash = await hashPassword(body.password);
    const now = nowIso();
    await env.DB.prepare(
      `UPDATE user_accounts
          SET password_hash = ?2, password_changed_at = ?3, updated_at = ?3,
              session_version = session_version + 1, failed_logins = 0, locked_until = NULL
        WHERE id = ?1`
    ).bind(id, hash, now).run();
    return ok(toRecord(await findAccount(env, id), who));
  } catch (err) {
    console.error('POST /api/accounts/:id/password failed:', err && err.message);
    return fail('database_error', 'Could not set the password.', 500);
  }
}
