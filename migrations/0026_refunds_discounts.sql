-- ===========================================================================
-- 0026 — refunds and post-completion discounts
-- ===========================================================================
-- Two new money records against an issued invoice, each one row per decision,
-- reversed by voiding the row and never by deleting or editing it:
--
--   REFUND (invoice_refunds)
--     Money that was collected and is RETURNED to the customer. It is not a
--     payment and not a discount: payments stay the record of cash received
--     (`paid` is unchanged by a refund), and the invoice's payable amount is
--     unchanged too. A refund never creates a new debt: `due` does not rise
--     because cash was given back. Net cash retained = paid - refunded.
--
--   POST-COMPLETION DISCOUNT (invoice_discounts)
--     A reduction of what the customer owes, decided after the invoice was
--     issued. The invoice's issued total, tax and original discount stay as
--     they were; the discount is recorded here and the server derives
--       payable = total - post_discount
--       due     = payable - paid - written_off   (floored at 0)
--     A discount on an invoice that is already paid leaves a customer
--     CREDIT (paid - refunded - payable). It is never refunded
--     automatically: returning it is an explicit refund.
--
-- Why two new tables rather than invoice_adjustments: that table's
-- `type IN ('write_off')` CHECK cannot be widened in SQLite without
-- rebuilding a production table that already holds financial history. New
-- tables are additive; a rebuild is not.
--
-- The invoice keeps two new cached totals, `post_discount` and `refunded`,
-- next to `paid` and `written_off`, recomputed from the source rows by
-- src/routes/payments.js recomputeInvoice() -- the one home of the formula.
-- For an invoice with no discount and no refund the recompute is
-- arithmetically identical to the one that ran before this migration.
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- No existing row is updated or deleted, and no earlier migration is
-- touched. Every existing invoice receives post_discount = 0 and
-- refunded = 0, so its paid, due and status are unchanged.
--
-- ORDER: apply this migration BEFORE deploying the Worker that reads the new
-- columns. A Worker built before it never names them, so migrating first is
-- safe and a code rollback stays harmless.
--
-- The ALTERs have no IF NOT EXISTS form in SQLite, so they run last: if
-- anything before them fails, nothing about the invoices table has changed.
-- ===========================================================================


-- 1. Refunds ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_refunds (
  id                TEXT PRIMARY KEY,                       -- 'RFD-0001', from id_counters
  invoice_id        TEXT NOT NULL REFERENCES invoices(id)  ON DELETE RESTRICT,
  -- Copied from the invoice by the server, never taken from a request.
  customer_id       TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  amount            REAL NOT NULL CHECK (amount > 0),
  -- The payment methods (payments.method's own CHECK, 0001).
  method            TEXT NOT NULL CHECK (method IN ('Cash', 'Card', 'Mobile Banking', 'Bank Transfer')),
  reason            TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 500),
  notes             TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  -- YYYY-MM-DD in the workshop's calendar (Asia/Dhaka): not in the future and
  -- not before the invoice's own date (checked by the server).
  date              TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- What could still be refunded (paid - earlier Active refunds) immediately
  -- before and after this refund, computed by the server inside the same
  -- statement. Audit snapshots only: nothing recomputes from them.
  refundable_before REAL NOT NULL CHECK (refundable_before >= 0),
  refundable_after  REAL NOT NULL CHECK (refundable_after >= 0),

  status            TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Void')),

  -- WHO, from the authenticated caller (never from the request body).
  created_by_kind   TEXT NOT NULL CHECK (created_by_kind IN ('account', 'passphrase', 'token')),
  created_by_id     TEXT CHECK (created_by_id IS NULL OR created_by_id GLOB 'USR-*'),
  created_by_name   TEXT NOT NULL CHECK (length(created_by_name) BETWEEN 1 AND 100),

  void_reason       TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  voided_at         TEXT,
  voided_by_id      TEXT CHECK (voided_by_id IS NULL OR voided_by_id GLOB 'USR-*'),
  voided_by_name    TEXT CHECK (voided_by_name IS NULL OR length(voided_by_name) BETWEEN 1 AND 100),

  created_at        TEXT NOT NULL,
  updated_at        TEXT,

  CHECK (refundable_after <= refundable_before),
  -- A reversal always says why, when and who.
  CHECK (status = 'Active'
         OR (void_reason IS NOT NULL AND length(trim(void_reason)) > 0
             AND voided_at IS NOT NULL AND voided_by_name IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_refund_invoice_status ON invoice_refunds(invoice_id, status);
CREATE INDEX IF NOT EXISTS ix_refund_customer       ON invoice_refunds(customer_id);
CREATE INDEX IF NOT EXISTS ix_refund_date           ON invoice_refunds(date);


-- 2. Post-completion discounts ----------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_discounts (
  id                TEXT PRIMARY KEY,                       -- 'PCD-0001', from id_counters
  invoice_id        TEXT NOT NULL REFERENCES invoices(id)  ON DELETE RESTRICT,
  customer_id       TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  -- 'amount': a fixed sum. 'percent': `rate` percent of the invoice's issued
  -- total, turned into `amount` by the server (rounded to the paisa).
  discount_type     TEXT NOT NULL CHECK (discount_type IN ('amount', 'percent')),
  rate              REAL CHECK (rate IS NULL OR (rate > 0 AND rate <= 100)),
  amount            REAL NOT NULL CHECK (amount > 0),
  reason            TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 500),
  notes             TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  date              TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- The invoice's payable amount (total - Active post-completion discounts)
  -- immediately before and after. Audit snapshots only.
  payable_before    REAL NOT NULL CHECK (payable_before >= 0),
  payable_after     REAL NOT NULL CHECK (payable_after >= 0),

  status            TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Void')),

  -- WHO approved it: the authenticated caller.
  created_by_kind   TEXT NOT NULL CHECK (created_by_kind IN ('account', 'passphrase', 'token')),
  created_by_id     TEXT CHECK (created_by_id IS NULL OR created_by_id GLOB 'USR-*'),
  created_by_name   TEXT NOT NULL CHECK (length(created_by_name) BETWEEN 1 AND 100),

  void_reason       TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  voided_at         TEXT,
  voided_by_id      TEXT CHECK (voided_by_id IS NULL OR voided_by_id GLOB 'USR-*'),
  voided_by_name    TEXT CHECK (voided_by_name IS NULL OR length(voided_by_name) BETWEEN 1 AND 100),

  created_at        TEXT NOT NULL,
  updated_at        TEXT,

  CHECK (payable_after <= payable_before),
  CHECK ((discount_type = 'percent') = (rate IS NOT NULL)),
  CHECK (status = 'Active'
         OR (void_reason IS NOT NULL AND length(trim(void_reason)) > 0
             AND voided_at IS NOT NULL AND voided_by_name IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_pcd_invoice_status ON invoice_discounts(invoice_id, status);
CREATE INDEX IF NOT EXISTS ix_pcd_customer       ON invoice_discounts(customer_id);
CREATE INDEX IF NOT EXISTS ix_pcd_date           ON invoice_discounts(date);


-- 3. The id counters ---------------------------------------------------------
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES ('invoiceRefunds', 'RFD', 0);
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES ('invoiceDiscounts', 'PCD', 0);


-- 4. Permissions (lib/permissions.js: refunds.*, discounts.*) -----------------
-- Sensitive money operations, so they are NOT given to every role. Super
-- Admin needs no rows (full access). Admin and Accountant receive them only
-- while they still hold invoices.manage (void invoices, write off balances) --
-- a role the owner has narrowed is not widened. Manager may only see them.
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT rp.role_id, p.permission
    FROM role_permissions rp
    JOIN (SELECT 'refunds.view' AS permission UNION ALL SELECT 'refunds.create' UNION ALL SELECT 'refunds.manage'
          UNION ALL SELECT 'discounts.view' UNION ALL SELECT 'discounts.create' UNION ALL SELECT 'discounts.manage') p
   WHERE rp.permission = 'invoices.manage' AND rp.role_id IN ('ROL-0002', 'ROL-0004');
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT rp.role_id, p.permission
    FROM role_permissions rp
    JOIN (SELECT 'refunds.view' AS permission UNION ALL SELECT 'discounts.view') p
   WHERE rp.permission = 'invoices.view' AND rp.role_id = 'ROL-0003';


-- 5. The cached totals on the invoice ------------------------------------------
-- Recomputed with paid/written_off/due/status, never written by a request.
ALTER TABLE invoices ADD COLUMN post_discount REAL NOT NULL DEFAULT 0 CHECK (post_discount >= 0);
ALTER TABLE invoices ADD COLUMN refunded      REAL NOT NULL DEFAULT 0 CHECK (refunded >= 0);
