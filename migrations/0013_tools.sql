-- ===========================================================================
-- 0013 — Workshop Assets › Tools & Equipment
-- ---------------------------------------------------------------------------
-- One row per physical tool or piece of equipment (TOL-0001), replacing the
-- demo page's sample list. Additive only: one new table, its indexes and its
-- id counter. Nothing existing is read, altered or dropped.
--
-- Never deleted. A tool that leaves service is RETIRED (status 'Retired',
-- retired_at and retired_reason set) through POST /api/tools/:id/retire, so
-- whatever later refers to it -- maintenance, assignments, history -- keeps a
-- record to point at. The API offers no DELETE.
--
-- Money follows the existing convention (parts.purchase_price, services.price):
-- a REAL amount in taka, never negative.
--
-- Status says whether the tool can be used now; condition says what physical
-- state it is in. The two CHECKs at the end keep them from contradicting each
-- other: a Damaged tool is never Available or In Use, and a usable tool is in
-- at least Fair condition.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS tools (
  id              TEXT PRIMARY KEY,                                  -- 'TOL-0001', from id_counters
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 120),
  category        TEXT NOT NULL CHECK (category IN (
                    'Diagnostic Equipment', 'Engine Tools', 'Electrical Tools', 'AC Service Equipment',
                    'Lifting Equipment', 'Workshop Hand Tools', 'Safety Equipment', 'Cleaning Equipment', 'Other')),
  brand           TEXT CHECK (brand IS NULL OR length(brand) <= 80),
  model           TEXT CHECK (model IS NULL OR length(model) <= 80),
  serial_no       TEXT CHECK (serial_no IS NULL OR (length(trim(serial_no)) > 0 AND length(serial_no) <= 80)),
  purchase_date   TEXT CHECK (purchase_date IS NULL OR purchase_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  purchase_price  REAL CHECK (purchase_price IS NULL OR (purchase_price >= 0 AND purchase_price <= 100000000)),
  supplier        TEXT CHECK (supplier IS NULL OR length(supplier) <= 160),
  warranty_expiry TEXT CHECK (warranty_expiry IS NULL OR warranty_expiry GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  location        TEXT CHECK (location IS NULL OR length(location) <= 80),
  condition       TEXT NOT NULL DEFAULT 'Good' CHECK (condition IN ('Excellent', 'Good', 'Fair', 'Poor', 'Damaged')),
  status          TEXT NOT NULL DEFAULT 'Available'
                    CHECK (status IN ('Available', 'In Use', 'Under Maintenance', 'Damaged', 'Retired')),
  description     TEXT CHECK (description IS NULL OR length(description) <= 500),
  notes           TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  retired_at      TEXT,
  retired_reason  TEXT CHECK (retired_reason IS NULL OR (length(trim(retired_reason)) > 0 AND length(retired_reason) <= 300)),
  created_by      TEXT CHECK (created_by IS NULL OR length(created_by) <= 100),
  updated_by      TEXT CHECK (updated_by IS NULL OR length(updated_by) <= 100),
  created_at      TEXT NOT NULL,
  updated_at      TEXT,

  CHECK (warranty_expiry IS NULL OR purchase_date IS NULL OR warranty_expiry >= purchase_date),
  -- Retired, and only retired, carries when and why.
  CHECK ((status = 'Retired') = (retired_at IS NOT NULL)),
  CHECK ((status = 'Retired') = (retired_reason IS NOT NULL)),
  CHECK (condition <> 'Damaged' OR status IN ('Damaged', 'Under Maintenance', 'Retired')),
  CHECK (status NOT IN ('Available', 'In Use') OR condition IN ('Excellent', 'Good', 'Fair'))
);

-- One serial number per tool still in service, ignoring case. A retired tool's
-- serial may be reused (a warranty replacement often comes back under it).
CREATE UNIQUE INDEX IF NOT EXISTS ux_tools_serial_live
  ON tools(lower(serial_no)) WHERE serial_no IS NOT NULL AND status <> 'Retired';
CREATE INDEX IF NOT EXISTS ix_tools_status   ON tools(status);
CREATE INDEX IF NOT EXISTS ix_tools_category ON tools(category);
CREATE INDEX IF NOT EXISTS ix_tools_name     ON tools(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS ix_tools_created  ON tools(created_at, id);

INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES ('tools', 'TOL', 0);
