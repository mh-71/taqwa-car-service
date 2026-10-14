-- ===========================================================================
-- 0005 — customer follow-ups
-- ===========================================================================
-- Two tables for Customer CRM › Customer Follow-up:
--
--   follow_ups          one task: call this customer (optionally about one of
--                       their vehicles) about something, by a due date.
--   follow_up_contacts  every contact attempt made for a follow-up. Append-
--                       only: a wrong entry is voided with a reason, never
--                       edited or deleted.
--
-- Several Open follow-ups may share a customer, vehicle and reason; nothing
-- here forbids it. What IS prevented is the same submission being stored
-- twice: each creating request carries an idempotency key, unique per table,
-- and a fingerprint of its normalised payload, so a retried request finds the
-- row it already created (src/routes/follow-ups.js).
--
-- last_contact_at / last_outcome on follow_ups are a cache of the latest
-- Active contact. Only the Worker writes them, in the same batch as the
-- contact insert or void that changes them, by recomputing from the
-- contacts table -- never from a request.
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- No existing table is altered and no existing row is touched. A Worker built
-- before this migration never names these tables, so it keeps working against
-- the migrated schema -- which is what makes "migrate, then deploy" safe and a
-- code rollback harmless. Statements are IF NOT EXISTS / OR IGNORE, as in
-- 0002, so a partially applied file can be re-run.
--
-- Deleting a customer or vehicle that any follow-up refers to is refused by
-- the foreign keys below (ON DELETE RESTRICT); the existing delete routes
-- already turn that into a 409.
-- ===========================================================================


-- 1. Follow-ups ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS follow_ups (
  id                       TEXT PRIMARY KEY,                       -- 'FUP-0001', from id_counters
  customer_id              TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  -- Optional. When set, the Worker checks it belongs to customer_id.
  vehicle_id               TEXT REFERENCES vehicles(id) ON DELETE RESTRICT,
  reason                   TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 200),
  notes                    TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  priority                 TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  -- YYYY-MM-DD in the WORKSHOP'S calendar (Asia/Dhaka). Any real date, past
  -- included; the Worker checks it is a real calendar day.
  due_date                 TEXT NOT NULL
                             CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Pending / Due Today / Overdue are derived from due_date, never stored.
  status                   TEXT NOT NULL DEFAULT 'Open'
                             CHECK (status IN ('Open', 'Completed', 'Cancelled')),
  -- Cache of the latest Active contact; Worker-maintained only.
  last_contact_at          TEXT,
  last_outcome             TEXT CHECK (last_outcome IS NULL
                             OR last_outcome IN ('reached', 'unreachable', 'callback_requested', 'other')),
  closed_at                TEXT,
  -- Complete: optional note. Cancel: the required reason.
  close_note               TEXT CHECK (close_note IS NULL OR length(close_note) <= 500),
  idempotency_key          TEXT NOT NULL UNIQUE
                             CHECK (length(idempotency_key) BETWEEN 16 AND 64),
  -- SHA-256 (hex) of the normalised create payload; never changes.
  idempotency_fingerprint  TEXT NOT NULL CHECK (length(idempotency_fingerprint) = 64),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,

  CHECK ((status = 'Open') = (closed_at IS NULL)),
  CHECK (status <> 'Cancelled' OR (close_note IS NOT NULL AND length(trim(close_note)) > 0)),
  CHECK ((last_contact_at IS NULL) = (last_outcome IS NULL))
);

-- KPI counts and status / due-date filtering.
CREATE INDEX IF NOT EXISTS ix_fu_status_due ON follow_ups(status, due_date);
-- Customer lookups, and the RESTRICT check when a customer is deleted.
CREATE INDEX IF NOT EXISTS ix_fu_customer   ON follow_ups(customer_id);
-- The same for vehicles.
CREATE INDEX IF NOT EXISTS ix_fu_vehicle    ON follow_ups(vehicle_id);
-- The list order every collection uses: created_at DESC, id DESC.
CREATE INDEX IF NOT EXISTS ix_fu_created    ON follow_ups(created_at, id);


-- 2. Contact attempts --------------------------------------------------------
CREATE TABLE IF NOT EXISTS follow_up_contacts (
  id                       TEXT PRIMARY KEY,                       -- 'FUC-0001', from id_counters
  follow_up_id             TEXT NOT NULL REFERENCES follow_ups(id) ON DELETE RESTRICT,
  -- Server time, always. A request cannot set it.
  contacted_at             TEXT NOT NULL,
  outcome                  TEXT NOT NULL
                             CHECK (outcome IN ('reached', 'unreachable', 'callback_requested', 'other')),
  note                     TEXT CHECK (note IS NULL OR length(note) <= 1000),
  -- Any real date, past included. When given, it becomes the follow-up's
  -- due_date in the same batch.
  next_contact_date        TEXT CHECK (next_contact_date IS NULL
                             OR next_contact_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Free text. The workshop shares one login, so this names a person but
  -- does not prove who acted.
  recorded_by              TEXT CHECK (recorded_by IS NULL OR length(recorded_by) <= 100),
  status                   TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Void')),
  void_reason              TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  voided_at                TEXT,
  voided_by                TEXT CHECK (voided_by IS NULL OR length(voided_by) <= 100),
  idempotency_key          TEXT NOT NULL UNIQUE
                             CHECK (length(idempotency_key) BETWEEN 16 AND 64),
  idempotency_fingerprint  TEXT NOT NULL CHECK (length(idempotency_fingerprint) = 64),
  created_at               TEXT NOT NULL,

  -- A void always says why and when.
  CHECK (status = 'Active'
         OR (void_reason IS NOT NULL AND length(trim(void_reason)) > 0 AND voided_at IS NOT NULL)),
  CHECK (outcome <> 'callback_requested' OR next_contact_date IS NOT NULL),
  CHECK (outcome <> 'other' OR (note IS NOT NULL AND length(trim(note)) > 0))
);

-- The latest-Active-contact recompute, and the RESTRICT check on follow_ups.
CREATE INDEX IF NOT EXISTS ix_fuc_followup ON follow_up_contacts(follow_up_id, status, contacted_at);
CREATE INDEX IF NOT EXISTS ix_fuc_created  ON follow_up_contacts(created_at, id);


-- 3. Id counters (allocateId('followUps') -> FUP-0001) ---------------------
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES
  ('followUps',        'FUP', 0),
  ('followUpContacts', 'FUC', 0);
