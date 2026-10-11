-- ===========================================================================
-- 0004 — job card discount rate
-- ===========================================================================
-- The percentage a 'percent' discount (0003) was given as, 0 to 100. NULL for
-- an 'amount' discount. The server derives `discount` from it and the
-- subtotal, so the rate is what lets a reloaded or edited job card show the
-- percentage again and keep it as the lines change.
--
-- ADDITIVE ONLY: no existing row is updated or deleted; every existing job
-- card receives NULL, matching its 'amount' type. Older Workers never name
-- the column.
-- ===========================================================================

ALTER TABLE job_cards ADD COLUMN discount_rate REAL
  CHECK (discount_rate IS NULL OR (discount_rate >= 0 AND discount_rate <= 100));
