-- ===========================================================================
-- 0009 — user accounts
-- ===========================================================================
-- A sign-in of its own for a named staff member. It backs Staff Management ›
-- User Accounts, and POST /api/session's username + password sign-in.
--
-- WHAT IT ADDS TO SIGNING IN
-- --------------------------
-- Until now the workshop signed in with one shared passphrase, and the session
-- cookie named nobody. That is unchanged: the passphrase still signs in, and
-- its sessions are verified exactly as before. An account is a SECOND kind of
-- credential handled by the same route, the same signed cookie and the same
-- gate -- not a separate login system. What it adds is a person: a session that
-- says whose it is, can be ended for one person (deactivate, or reset the
-- password), and records when that person last signed in.
--
-- ROLES
-- -----
-- Nothing in the API restricts what a signed-in caller may do, so every
-- account has full access, exactly as the passphrase does. The only role the
-- Worker accepts is therefore 'Administrator' -- offering 'Mechanic' or
-- 'Accountant' here would claim a restriction that nothing enforces. The
-- column is plain TEXT validated by the Worker (not a CHECK list), so the
-- Roles & Permissions work can add enforced roles without rebuilding the table.
--
-- ONE ACCOUNT PER PERSON, LINKED, NOT COPIED
-- ------------------------------------------
-- A staff member is either a mechanic ('MEC-0001', in mechanics) or any other
-- employee ('STF-0001', in staff). An account points at exactly one of them
-- through a real foreign key and copies nothing about the person (name, phone,
-- status stay where they are). The unique indexes allow one account per
-- person and one person per username (case-insensitive). The account goes with
-- its person (ON DELETE CASCADE): the Mechanics page may still delete an unused
-- mechanic exactly as before; staff records are never deleted.
--
-- SECRETS
-- -------
-- password_hash holds a PBKDF2-HMAC-SHA256 hash with a random salt
-- ('pbkdf2_sha256$<iterations>$<salt>$<hash>'), never a password. The API
-- never returns it. session_version is part of every account session's
-- signature: bumping it (deactivation, password reset) ends that person's
-- sessions everywhere at once. failed_logins / locked_until slow down guessing
-- one account's password.
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- No existing table is altered and no existing row is touched. A Worker built
-- before this migration never names this table, so "migrate, then deploy" is
-- safe and a code rollback is harmless (accounts simply stop being able to
-- sign in; the passphrase keeps working). Statements are IF NOT EXISTS / OR
-- IGNORE, so a partially applied file can be re-run.
--
-- To reverse it (only before any account is worth keeping):
--   DROP TABLE user_accounts;
--   DELETE FROM id_counters WHERE collection = 'accounts';
-- ===========================================================================


-- 1. Accounts -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_accounts (
  id               TEXT PRIMARY KEY,                -- 'USR-0001', allocated by the Worker
  -- Exactly one of these is set: the person this account belongs to.
  mechanic_id      TEXT REFERENCES mechanics(id) ON DELETE CASCADE
                   CHECK (mechanic_id IS NULL OR mechanic_id GLOB 'MEC-*'),
  staff_id         TEXT REFERENCES staff(id) ON DELETE CASCADE
                   CHECK (staff_id IS NULL OR staff_id GLOB 'STF-*'),
  -- The sign-in name: lower case letters, digits, '.', '_' and '-', 3-32 long.
  username         TEXT NOT NULL
                   CHECK (length(username) BETWEEN 3 AND 32 AND username = lower(username)
                          AND username NOT GLOB '*[^a-z0-9._-]*'),
  role             TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 40),
  status           TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  password_hash    TEXT NOT NULL CHECK (password_hash GLOB 'pbkdf2_sha256$*'),
  session_version  INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  failed_logins    INTEGER NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until     TEXT,
  last_login_at    TEXT,
  password_changed_at TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT,

  CHECK ((mechanic_id IS NULL) <> (staff_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_username ON user_accounts (username COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_mechanic ON user_accounts (mechanic_id) WHERE mechanic_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_staff    ON user_accounts (staff_id)    WHERE staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_accounts_status ON user_accounts (status);


-- 2. Counter -----------------------------------------------------------------
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES
  ('accounts', 'USR', 0);
