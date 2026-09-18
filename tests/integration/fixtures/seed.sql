INSERT INTO services (id, name, category, description, est_time, price, status, created_at, updated_at) VALUES
  ('SRV-9001','B4 Full Service','Engine','Complete engine overhaul',180,7500.00,'Active','2026-09-10T09:00:00','2026-09-12T11:30:00'),
  ('SRV-9002','B4 Nulls Everywhere',NULL,NULL,NULL,1200.50,'Active','2026-09-11T09:00:00',NULL),
  ('SRV-9003','B4 Tie A','Brake','Same timestamp as Tie B',45,900,'Active','2026-09-12T09:00:00',NULL),
  ('SRV-9004','B4 Tie B','Brake','Same timestamp as Tie A',45,900,'Active','2026-09-12T09:00:00',NULL),
  ('SRV-9005','B4 Retired','Misc','Discontinued line',NULL,0,'Inactive','2026-09-09T09:00:00',NULL),
  ('SRV-9006','B4 Newest','AC','Most recent row',60,2500,'Active','2026-09-13T09:00:00',NULL);

INSERT INTO customers (id, name, phone, alt_phone, email, address, notes, status, created_at, updated_at) VALUES
  ('CUS-9001','B4 Test Customer','01900000001','01900000002','b4@example.test','Dhaka','regression row','Active','2026-09-10T09:00:00','2026-09-12T10:00:00'),
  ('CUS-9002','B4 Sparse Customer','01900000003',NULL,NULL,NULL,NULL,'Active','2026-09-11T09:00:00',NULL);

INSERT INTO vehicles (id, customer_id, reg_no, brand, model, year, color, vin, engine_no, chassis_no, mileage, fuel_type, transmission, next_service_date, notes, status, created_at, updated_at) VALUES
  ('VEH-9001','CUS-9001','B4-TEST-01','Toyota','Corolla',2019,'White','VIN9001','ENG9001','CHS9001',52000,'Petrol','Automatic','2026-12-01','regression row','Active','2026-09-10T09:00:00','2026-09-12T10:00:00'),
  ('VEH-9002','CUS-9002','B4-TEST-02','Honda','Civic',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'Active','2026-09-11T09:00:00',NULL);

INSERT INTO mechanics (id, name, phone, alt_phone, email, address, specialization, experience, joining_date, employment_type, salary_type, salary, commission_rate, availability, notes, status, created_at, updated_at) VALUES
  ('MEC-9001','B5 Full Mechanic','01911000001','01911000002','b5@example.test','Uttara, Dhaka','Engine & Transmission',12,'2021-03-15','Full Time','Monthly',32000,5.5,'Available','regression row','Active','2026-09-10T09:00:00','2026-09-12T10:00:00'),
  ('MEC-9002','B5 Sparse Mechanic','01911000003',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'Active','2026-09-11T09:00:00',NULL),
  ('MEC-9003','B5 Zeroed Mechanic','01911000004',NULL,NULL,NULL,'Brakes & Suspension',0,'2026-01-01','Part Time','Hourly',0,0,'On Leave',NULL,'Inactive','2026-09-09T09:00:00',NULL);

INSERT INTO parts (id, name, part_no, category, brand, supplier, location, unit, purchase_price, selling_price, stock, min_stock, reorder_qty, notes, status, created_at, updated_at) VALUES
  ('PRT-9001','B6 Full Part','B6-OF-001','Filters','Toyota','Dhaka Auto Parts','Rack A2','pc',350,500,18,8,10,'regression row','Active','2026-09-10T09:00:00','2026-09-12T10:00:00'),
  ('PRT-9002','B6 Sparse Part',NULL,NULL,NULL,NULL,NULL,NULL,2200,2800,24,10,NULL,NULL,'Active','2026-09-11T09:00:00',NULL),
  ('PRT-9003','B6 Out Of Stock','B6-SP-003','Engine','NGK','Dhaka Auto Parts','Rack A3','pc',450,650,0,12,0,'','Inactive','2026-09-09T09:00:00',NULL);

-- Appointments reference customers, vehicles and services (all NOT NULL) plus
-- an optional mechanic, so they are inserted after those five tables above.
-- Six rows: all five canonical sources, six different statuses, a sparse row
-- with every nullable column NULL, and date/time edges at both ends of a day.
INSERT INTO appointments (id, customer_id, vehicle_id, service_id, mechanic_id, job_card_id, date, time, duration, status, source, complaint, notes, reminder_sent, created_at, updated_at) VALUES
  ('APT-9001','CUS-9001','VEH-9001','SRV-9001',NULL,NULL,'2026-09-20','00:00',30,'Scheduled','Admin',NULL,NULL,0,'2026-09-10T09:00:00',NULL),
  ('APT-9002','CUS-9001','VEH-9001','SRV-9002','MEC-9001',NULL,'2026-09-21','09:30',60,'Confirmed','Phone','Battery draining overnight','Call before arrival',1,'2026-09-11T09:00:00','2026-09-12T10:00:00'),
  ('APT-9003','CUS-9002','VEH-9002','SRV-9003','MEC-9002',NULL,'2026-09-22','13:45',90,'In Progress','Walk-in','Steering pulls right','',0,'2026-09-12T09:00:00',NULL),
  ('APT-9004','CUS-9002','VEH-9002','SRV-9004','MEC-9001',NULL,'2026-09-23','23:59',120,'Completed','Facebook','Full check before long trip','Linked to a job card',1,'2026-09-13T09:00:00',NULL),
  ('APT-9005','CUS-9001','VEH-9001','SRV-9005','MEC-9003',NULL,'2026-09-24','15:00',45,'Cancelled','Website','Routine oil change','Customer cancelled',0,'2026-09-14T09:00:00',NULL),
  ('APT-9006','CUS-9002','VEH-9002','SRV-9006','MEC-9002',NULL,'2026-09-25','05:30',600,'No Show','Admin','Early slot','',0,'2026-09-15T09:00:00',NULL);

-- Four job cards. Foreign keys point at the customers, vehicles, mechanics and
-- appointments above; invoice_id is filled in afterwards because job_cards and
-- invoices reference each other.
--
--   JOB-9001  everything populated: child lines of both kinds, money, a valid
--             inspection checklist, and both an appointment and an invoice link
--   JOB-9002  no child lines at all, every nullable column NULL
--   JOB-9003  a manual part line (part_id NULL) and mileage 0, which is a real
--             reading and not the same as JOB-9002's unrecorded NULL
--   JOB-9004  a malformed inspection checklist, plus two service lines sharing
--             a line_no so the id tie-break in the ordering is exercised
INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, appointment_id, invoice_id, date, est_delivery, actual_delivery, completed_at, status, priority, mileage, mileage_out, fuel_level, complaint, inspection, diagnosis, technician_notes, recommendations, condition_notes, notes, inspection_checklist, labour_hours, labour_rate, labour_cost, discount, tax_rate, subtotal, tax, total, paid, due, created_at, updated_at) VALUES
  ('JOB-9001','CUS-9002','VEH-9002','MEC-9001','APT-9004',NULL,'2026-09-23','2026-09-24','2026-09-24','2026-09-24T16:00:00','Delivered','high',48200,48260,'half','Full check before long trip','Oil dark, brake pads worn','Oil degraded; pads at 20%','Oil, filter and pads replaced','Air filter at next service','Minor scratch on rear bumper','Customer waited','{"battery":"ok","brakes":"worn","tyres":"ok"}',1.5,400,600,100,5,8000,395,8295,8295,0,'2026-09-13T10:00:00','2026-09-14T11:00:00'),
  ('JOB-9002','CUS-9001','VEH-9001','MEC-9002',NULL,NULL,'2026-09-20',NULL,NULL,NULL,'Received','normal',NULL,NULL,NULL,'AC cooling weak',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0,0,0,0,0,0,0,'2026-09-12T10:00:00',NULL),
  ('JOB-9003','CUS-9001','VEH-9001','MEC-9003',NULL,NULL,'2026-09-21','2026-09-21',NULL,NULL,'In Progress','urgent',0,NULL,'empty','Rattle from underbody','Loose heat shield',NULL,NULL,NULL,NULL,NULL,'{}',NULL,NULL,0,0,0,300,0,300,0,300,'2026-09-11T10:00:00',NULL),
  ('JOB-9004','CUS-9002','VEH-9002','MEC-9002',NULL,NULL,'2026-09-22',NULL,NULL,NULL,'Cancelled','low',12000,NULL,'full','Brake noise','Checked, no fault found',NULL,NULL,NULL,NULL,NULL,'{this is not valid json',NULL,NULL,0,0,0,2400,0,2400,0,0,'2026-09-10T10:00:00',NULL);

-- Child lines. name / part_no / unit_price are HISTORICAL SNAPSHOTS and are
-- written here to differ deliberately from the current catalogue rows above:
-- SRV-9001 is currently 'B4 Full Service' at 7500 and PRT-9001 is currently
-- 'B6 Full Part' / 'B6-OF-001', but these lines record what was actually sold.
INSERT INTO job_card_services (job_card_id, service_id, name, qty, unit_price, total, line_no) VALUES
  ('JOB-9001','SRV-9001','Legacy Full Service (2024 price)',1,4000,4000,1),
  ('JOB-9001','SRV-9002','Brake Pad Replacement',2,1700,3400,2),
  ('JOB-9004','SRV-9003','Diagnostic Check A',1,1200,1200,1),
  ('JOB-9004','SRV-9004','Diagnostic Check B',1,1200,1200,1);

INSERT INTO job_card_parts (job_card_id, part_id, name, part_no, qty, unit_price, total, line_no) VALUES
  ('JOB-9001','PRT-9001','Legacy Oil Filter (2024 label)','LEGACY-OF-001',1,600,600,1),
  ('JOB-9003',NULL,'Custom heat shield bracket (hand cut)','MANUAL-01',2,150,300,1);

-- Four invoices.
--
--   INV-9001  normal, linked to JOB-9001, with service and part lines whose
--             snapshots differ from the current catalogue, and an Active
--             payment against it that the read API must ignore
--   INV-9002  Void, with non-zero paid/due frozen at the moment of voiding and
--             job_card_id already cleared, which is the state voidInvoice()
--             leaves an invoice in; it keeps its lines
--   INV-9003  a manual part line (part_id NULL) and NULL notes
--   INV-9004  no child lines at all, Unpaid
INSERT INTO invoices (id, job_card_id, customer_id, vehicle_id, date, labour_cost, discount, tax_rate, subtotal, tax, total, paid, due, status, notes, created_at, updated_at) VALUES
  ('INV-9001','JOB-9001','CUS-9002','VEH-9002','2026-09-24',600,100,5,8000,395,8295,8295,0,'Paid','Settled on collection','2026-09-24T12:00:00','2026-09-25T09:00:00'),
  ('INV-9002',NULL,'CUS-9001','VEH-9001','2026-09-23',0,0,0,4935,0,4935,3000,1935,'Void',NULL,'2026-09-23T12:00:00',NULL),
  ('INV-9003',NULL,'CUS-9001','VEH-9001','2026-09-22',0,0,0,300,0,300,150,150,'Partial',NULL,'2026-09-22T12:00:00',NULL),
  ('INV-9004',NULL,'CUS-9002','VEH-9002','2026-09-21',0,0,0,1500,0,1500,0,1500,'Unpaid','','2026-09-21T12:00:00',NULL);

-- Invoice lines. name / part_no / unit_price are HISTORICAL SNAPSHOTS of what
-- was billed, written here to differ deliberately from the catalogue rows
-- above: SRV-9001 is currently 'B4 Full Service' at 7500 and PRT-9001 is
-- currently 'B6 Full Part' / 'B6-OF-001'.
INSERT INTO invoice_services (invoice_id, service_id, name, qty, unit_price, total, line_no) VALUES
  ('INV-9001','SRV-9001','Billed Full Service (2024 rate)',1,4000,4000,1),
  ('INV-9001','SRV-9002','Brake Pad Replacement',2,1700,3400,2),
  ('INV-9002','SRV-9003','Voided Diagnostic A',1,1200,1200,1),
  ('INV-9002','SRV-9004','Voided Diagnostic B',1,1200,1200,1);

INSERT INTO invoice_parts (invoice_id, part_id, name, part_no, qty, unit_price, total, line_no) VALUES
  ('INV-9001','PRT-9001','Billed Oil Filter (2024 label)','BILLED-OF-001',1,600,600,1),
  ('INV-9003',NULL,'Custom bracket (hand cut)','MANUAL-01',2,150,300,1);

-- Payments exist only to prove the invoice read API never consults them: the
-- stored paid/due on each invoice above must come back unchanged regardless of
-- what these say. PAY-9002 is a released advance, the state voidInvoice()
-- leaves a payment in (invoice_id NULL, job card inherited).
INSERT INTO payments (id, invoice_id, customer_id, job_card_id, date, amount, method, status, notes, created_at) VALUES
  ('PAY-9001','INV-9001','CUS-9002',NULL,'2026-09-25',8295,'Cash','Active','Full settlement','2026-09-25T09:00:00'),
  ('PAY-9002',NULL,'CUS-9001','JOB-9001','2026-09-23',3000,'Bank Transfer','Active','Released when INV-9002 was voided','2026-09-23T13:00:00'),
  ('PAY-9003','INV-9001','CUS-9002',NULL,'2026-09-25',500,'Card','Void','Keyed twice','2026-09-25T09:30:00');

-- job_cards.invoice_id and invoices.job_card_id point at each other, so the
-- back-reference is set after both rows exist rather than relying on the
-- deferred constraint inside a single statement batch.
UPDATE job_cards SET invoice_id = 'INV-9001' WHERE id = 'JOB-9001';

-- appointments.job_card_id and job_cards.appointment_id point at each other, so
-- the back-reference is set after both rows exist rather than relying on the
-- deferred constraint inside a single statement batch.
UPDATE appointments SET job_card_id = 'JOB-9001' WHERE id = 'APT-9004';
