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
-- ---------------------------------------------------------------------------
-- The sweep runs FIRST, and it has to.
-- ---------------------------------------------------------------------------
-- From C-2 the suite POSTs real records, whose ids are allocated rather than
-- chosen and so fall outside the `9%` range the targeted deletes below use.
-- Those real-id rows hold ON DELETE RESTRICT references to the fixtures --
-- an appointment created by a test points at SRV-9001 -- so removing the
-- fixtures while they still exist fails on a foreign key and aborts the whole
-- file, leaving everything behind. Clearing them first makes the targeted
-- deletes below harmless no-ops that still document what the suite inserts.
--
-- run.sh refuses to start unless all of these tables are empty, so anything
-- present here was created by this run and is safe to remove. Order follows
-- the foreign keys.
DELETE FROM payments;
DELETE FROM invoice_services;
DELETE FROM invoice_parts;
DELETE FROM job_card_services;
DELETE FROM job_card_parts;
DELETE FROM invoices;
DELETE FROM job_cards;
DELETE FROM appointments;
DELETE FROM inventory_transactions;
DELETE FROM vehicles;
DELETE FROM customers;
DELETE FROM services;
DELETE FROM mechanics;
DELETE FROM parts;
DELETE FROM expenses;
DELETE FROM settings;

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
-- inventory_transactions holds an ON DELETE RESTRICT reference to parts, so
-- the ledger rows go before the parts they point at.
DELETE FROM inventory_transactions WHERE id LIKE 'STK-9%';
DELETE FROM parts     WHERE id LIKE 'PRT-9%';
-- expenses have no foreign keys in either direction, so their position here is
-- free; they go last simply to keep the FK-ordered block above unbroken.
DELETE FROM expenses  WHERE id LIKE 'EXP-9%';
-- settings is the singleton: CHECK (id = 1) makes a reserved `9%` id range
-- impossible, so this is the one fixture removed by its real id. That is safe
-- only because run.sh refuses to seed unless the table was empty first, so the
-- row deleted here is always the row this suite inserted.
DELETE FROM settings WHERE id = 1;



-- From C-2 the suite POSTs real records, which draw real sequential ids from
-- id_counters. Deleting those rows does not rewind the counters, so they are
-- reset here. This is safe only because run.sh refuses to start unless every
-- counter is already 0 -- so this restores the state the run found, and can
-- never rewind a real shop's sequence.
UPDATE id_counters SET last_value = 0;
