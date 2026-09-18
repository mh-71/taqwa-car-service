-- Removes every row the integration seed inserts.
--
-- Deletion order is the reverse of insertion so foreign keys never block it:
-- job cards and appointments hold RESTRICT references to customers, vehicles,
-- mechanics and services, so they go first; vehicles reference customers, so
-- they go before customers.
--
-- The `9%` id range is reserved for test fixtures. Real records are numbered
-- from 0001 upward by id_counters, so this can never reach live data unless a
-- collection passes 9000 records -- at which point the fixture ids must move.
-- payments hold RESTRICT references to both invoices and job_cards, so they go
-- before either.
DELETE FROM payments WHERE id LIKE 'PAY-9%';
-- Child lines cascade from their parent, but they are removed explicitly so a
-- partial fixture (lines without their parent) is still cleaned up.
DELETE FROM invoice_services WHERE invoice_id LIKE 'INV-9%';
DELETE FROM invoice_parts    WHERE invoice_id LIKE 'INV-9%';
DELETE FROM job_card_services WHERE job_card_id LIKE 'JOB-9%';
DELETE FROM job_card_parts    WHERE job_card_id LIKE 'JOB-9%';
-- invoices holds a RESTRICT reference to job_cards, so it goes first.
DELETE FROM invoices     WHERE id LIKE 'INV-9%';
DELETE FROM job_cards    WHERE id LIKE 'JOB-9%';
DELETE FROM appointments WHERE id LIKE 'APT-9%';
DELETE FROM vehicles  WHERE id LIKE 'VEH-9%';
DELETE FROM customers WHERE id LIKE 'CUS-9%';
DELETE FROM services  WHERE id LIKE 'SRV-9%';
DELETE FROM mechanics WHERE id LIKE 'MEC-9%';
DELETE FROM parts     WHERE id LIKE 'PRT-9%';
-- expenses have no foreign keys in either direction, so their position here is
-- free; they go last simply to keep the FK-ordered block above unbroken.
DELETE FROM expenses  WHERE id LIKE 'EXP-9%';
