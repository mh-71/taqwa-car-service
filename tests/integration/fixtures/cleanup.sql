-- Removes every row the integration seed inserts.
--
-- Deletion order is the reverse of insertion so foreign keys never block it:
-- vehicles reference customers (ON DELETE RESTRICT), so vehicles go first.
--
-- The `9%` id range is reserved for test fixtures. Real records are numbered
-- from 0001 upward by id_counters, so this can never reach live data unless a
-- collection passes 9000 records -- at which point the fixture ids must move.
DELETE FROM vehicles  WHERE id LIKE 'VEH-9%';
DELETE FROM customers WHERE id LIKE 'CUS-9%';
DELETE FROM services  WHERE id LIKE 'SRV-9%';
DELETE FROM mechanics WHERE id LIKE 'MEC-9%';
