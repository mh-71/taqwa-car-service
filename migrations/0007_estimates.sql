-- ===========================================================================
-- 0007 — estimates & quotations
-- ===========================================================================
-- A repair estimate for one customer's vehicle, before any work starts. Its
-- money model is the job card's own (0001 job_cards + 0003/0004): service /
-- custom-work lines, part lines, labour hours x rate or a flat labour cost, a
-- fixed or percentage discount and a tax rate. The Worker recomputes every
-- total with the job card's computeTotals(); nothing stored here is taken
-- from a browser's arithmetic.
--
--   Draft -> Pending                 (send: issued to the customer)
--   Pending -> Draft                 (an edit; the version goes up)
--   Pending -> Approved | Rejected   (a recorded decision)
--   Draft | Pending | Approved -> Cancelled   (reason required; never deleted)
--   Approved -> converted            (job_card_id set; one job card per estimate)
--
-- Expired (Pending past valid_until in the workshop's calendar) and Converted
-- (job_card_id set) are derived by the Worker and never stored.
--
-- decided_via records HOW a decision was captured: 'staff' when a member of
-- staff recorded consent given by phone or in person (a note is mandatory),
-- 'online' reserved for the customer approval flow of a later, separately
-- reviewed migration. The workshop shares one login, so created_by /
-- updated_by / decided_by and estimate_events.actor are free text: they name
-- a person but do not prove who acted.
--
-- Estimates never touch stock. Converting one creates a job card in its
-- initial status through the existing job card route, and inventory then
-- follows the job card workflow exactly as before.
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- No existing table is altered and no existing row is touched; the only row
-- written is this feature's id counter. A Worker built before this migration
-- never names these tables, so "migrate, then deploy" is safe and a code
-- rollback is harmless. Statements are IF NOT EXISTS / OR IGNORE, so a
-- partially applied file can be re-run. No demo or sample data is inserted.
--
-- Deleting a customer, vehicle, catalogue service, part or job card that an
-- estimate refers to is refused by the foreign keys below (ON DELETE
-- RESTRICT); the existing delete routes already turn that into a 409.
-- ===========================================================================


-- 1. Estimates ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estimates (
  id                       TEXT PRIMARY KEY,                       -- 'EST-0001', from id_counters
  customer_id              TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  vehicle_id               TEXT NOT NULL REFERENCES vehicles(id)  ON DELETE RESTRICT,
  -- YYYY-MM-DD in the WORKSHOP'S calendar (Asia/Dhaka). An estimate is valid
  -- through the whole of valid_until.
  date                     TEXT NOT NULL
                             CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  valid_until              TEXT NOT NULL
                             CHECK (valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status                   TEXT NOT NULL DEFAULT 'Draft'
                             CHECK (status IN ('Draft', 'Pending', 'Approved', 'Rejected', 'Cancelled')),
  -- Goes up on every edit, so a decision can name the exact quotation it saw.
  version                  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),

  complaint                TEXT NOT NULL CHECK (length(trim(complaint)) > 0 AND length(complaint) <= 2000),
  notes                    TEXT CHECK (notes IS NULL OR length(notes) <= 2000),

  labour_hours             REAL CHECK (labour_hours IS NULL OR labour_hours >= 0),
  labour_rate              REAL CHECK (labour_rate IS NULL OR labour_rate >= 0),
  labour_cost              REAL NOT NULL DEFAULT 0 CHECK (labour_cost >= 0),
  discount                 REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
  discount_type            TEXT NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount', 'percent')),
  discount_rate            REAL CHECK (discount_rate IS NULL OR (discount_rate >= 0 AND discount_rate <= 100)),
  tax_rate                 REAL NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  subtotal                 REAL NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax                      REAL NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total                    REAL NOT NULL DEFAULT 0 CHECK (total >= 0),

  sent_at                  TEXT,
  decided_at               TEXT,
  decided_via              TEXT CHECK (decided_via IS NULL OR decided_via IN ('online', 'staff')),
  decided_by               TEXT CHECK (decided_by IS NULL OR length(decided_by) <= 100),
  decision_note            TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  cancelled_at             TEXT,
  cancel_reason            TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),

  job_card_id              TEXT REFERENCES job_cards(id) ON DELETE RESTRICT,
  converted_at             TEXT,
  -- A conversion in flight: a random claim and when it was taken. Internal;
  -- never leaves the Worker. Cleared when the conversion finishes or fails.
  conversion_claim         TEXT CHECK (conversion_claim IS NULL OR length(conversion_claim) BETWEEN 16 AND 64),
  conversion_claimed_at    TEXT,
  -- A random value replaced on every write, so the line rows and the history
  -- row in the same batch can be made conditional on THIS request's header
  -- write having happened. Internal; never leaves the Worker.
  write_token              TEXT NOT NULL CHECK (length(write_token) BETWEEN 16 AND 64),

  created_by               TEXT CHECK (created_by IS NULL OR length(created_by) <= 100),
  updated_by               TEXT CHECK (updated_by IS NULL OR length(updated_by) <= 100),
  idempotency_key          TEXT NOT NULL UNIQUE
                             CHECK (length(idempotency_key) BETWEEN 16 AND 64),
  -- SHA-256 (hex) of the normalised create payload; never changes.
  idempotency_fingerprint  TEXT NOT NULL CHECK (length(idempotency_fingerprint) = 64),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,

  CHECK (valid_until >= date),
  CHECK (discount <= subtotal),
  -- Issued statuses have been sent at least once.
  CHECK (status NOT IN ('Pending', 'Approved', 'Rejected') OR sent_at IS NOT NULL),
  -- A decision exists exactly when the estimate is Approved or Rejected.
  CHECK ((status IN ('Approved', 'Rejected')) = (decided_via IS NOT NULL AND decided_at IS NOT NULL)),
  -- A staff-recorded decision always carries its note.
  CHECK (decided_via IS NULL OR decided_via <> 'staff'
         OR (decision_note IS NOT NULL AND length(trim(decision_note)) > 0)),
  CHECK ((status = 'Cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status <> 'Cancelled' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0)),
  -- Only an Approved estimate is ever converted, and the two columns move together.
  CHECK (job_card_id IS NULL OR status = 'Approved'),
  CHECK ((job_card_id IS NULL) = (converted_at IS NULL)),
  CHECK ((conversion_claim IS NULL) = (conversion_claimed_at IS NULL)),
  CHECK (conversion_claim IS NULL OR (status = 'Approved' AND job_card_id IS NULL))
);

-- One job card per estimate, and a job card belongs to at most one estimate.
CREATE UNIQUE INDEX IF NOT EXISTS ux_est_job_card ON estimates(job_card_id) WHERE job_card_id IS NOT NULL;
-- Summary cards and status / validity filtering.
CREATE INDEX IF NOT EXISTS ix_est_status_valid ON estimates(status, valid_until);
-- The RESTRICT checks for customers and vehicles.
CREATE INDEX IF NOT EXISTS ix_est_customer     ON estimates(customer_id);
CREATE INDEX IF NOT EXISTS ix_est_vehicle      ON estimates(vehicle_id);
CREATE INDEX IF NOT EXISTS ix_est_date         ON estimates(date);
-- The list order every collection uses: created_at DESC, id DESC.
CREATE INDEX IF NOT EXISTS ix_est_created      ON estimates(created_at, id);


-- 2. Line items --------------------------------------------------------------
-- The same shape as job_card_services / job_card_parts. `name`, `part_no` and
-- `unit_price` are SNAPSHOTS: staff may override the catalogue price, and a
-- later catalogue change never rewrites an issued quotation.
CREATE TABLE IF NOT EXISTS estimate_services (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id  TEXT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  -- NULL = custom work with no catalogue service behind it.
  service_id   TEXT REFERENCES services(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 200),
  qty          REAL NOT NULL CHECK (qty > 0),
  unit_price   REAL NOT NULL CHECK (unit_price >= 0),
  total        REAL NOT NULL CHECK (total >= 0),
  line_no      INTEGER NOT NULL CHECK (line_no >= 1)
);
CREATE INDEX IF NOT EXISTS ix_ests_estimate ON estimate_services(estimate_id);
CREATE INDEX IF NOT EXISTS ix_ests_service  ON estimate_services(service_id);

CREATE TABLE IF NOT EXISTS estimate_parts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id  TEXT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  -- NULL = a manual part with no inventory record behind it.
  part_id      TEXT REFERENCES parts(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 200),
  part_no      TEXT CHECK (part_no IS NULL OR length(part_no) <= 100),
  qty          REAL NOT NULL CHECK (qty > 0),
  unit_price   REAL NOT NULL CHECK (unit_price >= 0),
  total        REAL NOT NULL CHECK (total >= 0),
  line_no      INTEGER NOT NULL CHECK (line_no >= 1)
);
CREATE INDEX IF NOT EXISTS ix_estp_estimate ON estimate_parts(estimate_id);
CREATE INDEX IF NOT EXISTS ix_estp_part     ON estimate_parts(part_id);


-- 3. Activity history (append-only) ------------------------------------------
-- One row per lifecycle step, written in the same batch as the change it
-- describes. `actor` is free text under the shared login: a name, not proof.
CREATE TABLE IF NOT EXISTS estimate_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id  TEXT NOT NULL REFERENCES estimates(id) ON DELETE RESTRICT,
  event        TEXT NOT NULL CHECK (event IN
                 ('created', 'updated', 'sent', 'approved', 'rejected', 'cancelled', 'converted')),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  version      INTEGER NOT NULL CHECK (version >= 1),
  actor        TEXT CHECK (actor IS NULL OR length(actor) <= 100),
  note         TEXT CHECK (note IS NULL OR length(note) <= 1000),
  -- Small JSON summary (e.g. the totals before and after an edit).
  details      TEXT CHECK (details IS NULL OR length(details) <= 4000),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_este_estimate ON estimate_events(estimate_id, id);


-- 4. Id counter (allocateId('estimates') -> EST-0001) ----------------------
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES
  ('estimates', 'EST', 0);
