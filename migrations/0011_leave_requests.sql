-- ===========================================================================
-- 0011 — leave requests
-- ===========================================================================
-- A staff member's request for leave -- Casual, Sick, Annual or Unpaid, from
-- one day to another -- and the decision on it. It backs Staff Management ›
-- Leave Management.
--
-- LINKED, NOT COPIED
-- ------------------
-- A staff member is either a mechanic ('MEC-0001', in mechanics) or any other
-- employee ('STF-0001', in staff), exactly as for user_accounts (0009) and
-- attendance (0010). A request points at exactly one of them through a real
-- foreign key and copies nothing about the person. The request goes with its
-- person (ON DELETE CASCADE): the Mechanics page may still delete an unused
-- mechanic exactly as before; staff records are never deleted.
--
-- ONE DECISION, KEPT
-- ------------------
-- A request starts Pending and is decided once: Approved or Rejected. A
-- decided request never changes again and is never deleted -- the decision,
-- when it was made, by whom and why stay with it. The CHECKs below make a
-- half-decided row (a status without its time, or the other way round)
-- impossible; the Worker makes the transition in one conditional UPDATE, so
-- two decisions at once cannot both win.
--
-- WHAT IS NOT HERE
-- ----------------
-- No leave balance, entitlement, pay or attendance rule: approving a request
-- changes nothing else. Attendance (0010) stays exactly what was recorded.
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- No existing table is altered and no existing row is touched. A Worker built
-- before this migration never names this table, so "migrate, then deploy" is
-- safe and a code rollback is harmless. Statements are IF NOT EXISTS / OR
-- IGNORE, so a partially applied file can be re-run.
--
-- To reverse it (only before any leave request is worth keeping):
--   DROP TABLE leave_requests;
--   DELETE FROM id_counters WHERE collection = 'leaveRequests';
-- ===========================================================================


-- 1. Leave requests -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_requests (
  id             TEXT PRIMARY KEY,                -- 'LVR-0001', allocated by the Worker
  -- Exactly one of these is set: whose leave this is.
  mechanic_id    TEXT REFERENCES mechanics(id) ON DELETE CASCADE
                 CHECK (mechanic_id IS NULL OR mechanic_id GLOB 'MEC-*'),
  staff_id       TEXT REFERENCES staff(id) ON DELETE CASCADE
                 CHECK (staff_id IS NULL OR staff_id GLOB 'STF-*'),
  leave_type     TEXT NOT NULL
                 CHECK (leave_type IN ('Casual', 'Sick', 'Annual', 'Unpaid')),
  start_date     TEXT NOT NULL
                 CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date       TEXT NOT NULL
                 CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reason         TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status         TEXT NOT NULL DEFAULT 'Pending'
                 CHECK (status IN ('Pending', 'Approved', 'Rejected')),
  decided_at     TEXT,
  decided_by     TEXT CHECK (decided_by IS NULL OR length(decided_by) <= 100),
  decision_note  TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  created_at     TEXT NOT NULL,                   -- when the request was submitted
  updated_at     TEXT NOT NULL,

  CHECK ((mechanic_id IS NULL) <> (staff_id IS NULL)),
  CHECK (end_date >= start_date),
  -- A Pending request has no decision; a decided one always has its time and who made it.
  CHECK ((status = 'Pending') = (decided_at IS NULL)),
  CHECK ((status = 'Pending') = (decided_by IS NULL)),
  CHECK (status <> 'Pending' OR decision_note IS NULL)
);

CREATE INDEX IF NOT EXISTS ix_leave_requests_mechanic ON leave_requests (mechanic_id, start_date) WHERE mechanic_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_leave_requests_staff    ON leave_requests (staff_id, start_date)    WHERE staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_leave_requests_start    ON leave_requests (start_date);


-- 2. Counter -----------------------------------------------------------------
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES
  ('leaveRequests', 'LVR', 0);
