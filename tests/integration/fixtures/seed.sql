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

-- One job card, purely so an appointment can be observed in its linked state.
-- No Job Card API exists yet; this row only exists to satisfy the foreign key.
INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, appointment_id, date, status, complaint, created_at) VALUES
  ('JOB-9001','CUS-9002','VEH-9002','MEC-9001','APT-9004','2026-09-23','Received','Full check before long trip','2026-09-13T10:00:00');

-- appointments.job_card_id and job_cards.appointment_id point at each other, so
-- the back-reference is set after both rows exist rather than relying on the
-- deferred constraint inside a single statement batch.
UPDATE appointments SET job_card_id = 'JOB-9001' WHERE id = 'APT-9004';
