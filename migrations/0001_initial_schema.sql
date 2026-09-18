-- ===========================================================================
-- Taqwa Automobile Service Center — initial D1 schema
-- ===========================================================================
-- Mirrors the eleven localStorage collections the app uses today. Nothing is
-- migrated by this file: it only creates the shape. The frontend continues to
-- run on localStorage until a later phase.
--
-- ---------------------------------------------------------------------------
-- IDENTIFIERS
-- ---------------------------------------------------------------------------
-- Primary keys stay the human-readable ids the app already prints on job cards
-- and invoices (CUS-0001, JOB-0007, INV-0003). They carry business meaning, so
-- they are kept verbatim rather than replaced with integers. The id_counters
-- table replaces storage.js's `counters` map and is the single place a new
-- sequence number is drawn from.
--
-- ---------------------------------------------------------------------------
-- MONETARY VALUES  (read this before changing any amount column)
-- ---------------------------------------------------------------------------
-- All money is stored as REAL, in whole Bangladeshi Taka, matching exactly
-- what the app stores today (JS numbers: 4200, 1935, 4935). This is a
-- deliberate choice for THIS phase:
--
--   * The app's own totals engine (job-cards.js computeTotals) works in JS
--     numbers and rounds tax with Math.round, so every stored amount is
--     already an integer number of Taka. No sub-Taka precision exists to lose.
--   * Changing the representation now would mean changing computeTotals, the
--     invoice snapshot, the payment balance logic and every display path --
--     i.e. exactly the business logic this phase must not touch.
--
-- The textbook-correct representation is INTEGER paisa (amount * 100), which
-- removes float rounding entirely. That migration is worth doing, but it is a
-- separate, deliberate change: add *_paisa INTEGER columns, backfill with
-- ROUND(amount * 100), move the Worker and the frontend over, then drop the
-- REAL columns. Do not mix the two.
--
-- Until then: never compare money with `=` after arithmetic, and round to
-- whole Taka consistently (ROUND(x)) when aggregating in SQL.
--
-- ---------------------------------------------------------------------------
-- DATES
-- ---------------------------------------------------------------------------
-- `date` columns are TEXT 'YYYY-MM-DD' in the WORKSHOP'S LOCAL CALENDAR
-- (Asia/Dhaka), not UTC. This matches the Finding 2 fix (Utils.toDateStr) and
-- must be preserved: a Worker must not derive these with toISOString().
-- `created_at` / `updated_at` are full ISO-8601 timestamps, which are UTC.
--
-- ---------------------------------------------------------------------------
-- FOREIGN KEYS
-- ---------------------------------------------------------------------------
-- ON DELETE RESTRICT everywhere a real record is referenced, so the delete
-- guards the UI already enforces (a customer with vehicles cannot be deleted,
-- an invoiced job card cannot be deleted) also hold at the database level.
-- Line-item children CASCADE, because they have no meaning without a parent.
--
-- Four references are circular (job_cards <-> invoices, job_cards <->
-- appointments). Those are DEFERRABLE INITIALLY DEFERRED so a pair can be
-- written inside one transaction in either order.
--
-- D1 enforces foreign keys by default; do not disable that.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- id_counters — replaces storage.js generateId()
-- ---------------------------------------------------------------------------
CREATE TABLE id_counters (
  collection  TEXT PRIMARY KEY,
  prefix      TEXT NOT NULL,
  last_value  INTEGER NOT NULL DEFAULT 0 CHECK (last_value >= 0)
);

INSERT INTO id_counters (collection, prefix, last_value) VALUES
  ('customers',             'CUS', 0),
  ('vehicles',              'VEH', 0),
  ('appointments',          'APT', 0),
  ('jobCards',              'JOB', 0),
  ('services',              'SRV', 0),
  ('mechanics',             'MEC', 0),
  ('parts',                 'PRT', 0),
  ('invoices',              'INV', 0),
  ('payments',              'PAY', 0),
  ('expenses',              'EXP', 0),
  ('inventoryTransactions', 'STK', 0);


-- ---------------------------------------------------------------------------
-- settings — single row; the app treats settings as one object
-- ---------------------------------------------------------------------------
-- Theme is NOT stored here: it is a per-device UI preference and stays in the
-- browser's localStorage.
CREATE TABLE settings (
  id                           INTEGER PRIMARY KEY CHECK (id = 1),
  business_name                TEXT NOT NULL,
  phone                        TEXT NOT NULL,
  email                        TEXT,
  website                      TEXT,
  tax_id                       TEXT,
  address                      TEXT NOT NULL,
  business_description         TEXT,
  invoice_footer               TEXT,
  payment_terms                TEXT,
  tax_rate                     REAL NOT NULL DEFAULT 5 CHECK (tax_rate BETWEEN 0 AND 100),
  currency                     TEXT NOT NULL DEFAULT '৳',
  default_appointment_duration INTEGER CHECK (default_appointment_duration IS NULL OR default_appointment_duration > 0),
  opening_time                 TEXT,
  closing_time                 TEXT,
  working_days                 TEXT,          -- JSON array, e.g. ["Sat","Sun","Mon"]
  updated_at                   TEXT
);


-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone         TEXT NOT NULL CHECK (length(trim(phone)) > 0),
  -- Digits-only form of `phone`, stored so the duplicate-phone rule the UI
  -- enforces (customers.js: compares phone.replace(/\D/g,'')) is guaranteed by
  -- the database and cannot be bypassed by an API client.
  phone_digits  TEXT GENERATED ALWAYS AS (
                  replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', '')
                ) STORED,
  alt_phone     TEXT,
  email         TEXT,
  address       TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

CREATE UNIQUE INDEX ux_customers_phone_digits ON customers(phone_digits);
CREATE INDEX ix_customers_name ON customers(name);


-- ---------------------------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------------------------
CREATE TABLE vehicles (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  reg_no            TEXT NOT NULL CHECK (length(trim(reg_no)) > 0),
  brand             TEXT NOT NULL,
  model             TEXT NOT NULL,
  year              INTEGER CHECK (year IS NULL OR (year BETWEEN 1900 AND 2200)),
  color             TEXT,
  vin               TEXT,
  engine_no         TEXT,
  chassis_no        TEXT,
  mileage           INTEGER CHECK (mileage IS NULL OR mileage >= 0),
  fuel_type         TEXT,
  transmission      TEXT,
  next_service_date TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT
);

CREATE UNIQUE INDEX ux_vehicles_reg_no ON vehicles(reg_no);
CREATE INDEX ix_vehicles_customer ON vehicles(customer_id);
CREATE INDEX ix_vehicles_next_service ON vehicles(next_service_date);


-- ---------------------------------------------------------------------------
-- services  (catalogue)
-- ---------------------------------------------------------------------------
CREATE TABLE services (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  category    TEXT,
  description TEXT,
  est_time    INTEGER CHECK (est_time IS NULL OR est_time > 0),
  price       REAL NOT NULL DEFAULT 0 CHECK (price >= 0),
  status      TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);

CREATE INDEX ix_services_status ON services(status);


-- ---------------------------------------------------------------------------
-- mechanics
-- ---------------------------------------------------------------------------
CREATE TABLE mechanics (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone           TEXT NOT NULL,
  alt_phone       TEXT,
  email           TEXT,
  address         TEXT,
  specialization  TEXT,
  experience      INTEGER CHECK (experience IS NULL OR experience >= 0),
  joining_date    TEXT,
  employment_type TEXT,
  salary_type     TEXT,
  salary          REAL CHECK (salary IS NULL OR salary >= 0),
  commission_rate REAL CHECK (commission_rate IS NULL OR (commission_rate BETWEEN 0 AND 100)),
  availability    TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT
);

CREATE INDEX ix_mechanics_status ON mechanics(status);


-- ---------------------------------------------------------------------------
-- parts  (inventory)
-- ---------------------------------------------------------------------------
CREATE TABLE parts (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
  part_no        TEXT,
  category       TEXT,
  brand          TEXT,
  supplier       TEXT,
  location       TEXT,
  unit           TEXT,
  purchase_price REAL NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  selling_price  REAL NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  -- Negative stock is impossible at the database level, matching the guarantee
  -- Utils.Inventory.move() makes in the client today.
  stock          REAL NOT NULL DEFAULT 0 CHECK (stock >= 0),
  min_stock      REAL NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  reorder_qty    REAL CHECK (reorder_qty IS NULL OR reorder_qty >= 0),
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);

-- Mirrors inventory.js: a part number must be unique among ACTIVE parts only,
-- so a deactivated part does not block reusing its number.
CREATE UNIQUE INDEX ux_parts_part_no_active
  ON parts(part_no) WHERE status = 'Active' AND part_no IS NOT NULL AND part_no <> '';
CREATE INDEX ix_parts_status ON parts(status);


-- ---------------------------------------------------------------------------
-- job_cards
-- ---------------------------------------------------------------------------
-- `paid` and `due` here are a FROZEN PRE-INVOICE SNAPSHOT, not a live balance.
-- Once an invoice exists, the invoice carries the current figures (payments are
-- the source of truth). This is the Finding 1 rule: read balances through the
-- invoice when one exists, fall back to this snapshot otherwise, and treat a
-- Cancelled job as owing nothing. Never "sync" these two copies.
CREATE TABLE job_cards (
  id                   TEXT PRIMARY KEY,
  customer_id          TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  vehicle_id           TEXT NOT NULL REFERENCES vehicles(id)  ON DELETE RESTRICT,
  mechanic_id          TEXT NOT NULL REFERENCES mechanics(id) ON DELETE RESTRICT,
  appointment_id       TEXT REFERENCES appointments(id) ON DELETE SET NULL
                         DEFERRABLE INITIALLY DEFERRED,
  invoice_id           TEXT REFERENCES invoices(id) ON DELETE SET NULL
                         DEFERRABLE INITIALLY DEFERRED,

  date                 TEXT NOT NULL,
  est_delivery         TEXT,
  actual_delivery      TEXT,
  completed_at         TEXT,

  status               TEXT NOT NULL DEFAULT 'Received' CHECK (status IN (
                         'Received', 'Inspection', 'Waiting for Approval',
                         'In Progress', 'Waiting for Parts',
                         'Completed', 'Delivered', 'Cancelled')),
  priority             TEXT NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low', 'normal', 'high', 'urgent')),

  mileage              INTEGER CHECK (mileage IS NULL OR mileage >= 0),
  mileage_out          INTEGER CHECK (mileage_out IS NULL OR mileage_out >= 0),
  fuel_level           TEXT CHECK (fuel_level IS NULL OR fuel_level IN
                         ('', 'empty', 'quarter', 'half', 'three-quarter', 'full')),

  complaint            TEXT NOT NULL CHECK (length(trim(complaint)) > 0),
  inspection           TEXT,
  diagnosis            TEXT,
  technician_notes     TEXT,
  recommendations      TEXT,
  condition_notes      TEXT,
  notes                TEXT,
  -- Display-only, never aggregated, so JSON is the right shape here.
  inspection_checklist TEXT,

  labour_hours         REAL CHECK (labour_hours IS NULL OR labour_hours >= 0),
  labour_rate          REAL CHECK (labour_rate IS NULL OR labour_rate >= 0),
  labour_cost          REAL NOT NULL DEFAULT 0 CHECK (labour_cost >= 0),
  discount             REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax_rate             REAL NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  subtotal             REAL NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax                  REAL NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total                REAL NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid                 REAL NOT NULL DEFAULT 0 CHECK (paid >= 0),
  due                  REAL NOT NULL DEFAULT 0 CHECK (due >= 0),

  created_at           TEXT NOT NULL,
  updated_at           TEXT,

  CHECK (mileage_out IS NULL OR mileage IS NULL OR mileage_out >= mileage),
  CHECK (est_delivery IS NULL OR est_delivery = '' OR est_delivery >= date),
  CHECK (discount <= subtotal),
  CHECK (paid <= total)
);

CREATE INDEX ix_jc_customer ON job_cards(customer_id);
CREATE INDEX ix_jc_vehicle  ON job_cards(vehicle_id);
CREATE INDEX ix_jc_mechanic ON job_cards(mechanic_id);
CREATE INDEX ix_jc_status   ON job_cards(status);
CREATE INDEX ix_jc_date     ON job_cards(date);
CREATE UNIQUE INDEX ux_jc_appointment ON job_cards(appointment_id)
  WHERE appointment_id IS NOT NULL;   -- one job card per appointment


-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  vehicle_id    TEXT NOT NULL REFERENCES vehicles(id)  ON DELETE RESTRICT,
  service_id    TEXT NOT NULL REFERENCES services(id)  ON DELETE RESTRICT,
  mechanic_id   TEXT REFERENCES mechanics(id) ON DELETE RESTRICT,
  job_card_id   TEXT REFERENCES job_cards(id) ON DELETE SET NULL
                  DEFERRABLE INITIALLY DEFERRED,

  date          TEXT NOT NULL,
  time          TEXT NOT NULL,
  duration      INTEGER NOT NULL DEFAULT 60 CHECK (duration > 0 AND duration <= 600),

  status        TEXT NOT NULL DEFAULT 'Scheduled' CHECK (status IN (
                  'Scheduled', 'Confirmed', 'In Progress',
                  'Completed', 'Cancelled', 'No Show')),

  -- The five canonical appointment origins. 'Website' is what the public
  -- site's API will send; 'Facebook' covers the Facebook/messenger workflow.
  -- No other value is accepted, from any client.
  source        TEXT NOT NULL DEFAULT 'Admin' CHECK (source IN (
                  'Admin', 'Phone', 'Walk-in', 'Facebook', 'Website')),

  complaint     TEXT,
  notes         TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0 CHECK (reminder_sent IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

CREATE INDEX ix_appt_date_time ON appointments(date, time);
CREATE INDEX ix_appt_customer  ON appointments(customer_id);
CREATE INDEX ix_appt_status    ON appointments(status);
CREATE INDEX ix_appt_source    ON appointments(source);
-- Conflict detection scans a mechanic's and a vehicle's bookings for one day.
CREATE INDEX ix_appt_mechanic_date ON appointments(mechanic_id, date);
CREATE INDEX ix_appt_vehicle_date  ON appointments(vehicle_id, date);


-- ---------------------------------------------------------------------------
-- job card line items
-- ---------------------------------------------------------------------------
-- Separate tables rather than JSON because reports.js aggregates per service
-- and per part; that is a GROUP BY, not a document read. `name` and
-- `unit_price` are SNAPSHOTS taken when the line was added -- a later catalogue
-- price change must never rewrite history, so these are not derived from
-- services/parts at read time.
CREATE TABLE job_card_services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_card_id TEXT NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  service_id  TEXT REFERENCES services(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  qty         REAL NOT NULL CHECK (qty > 0),
  unit_price  REAL NOT NULL CHECK (unit_price >= 0),
  total       REAL NOT NULL CHECK (total >= 0),
  line_no     INTEGER NOT NULL
);

CREATE INDEX ix_jcs_job     ON job_card_services(job_card_id);
CREATE INDEX ix_jcs_service ON job_card_services(service_id);

CREATE TABLE job_card_parts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_card_id TEXT NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  -- NULL means a manual line with no inventory record behind it; such lines
  -- never move stock.
  part_id     TEXT REFERENCES parts(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  part_no     TEXT,
  qty         REAL NOT NULL CHECK (qty > 0),
  unit_price  REAL NOT NULL CHECK (unit_price >= 0),
  total       REAL NOT NULL CHECK (total >= 0),
  line_no     INTEGER NOT NULL
);

CREATE INDEX ix_jcp_job  ON job_card_parts(job_card_id);
CREATE INDEX ix_jcp_part ON job_card_parts(part_id);


-- ---------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------
-- Financial fields are frozen at creation; only `notes` is editable and Void
-- replaces destructive correction. `paid`/`due` are recomputed from non-Void
-- payments while the invoice is live, and frozen once it is Void.
CREATE TABLE invoices (
  id          TEXT PRIMARY KEY,
  job_card_id TEXT REFERENCES job_cards(id) ON DELETE RESTRICT
                DEFERRABLE INITIALLY DEFERRED,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  vehicle_id  TEXT NOT NULL REFERENCES vehicles(id)  ON DELETE RESTRICT,

  date        TEXT NOT NULL,
  labour_cost REAL NOT NULL DEFAULT 0 CHECK (labour_cost >= 0),
  discount    REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax_rate    REAL NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  subtotal    REAL NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax         REAL NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total       REAL NOT NULL CHECK (total >= 0),
  paid        REAL NOT NULL DEFAULT 0 CHECK (paid >= 0),
  due         REAL NOT NULL DEFAULT 0 CHECK (due >= 0),

  status      TEXT NOT NULL CHECK (status IN ('Unpaid', 'Partial', 'Paid', 'Void')),
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT,

  CHECK (paid <= total)
);

-- A job card may have at most ONE live invoice. A Void invoice keeps its
-- job_card_id for history but no longer blocks a corrected invoice -- exactly
-- the rule existingInvoiceFor() implements in invoices.js.
CREATE UNIQUE INDEX ux_invoices_live_job_card
  ON invoices(job_card_id) WHERE status <> 'Void' AND job_card_id IS NOT NULL;
CREATE INDEX ix_invoices_customer ON invoices(customer_id);
CREATE INDEX ix_invoices_status   ON invoices(status);
CREATE INDEX ix_invoices_date     ON invoices(date);

CREATE TABLE invoice_services (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_id TEXT REFERENCES services(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL,
  qty        REAL NOT NULL CHECK (qty > 0),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  total      REAL NOT NULL CHECK (total >= 0),
  line_no    INTEGER NOT NULL
);

CREATE INDEX ix_invs_invoice ON invoice_services(invoice_id);

CREATE TABLE invoice_parts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  part_id    TEXT REFERENCES parts(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL,
  part_no    TEXT,
  qty        REAL NOT NULL CHECK (qty > 0),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  total      REAL NOT NULL CHECK (total >= 0),
  line_no    INTEGER NOT NULL
);

CREATE INDEX ix_invp_invoice ON invoice_parts(invoice_id);


-- ---------------------------------------------------------------------------
-- payments — the source of truth for what has actually been collected
-- ---------------------------------------------------------------------------
-- invoice_id NULL means an ADVANCE: money received with no invoice applied to
-- it yet. Voiding an invoice RELEASES its payments back to advances rather
-- than voiding them (Finding 7) -- the cash arrived, only the document was
-- cancelled. A payment's amount/date/method are immutable once written; Void
-- is the correction mechanism.
CREATE TABLE payments (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  job_card_id TEXT REFERENCES job_cards(id) ON DELETE RESTRICT,

  date        TEXT NOT NULL,
  amount      REAL NOT NULL CHECK (amount > 0),
  method      TEXT NOT NULL CHECK (method IN
                ('Cash', 'Card', 'Mobile Banking', 'Bank Transfer')),
  status      TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Void')),
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);

-- The hot path: every payment write recomputes its invoice's balance from
-- SUM(amount) WHERE invoice_id = ? AND status <> 'Void'.
CREATE INDEX ix_payments_invoice_status ON payments(invoice_id, status);
CREATE INDEX ix_payments_customer ON payments(customer_id);
CREATE INDEX ix_payments_job_card ON payments(job_card_id);
CREATE INDEX ix_payments_date     ON payments(date);
-- Unapplied advances (the "Outstanding Advances" figure).
CREATE INDEX ix_payments_advances ON payments(customer_id)
  WHERE invoice_id IS NULL AND status = 'Active';


-- ---------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------
CREATE TABLE expenses (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  category    TEXT NOT NULL,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  amount      REAL NOT NULL CHECK (amount > 0),
  method      TEXT NOT NULL CHECK (method IN
                ('Cash', 'Card', 'Mobile Banking', 'Bank Transfer')),
  payee       TEXT,
  reference   TEXT,
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Void')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);

CREATE INDEX ix_expenses_date     ON expenses(date);
CREATE INDEX ix_expenses_status   ON expenses(status);
CREATE INDEX ix_expenses_category ON expenses(category);


-- ---------------------------------------------------------------------------
-- inventory_transactions — the stock audit trail
-- ---------------------------------------------------------------------------
-- Append-only. parts.stock is the operational quantity; this table is the
-- ledger that explains it. Every movement writes both, together.
CREATE TABLE inventory_transactions (
  id             TEXT PRIMARY KEY,
  part_id        TEXT NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  type           TEXT NOT NULL CHECK (type IN (
                   -- inbound
                   'purchase', 'adjustment-in', 'return', 'initial-stock',
                   -- outbound
                   'sale', 'job-card-use', 'adjustment-out', 'damaged')),
  quantity       REAL NOT NULL CHECK (quantity > 0),
  unit_cost      REAL CHECK (unit_cost IS NULL OR unit_cost >= 0),
  reference_type TEXT,      -- 'job-card' | 'manual'
  reference_id   TEXT,      -- e.g. JOB-0003
  reason         TEXT,
  notes          TEXT,
  prev_stock     REAL NOT NULL CHECK (prev_stock >= 0),
  new_stock      REAL NOT NULL CHECK (new_stock >= 0),
  created_at     TEXT NOT NULL
);

CREATE INDEX ix_txn_part_created ON inventory_transactions(part_id, created_at);
-- getIssuedQtyForJobPart() / hasJobDeduction(): the basis of every inventory
-- reconciliation, so this composite matters more than it looks.
CREATE INDEX ix_txn_reference ON inventory_transactions(reference_type, reference_id, part_id);
CREATE INDEX ix_txn_type ON inventory_transactions(type);
