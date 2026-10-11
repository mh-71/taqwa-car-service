-- ===========================================================================
-- 0003 — job card discount type
-- ===========================================================================
-- A job card's discount is either a fixed amount (as before) or a percentage
-- of the subtotal. This column records which. The money itself stays in
-- `discount`, which the server always computes; invoices keep copying that
-- money figure and never read this column.
--
-- ADDITIVE ONLY: no existing row is updated or deleted. Every existing job
-- card receives 'amount', which is exactly how it was saved, so its discount,
-- totals and invoices are unchanged. A Worker built before this migration
-- never names the column, so it keeps working against the migrated schema --
-- which is what makes "migrate, then deploy" safe and a code rollback
-- harmless.
--
-- One ALTER per file: SQLite has no ADD COLUMN IF NOT EXISTS, so a file that
-- fails part-way cannot leave a half-applied pair behind. The rate is 0004.
-- ===========================================================================

ALTER TABLE job_cards ADD COLUMN discount_type TEXT NOT NULL DEFAULT 'amount'
  CHECK (discount_type IN ('amount', 'percent'));
