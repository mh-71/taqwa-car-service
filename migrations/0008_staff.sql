-- ===========================================================================
-- 0008 — staff
-- ===========================================================================
-- One roster for every employee: mechanics, service advisors, accountants,
-- managers, helpers and administrative staff. It backs Staff Management ›
-- Staff List.
--
-- ONE RECORD PER PERSON
-- ---------------------
-- Mechanics already live in `mechanics`, and job_cards, appointments and
-- follow_up_tasks point at them by id. That table is left exactly as it is.
-- A row here is one of two things:
--
--   * A MECHANIC'S PROFILE  (mechanic_id set, and equal to id: 'MEC-0001')
--     Only the HR fields every employee has and a mechanic row lacks --
--     employee code, designation, department. The person (name, phone, email,
--     joining date, status) stays in `mechanics` and is NOT copied here; the
--     CHECK below keeps those columns NULL on a profile, so the two can never
--     disagree. A mechanic with no profile yet is still on the roster -- the
--     Worker lists mechanics LEFT JOIN staff -- so a mechanic added on the
--     Mechanics page appears in the Staff List at once.
--
--   * ANY OTHER EMPLOYEE    (mechanic_id NULL, id 'STF-0001')
--     The whole record. Nothing references these rows yet; they are never
--     assignable to a job card or an appointment, which still take a mechanic.
--
-- Pay (salary, commission) is not here and is not exposed by the staff API.
--
-- No delete route exists for staff: an employee who leaves is set Inactive,
-- which keeps every historical record pointing at them. A mechanic's profile
-- goes with the mechanic (ON DELETE CASCADE), so the Mechanics page's delete
-- -- itself refused while job cards or appointments use the mechanic -- behaves
-- exactly as before.
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- No existing table is altered and no existing row is touched. A Worker built
-- before this migration never names this table, so "migrate, then deploy" is
-- safe and a code rollback is harmless. Statements are IF NOT EXISTS / OR
-- IGNORE, so a partially applied file can be re-run.
--
-- To reverse it (only before any staff data is worth keeping):
--   DROP TABLE staff;
--   DELETE FROM id_counters WHERE collection = 'staff';
-- ===========================================================================


-- 1. Staff -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
  id             TEXT PRIMARY KEY,                -- 'STF-0001', or the mechanic's own id
  mechanic_id    TEXT UNIQUE REFERENCES mechanics(id) ON DELETE CASCADE,
  -- The workshop's own employee number, optional. Unique without regard to
  -- case (index below), because "tq-001" and "TQ-001" are the same badge.
  employee_code  TEXT CHECK (employee_code IS NULL
                             OR (length(trim(employee_code)) > 0 AND length(employee_code) <= 20)),
  designation    TEXT CHECK (designation IS NULL OR (length(trim(designation)) > 0 AND length(designation) <= 60)),
  department     TEXT CHECK (department  IS NULL OR (length(trim(department))  > 0 AND length(department)  <= 60)),
  -- The person. Set for an employee who is not a mechanic; NULL on a profile.
  name           TEXT CHECK (name IS NULL OR (length(trim(name)) > 0 AND length(name) <= 120)),
  phone          TEXT CHECK (phone IS NULL OR length(phone) <= 20),
  email          TEXT CHECK (email IS NULL OR length(email) <= 160),
  address        TEXT CHECK (address IS NULL OR length(address) <= 500),
  joining_date   TEXT CHECK (joining_date IS NULL OR joining_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status         TEXT CHECK (status IS NULL OR status IN ('Active', 'Inactive')),
  notes          TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at     TEXT NOT NULL,
  updated_at     TEXT,

  -- A profile carries its mechanic's id as its own.
  CHECK (mechanic_id IS NULL OR mechanic_id = id),
  CHECK (
    -- Any other employee: the whole record.
    (mechanic_id IS NULL
      AND name IS NOT NULL AND phone IS NOT NULL AND status IS NOT NULL
      AND designation IS NOT NULL AND department IS NOT NULL)
    OR
    -- A mechanic's profile: HR fields only; the person stays in mechanics.
    (mechanic_id IS NOT NULL
      AND name IS NULL AND phone IS NULL AND email IS NULL AND address IS NULL
      AND joining_date IS NULL AND status IS NULL AND notes IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_employee_code
  ON staff (employee_code COLLATE NOCASE) WHERE employee_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_staff_status     ON staff(status);
CREATE INDEX IF NOT EXISTS ix_staff_department ON staff(department);


-- 2. Counter -----------------------------------------------------------------
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES
  ('staff', 'STF', 0);
