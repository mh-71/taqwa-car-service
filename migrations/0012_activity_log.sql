-- ===========================================================================
-- 0012 — activity log
-- ===========================================================================
-- Who changed what, and when, in Staff Management: one row per SUCCESSFUL
-- administrative change -- adding or editing staff, creating or changing a
-- user account (and setting its password), recording or correcting
-- attendance, and submitting, approving or rejecting leave. It backs
-- Staff Management › Activity Log.
--
-- WRITTEN BY THE WORKER ONLY
-- --------------------------
-- No route takes an activity record from a request: the Worker writes one
-- after the change it describes has succeeded, naming the signed-in caller
-- it authenticated itself (never a name a request claims). The API reads the
-- log and nothing else -- there is no create, edit or delete.
--
-- WHAT IS KEPT
-- ------------
-- The time, who (the account's username and id, or the workshop passphrase /
-- machine token), the action, the module, the record it touched and a short
-- human-readable summary built from the saved record. Never a password, a
-- hash, a token, a cookie, a request body or a before/after copy of a record.
-- No foreign key: an entry outlives the record or account it names.
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- No existing table is altered and no existing row is touched. A Worker built
-- before this migration never names this table, so "migrate, then deploy" is
-- safe and a code rollback is harmless. Statements are IF NOT EXISTS, so a
-- partially applied file can be re-run.
--
-- To reverse it (only before any history is worth keeping):
--   DROP TABLE activity_log;
-- ===========================================================================


CREATE TABLE IF NOT EXISTS activity_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at       TEXT NOT NULL,                  -- ISO instant (UTC), when the change succeeded
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('account', 'passphrase', 'token')),
  actor_account_id  TEXT CHECK (actor_account_id IS NULL OR actor_account_id GLOB 'USR-*'),
  actor_name        TEXT NOT NULL CHECK (length(actor_name) BETWEEN 1 AND 100),
  action            TEXT NOT NULL CHECK (action IN ('create', 'update', 'password', 'approve', 'reject')),
  module            TEXT NOT NULL CHECK (module IN ('staff', 'accounts', 'attendance', 'leave')),
  record_id         TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 40),
  summary           TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),

  -- An account is named by its id; the passphrase and the token are not accounts.
  CHECK ((actor_kind = 'account') = (actor_account_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_activity_occurred        ON activity_log (occurred_at);
CREATE INDEX IF NOT EXISTS ix_activity_module_occurred ON activity_log (module, occurred_at);
