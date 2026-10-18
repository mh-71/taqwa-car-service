-- ===========================================================================
-- 0006 — follow-up tasks
-- ===========================================================================
-- One table for Customer CRM › Follow-up Tasks: a piece of workshop work with
-- a title, an optional customer / vehicle / job card it is about, an optional
-- staff member (mechanic) it is assigned to, a priority and a due date.
--
--   Pending  -> In Progress -> Completed
--   Pending  -> Completed
--   Pending | In Progress -> Cancelled   (the soft delete: a reason is kept)
--
-- Completed and Cancelled are final; the Worker refuses any other move and
-- every UPDATE carries the expected status in its WHERE. Overdue is derived
-- from due_date for an open task and never stored.
--
-- References are optional, but they must agree with each other: a vehicle or
-- job card needs a customer, the vehicle must belong to that customer, and a
-- job card must be that customer's (and that vehicle's, when one is set).
-- The Worker checks this inside its writes; the CHECKs below keep the shape.
--
-- The workshop shares one login, so created_by / updated_by are free text: they
-- name a person but do not prove who acted. The timestamps are server time.
--
-- As in 0005, each create carries an idempotency key (UNIQUE) and a SHA-256
-- fingerprint of its normalised payload, so a retried submission finds the row
-- it already created instead of making a second one.
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- No existing table is altered and no existing row is touched. A Worker built
-- before this migration never names this table, so "migrate, then deploy" is
-- safe and a code rollback is harmless. Statements are IF NOT EXISTS / OR
-- IGNORE, so a partially applied file can be re-run.
--
-- Deleting a customer, vehicle, job card or mechanic that a task refers to is
-- refused by the foreign keys below (ON DELETE RESTRICT); the existing delete
-- routes already turn that into a 409.
-- ===========================================================================


-- 1. Tasks -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id                       TEXT PRIMARY KEY,                       -- 'TSK-0001', from id_counters
  title                    TEXT NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 150),
  description              TEXT CHECK (description IS NULL OR length(description) <= 2000),
  customer_id              TEXT REFERENCES customers(id)  ON DELETE RESTRICT,
  vehicle_id               TEXT REFERENCES vehicles(id)   ON DELETE RESTRICT,
  job_card_id              TEXT REFERENCES job_cards(id)  ON DELETE RESTRICT,
  -- Staff are the workshop's mechanics. NULL = not assigned yet.
  assigned_to              TEXT REFERENCES mechanics(id)  ON DELETE RESTRICT,
  priority                 TEXT NOT NULL DEFAULT 'medium'
                             CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  -- YYYY-MM-DD in the WORKSHOP'S calendar (Asia/Dhaka); the Worker checks it
  -- is a real calendar day.
  due_date                 TEXT NOT NULL
                             CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status                   TEXT NOT NULL DEFAULT 'Pending'
                             CHECK (status IN ('Pending', 'In Progress', 'Completed', 'Cancelled')),
  started_at               TEXT,
  completed_at             TEXT,
  completion_note          TEXT CHECK (completion_note IS NULL OR length(completion_note) <= 500),
  cancelled_at             TEXT,
  cancel_reason            TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  created_by               TEXT CHECK (created_by IS NULL OR length(created_by) <= 100),
  updated_by               TEXT CHECK (updated_by IS NULL OR length(updated_by) <= 100),
  idempotency_key          TEXT NOT NULL UNIQUE
                             CHECK (length(idempotency_key) BETWEEN 16 AND 64),
  -- SHA-256 (hex) of the normalised create payload; never changes.
  idempotency_fingerprint  TEXT NOT NULL CHECK (length(idempotency_fingerprint) = 64),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,

  CHECK (vehicle_id IS NULL OR customer_id IS NOT NULL),
  CHECK (job_card_id IS NULL OR customer_id IS NOT NULL),
  CHECK ((status = 'Completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'Cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status <> 'Cancelled' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0)),
  CHECK (status <> 'In Progress' OR started_at IS NOT NULL)
);

-- KPI counts and status / due-date filtering.
CREATE INDEX IF NOT EXISTS ix_ftk_status_due ON follow_up_tasks(status, due_date);
-- Staff filter, and the RESTRICT check when a mechanic is deleted.
CREATE INDEX IF NOT EXISTS ix_ftk_assigned   ON follow_up_tasks(assigned_to);
-- The RESTRICT checks for customers, vehicles and job cards.
CREATE INDEX IF NOT EXISTS ix_ftk_customer   ON follow_up_tasks(customer_id);
CREATE INDEX IF NOT EXISTS ix_ftk_vehicle    ON follow_up_tasks(vehicle_id);
CREATE INDEX IF NOT EXISTS ix_ftk_job_card   ON follow_up_tasks(job_card_id);
-- The list order every collection uses: created_at DESC, id DESC.
CREATE INDEX IF NOT EXISTS ix_ftk_created    ON follow_up_tasks(created_at, id);


-- 2. Id counter (allocateId('followUpTasks') -> TSK-0001) ------------------
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES
  ('followUpTasks', 'TSK', 0);
