-- ===========================================================================
-- 0002 — invoice adjustments (write-offs)
-- ===========================================================================
-- A write-off waives part of an invoice's outstanding balance AFTER the
-- invoice was issued. It is not a payment and not a discount:
--
--   * the invoice's total, tax and discount stay exactly as issued;
--   * payments stay the only record of cash received;
--   * the waived amount is recorded here, one row per decision, with the
--     reason, and is reversed by voiding the row -- never by deleting it.
--
-- The invoice keeps a cached `written_off` total next to its cached `paid`,
-- and both are recomputed together from their source rows by the payment and
-- adjustment routes (src/routes/payments.js recomputeInvoice). For an invoice
-- with no active adjustment the recompute is arithmetically identical to the
-- one that ran before this migration.
--
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- No existing row is updated or deleted, and 0001 is untouched. Every
-- existing invoice receives written_off = 0, so its paid, due and status are
-- unchanged. A Worker built before this migration never names the new table
-- or column, so it keeps working against the migrated schema -- which is
-- what makes "migrate, then deploy" safe and a code rollback harmless.
--
-- Statements 1-3 are idempotent (IF NOT EXISTS / OR IGNORE). The ALTER has
-- no IF NOT EXISTS form in SQLite, so it runs last: if anything before it
-- fails, nothing about the invoices table has changed.
-- ===========================================================================


-- 1. The adjustment ledger -------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_adjustments (
  id          TEXT PRIMARY KEY,                      -- 'ADJ-0001', from id_counters
  invoice_id  TEXT NOT NULL REFERENCES invoices(id)  ON DELETE RESTRICT,
  -- Copied from the invoice by the server, never taken from a request.
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  -- One type in the first version. The column exists so a later kind of
  -- adjustment does not need a table rebuild.
  type        TEXT NOT NULL DEFAULT 'write_off' CHECK (type IN ('write_off')),
  amount      REAL NOT NULL CHECK (amount > 0),
  reason      TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  -- YYYY-MM-DD in the WORKSHOP'S calendar (Asia/Dhaka), set by the server.
  date        TEXT NOT NULL,

  -- The invoice's live due immediately before and after this adjustment,
  -- computed by the server inside the same statement. Audit snapshots only:
  -- nothing recomputes from them.
  due_before  REAL NOT NULL CHECK (due_before >= 0),
  due_after   REAL NOT NULL CHECK (due_after >= 0),

  status      TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Void')),
  -- Free text. The workshop shares one login, so this names a person but
  -- does not prove who acted.
  recorded_by TEXT,
  void_reason TEXT,
  voided_at   TEXT,

  created_at  TEXT NOT NULL,
  updated_at  TEXT,

  CHECK (due_after <= due_before),
  -- A reversal always says why and when.
  CHECK (status = 'Active'
         OR (void_reason IS NOT NULL AND length(trim(void_reason)) > 0 AND voided_at IS NOT NULL))
);

-- 2. Indexes ----------------------------------------------------------------
-- The hot path: every recompute sums an invoice's Active adjustments.
CREATE INDEX IF NOT EXISTS ix_adj_invoice_status ON invoice_adjustments(invoice_id, status);
CREATE INDEX IF NOT EXISTS ix_adj_customer       ON invoice_adjustments(customer_id);
CREATE INDEX IF NOT EXISTS ix_adj_date           ON invoice_adjustments(date);

-- 3. The id counter (allocateId('invoiceAdjustments') -> ADJ-0001) ---------
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value)
VALUES ('invoiceAdjustments', 'ADJ', 0);

-- 4. The cached total on the invoice --------------------------------------
-- Recomputed with paid/due/status, never written by a request. Existing rows
-- take the default 0.
ALTER TABLE invoices ADD COLUMN written_off REAL NOT NULL DEFAULT 0 CHECK (written_off >= 0);
