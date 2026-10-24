-- ===========================================================================
-- 0010 — attendance
-- ===========================================================================
-- One record per staff member per day: whether they were present, late, on a
-- half day, absent, on leave or off for a holiday, and -- for a day they
-- worked -- when they checked in and out. It backs Staff Management ›
-- Attendance.
--
-- LINKED, NOT COPIED
-- ------------------
-- A staff member is either a mechanic ('MEC-0001', in mechanics) or any other
-- employee ('STF-0001', in staff), exactly as for user_accounts (0009). A
-- record points at exactly one of them through a real foreign key and copies
-- nothing about the person; the name, department and status stay where they
-- are. The record goes with its person (ON DELETE CASCADE): the Mechanics page
-- may still delete an unused mechanic exactly as before; staff records are
-- never deleted.
--
-- ONE RECORD PER PERSON PER DAY
-- -----------------------------
-- The two partial unique indexes make a second record for the same person and
-- day impossible, whatever the requests do -- two saves at the same moment
-- included. A correction is an explicit update of the existing record (the
-- Worker requires the updatedAt value the edit was made from, so a change
-- made meanwhile by someone else is refused, never overwritten).
--
-- WHAT IS NOT HERE
-- ----------------
-- No pay, overtime, shift or leave-balance rule: this is a record of what
-- happened, nothing is calculated from it. Times are the workshop's local
-- wall-clock time ('HH:MM', Asia/Dhaka), on the record's own date; a shift
-- past midnight is not supported (check-out must be after check-in).
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- No existing table is altered and no existing row is touched. A Worker built
-- before this migration never names this table, so "migrate, then deploy" is
-- safe and a code rollback is harmless. Statements are IF NOT EXISTS / OR
-- IGNORE, so a partially applied file can be re-run.
--
-- To reverse it (only before any attendance is worth keeping):
--   DROP TABLE attendance;
--   DELETE FROM id_counters WHERE collection = 'attendance';
-- ===========================================================================


-- 1. Attendance -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
  id               TEXT PRIMARY KEY,                -- 'ATT-0001', allocated by the Worker
  -- Exactly one of these is set: whose day this is.
  mechanic_id      TEXT REFERENCES mechanics(id) ON DELETE CASCADE
                   CHECK (mechanic_id IS NULL OR mechanic_id GLOB 'MEC-*'),
  staff_id         TEXT REFERENCES staff(id) ON DELETE CASCADE
                   CHECK (staff_id IS NULL OR staff_id GLOB 'STF-*'),
  attendance_date  TEXT NOT NULL
                   CHECK (attendance_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status           TEXT NOT NULL
                   CHECK (status IN ('Present', 'Late', 'Half-day', 'Absent', 'On Leave', 'Holiday')),
  check_in         TEXT CHECK (check_in  IS NULL OR (length(check_in)  = 5 AND check_in  GLOB '[0-2][0-9]:[0-5][0-9]')),
  check_out        TEXT CHECK (check_out IS NULL OR (length(check_out) = 5 AND check_out GLOB '[0-2][0-9]:[0-5][0-9]')),
  notes            TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,

  CHECK ((mechanic_id IS NULL) <> (staff_id IS NULL)),
  -- Times belong to a day that was worked, and a check-out needs a check-in before it.
  CHECK (status IN ('Present', 'Late', 'Half-day') OR (check_in IS NULL AND check_out IS NULL)),
  CHECK (check_out IS NULL OR (check_in IS NOT NULL AND check_out > check_in))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_mechanic_day ON attendance (mechanic_id, attendance_date) WHERE mechanic_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_staff_day    ON attendance (staff_id, attendance_date)    WHERE staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_attendance_date ON attendance (attendance_date);


-- 2. Counter -----------------------------------------------------------------
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES
  ('attendance', 'ATT', 0);
