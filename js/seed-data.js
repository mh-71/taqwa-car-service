/* ============================================================
   seed-data.js — Realistic demo data, loaded once on first run
   ============================================================ */

const SeedData = (() => {

  // Dates relative to "today" so the dashboard is always populated
  const today = new Date();
  const iso = (daysAgo, h = 10, m = 0) => {
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const dateOnly = daysAgo => iso(daysAgo).slice(0, 10);

  function load(db) {
    /* ---------- customers ---------- */
    const customers = [
      { id: 'CUS-0001', name: 'Rahim Ahmed',   phone: '01711-234567', altPhone: '', email: 'rahim.ahmed@gmail.com', address: 'House 12, Road 5, Dhanmondi, Dhaka', notes: 'Prefers morning appointments', createdAt: iso(120) },
      { id: 'CUS-0002', name: 'Karim Hossain', phone: '01812-345678', altPhone: '01912-345678', email: 'karim.h@yahoo.com', address: 'Block C, Bashundhara R/A, Dhaka', notes: '', createdAt: iso(95) },
      { id: 'CUS-0003', name: 'Hasan Mahmud',  phone: '01913-456789', altPhone: '', email: 'hasan.mahmud@outlook.com', address: 'Sector 7, Uttara, Dhaka', notes: 'Corporate client — Mahmud Traders', createdAt: iso(60) },
      { id: 'CUS-0004', name: 'Nusrat Jahan',  phone: '01614-567890', altPhone: '', email: 'nusrat.j@gmail.com', address: 'Green Road, Farmgate, Dhaka', notes: '', createdAt: iso(30) },
      { id: 'CUS-0005', name: 'Shafiq Islam',  phone: '01515-678901', altPhone: '', email: '', address: 'Mirpur 10, Dhaka', notes: 'Referred by Rahim Ahmed', createdAt: iso(14) }
    ];

    /* ---------- vehicles ---------- */
    const vehicles = [
      { id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHAKA-METRO-GA-1234', brand: 'Toyota', model: 'Corolla', year: 2019, color: 'Silver', vin: 'JTDBR32E940051234', engineNo: '2ZR-8845121', mileage: 48200, fuelType: 'Octane', transmission: 'Automatic', status: 'Active', nextServiceDate: dateOnly(-45), chassisNo: '', notes: '', createdAt: iso(120) },
      { id: 'VEH-0002', customerId: 'CUS-0002', regNo: 'DHAKA-METRO-KHA-5678', brand: 'Honda', model: 'Civic', year: 2021, color: 'White', vin: '2HGFC2F59MH512345', engineNo: 'L15B7-3312456', mileage: 26500, fuelType: 'Octane', transmission: 'CVT', status: 'Active', nextServiceDate: dateOnly(-90), chassisNo: '', notes: '', createdAt: iso(95) },
      { id: 'VEH-0003', customerId: 'CUS-0003', regNo: 'DHAKA-METRO-GA-9012', brand: 'Nissan', model: 'X-Trail', year: 2018, color: 'Black', vin: 'JN1TBNT32A0061234', engineNo: 'MR20-7781234', mileage: 71800, fuelType: 'Petrol', transmission: 'CVT', status: 'Active', nextServiceDate: dateOnly(5), chassisNo: '', notes: 'AC needs periodic check', createdAt: iso(60) },
      { id: 'VEH-0004', customerId: 'CUS-0004', regNo: 'DHAKA-METRO-CHA-3456', brand: 'Toyota', model: 'Axio', year: 2017, color: 'Pearl White', vin: 'NZE1614412345', engineNo: '1NZ-9912345', mileage: 89400, fuelType: 'CNG + Octane', transmission: 'Automatic', status: 'Active', nextServiceDate: '', chassisNo: 'NZE161-4412345', notes: '', createdAt: iso(30) },
      { id: 'VEH-0005', customerId: 'CUS-0005', regNo: 'DHAKA-METRO-GA-7890', brand: 'Mitsubishi', model: 'Pajero Sport', year: 2016, color: 'Grey', vin: 'MMBGNKS10GH012345', engineNo: '4D56-5567890', mileage: 112300, fuelType: 'Diesel', transmission: 'Manual', status: 'Active', nextServiceDate: dateOnly(-30), chassisNo: '', notes: '', createdAt: iso(14) }
    ];

    /* ---------- service catalog ---------- */
    const services = [
      { id: 'SRV-0001', name: 'Engine Oil Change',      category: 'Engine',       description: 'Drain and replace engine oil, includes oil filter check', estTime: 45, price: 800,  status: 'Active', createdAt: iso(127) },
      { id: 'SRV-0002', name: 'Engine Tune-Up',         category: 'Engine',       description: 'Spark plugs, throttle body cleaning, idle adjustment', estTime: 120, price: 3500, status: 'Active', createdAt: iso(124) },
      { id: 'SRV-0003', name: 'Brake Service',          category: 'Brakes',       description: 'Brake pad inspection/replacement, disc check, fluid top-up', estTime: 90, price: 1500, status: 'Active', createdAt: iso(121) },
      { id: 'SRV-0004', name: 'AC Service',             category: 'Climate',      description: 'Gas refill, compressor check, cabin filter cleaning', estTime: 120, price: 2500, status: 'Active', createdAt: iso(118) },
      { id: 'SRV-0005', name: 'Wheel Alignment',        category: 'Wheels',       description: 'Computerized 4-wheel alignment', estTime: 60, price: 1200, status: 'Active', createdAt: iso(115) },
      { id: 'SRV-0006', name: 'Wheel Balancing',        category: 'Wheels',       description: 'Balancing of all four wheels with weights', estTime: 45, price: 1000, status: 'Active', createdAt: iso(112) },
      { id: 'SRV-0007', name: 'Battery Check',          category: 'Electrical',   description: 'Load test, terminal cleaning, charging system check', estTime: 30, price: 300,  status: 'Active', createdAt: iso(109) },
      { id: 'SRV-0008', name: 'Suspension Repair',      category: 'Suspension',   description: 'Shock absorber and bushing inspection/repair', estTime: 180, price: 4500, status: 'Active', createdAt: iso(106) },
      { id: 'SRV-0009', name: 'Transmission Service',   category: 'Transmission', description: 'ATF change, filter replacement', estTime: 150, price: 5000, status: 'Active', createdAt: iso(103) },
      { id: 'SRV-0010', name: 'Full Vehicle Inspection',category: 'Inspection',   description: '50-point complete vehicle health check', estTime: 120, price: 2000, status: 'Active', createdAt: iso(100) },
      { id: 'SRV-0011', name: 'Computer Diagnosis',     category: 'Inspection',   description: 'OBD-II scan, fault code reading and reset', estTime: 45, price: 1000, status: 'Active', createdAt: iso(90) },
      { id: 'SRV-0012', name: 'Brake Pad Replacement',  category: 'Brakes',       description: 'Front or rear brake pad replacement (parts extra)', estTime: 60, price: 900, status: 'Active', createdAt: iso(85) }
    ];

    /* ---------- mechanics ---------- */
    const mechanics = [
      { id: 'MEC-0001', name: 'Abdul Karim',  phone: '01777-111222', altPhone: '', email: 'abdul.karim@taqwaauto.com', address: 'Mirpur 12, Dhaka', specialization: 'Engine & Transmission', experience: 12, joiningDate: '2021-03-15', employmentType: 'Full Time', salaryType: 'Monthly', salary: 32000, commissionRate: 5, status: 'Active', availability: 'Available', notes: 'Senior mechanic', createdAt: iso(200) },
      { id: 'MEC-0002', name: 'Sohel Rana',   phone: '01888-222333', altPhone: '', email: '', address: 'Kafrul, Dhaka', specialization: 'Electrical & AC', experience: 6, joiningDate: '2022-07-01', employmentType: 'Full Time', salaryType: 'Monthly', salary: 24000, commissionRate: 3, status: 'Active', availability: 'Available', notes: '', createdAt: iso(180) },
      { id: 'MEC-0003', name: 'Imran Hossain',phone: '01999-333444', altPhone: '', email: '', address: 'Pallabi, Dhaka', specialization: 'Brakes & Suspension', experience: 4, joiningDate: '2023-01-10', employmentType: 'Full Time', salaryType: 'Monthly', salary: 20000, commissionRate: 3, status: 'Active', availability: 'Available', notes: '', createdAt: iso(160) }
    ];

    /* ---------- parts inventory ---------- */
    const parts = [
      { id: 'PRT-0001', name: 'Engine Oil 5W-30 (4L)', partNo: 'EO-5W30-4L', category: 'Lubricants', brand: 'Mobil',   supplier: 'Dhaka Auto Parts', purchasePrice: 2200, sellingPrice: 2800, stock: 24, minStock: 10, unit: 'can',  status: 'Active', reorderQty: 10, notes: '', createdAt: iso(145), location: 'Rack A1' },
      { id: 'PRT-0002', name: 'Oil Filter',             partNo: 'OF-TYT-90915', category: 'Filters',   brand: 'Toyota',  supplier: 'Dhaka Auto Parts', purchasePrice: 350,  sellingPrice: 500,  stock: 18, minStock: 8,  unit: 'pc',   status: 'Active', reorderQty: 10, notes: '', createdAt: iso(140), location: 'Rack A2' },
      { id: 'PRT-0003', name: 'Air Filter',             partNo: 'AF-HND-17220', category: 'Filters',   brand: 'Honda',   supplier: 'Motor Bhaban',     purchasePrice: 600,  sellingPrice: 850,  stock: 6,  minStock: 8,  unit: 'pc',   status: 'Active', reorderQty: 10, notes: '', createdAt: iso(135), location: 'Rack A2' },
      { id: 'PRT-0004', name: 'Brake Pad Set (Front)',  partNo: 'BP-FR-D1234',  category: 'Brakes',    brand: 'Bendix',  supplier: 'Motor Bhaban',     purchasePrice: 1800, sellingPrice: 2500, stock: 9,  minStock: 5,  unit: 'set',  status: 'Active', reorderQty: 10, notes: '', createdAt: iso(130), location: 'Rack B1' },
      { id: 'PRT-0005', name: 'AC Refrigerant R134a',   partNo: 'AC-R134A',     category: 'Climate',   brand: 'DuPont',  supplier: 'Cool Air BD',      purchasePrice: 900,  sellingPrice: 1300, stock: 3,  minStock: 6,  unit: 'can',  status: 'Active', reorderQty: 10, notes: '', createdAt: iso(125), location: 'Rack C1' },
      { id: 'PRT-0006', name: 'Battery 12V 65Ah',       partNo: 'BAT-65AH',     category: 'Electrical',brand: 'Hamko',   supplier: 'Hamko Dealer',     purchasePrice: 6500, sellingPrice: 8200, stock: 4,  minStock: 3,  unit: 'pc',   status: 'Active', reorderQty: 10, notes: '', createdAt: iso(120), location: 'Floor D' },
      { id: 'PRT-0007', name: 'Spark Plug (Iridium)',   partNo: 'SP-IR-NGK',    category: 'Engine',    brand: 'NGK',     supplier: 'Dhaka Auto Parts', purchasePrice: 450,  sellingPrice: 650,  stock: 0,  minStock: 12, unit: 'pc',   status: 'Active', reorderQty: 10, notes: '', createdAt: iso(115), location: 'Rack A3' },
      { id: 'PRT-0008', name: 'Cabin Filter',           partNo: 'CF-UNI-01',    category: 'Filters',   brand: 'Denso',   supplier: 'Cool Air BD',      purchasePrice: 400,  sellingPrice: 600,  stock: 14, minStock: 6,  unit: 'pc',   status: 'Active', reorderQty: 10, notes: '', createdAt: iso(110), location: 'Rack A2' }
    ];

    /* ---------- job cards ---------- */
    const jobCards = [
      {
        id: 'JOB-0001', date: dateOnly(6), customerId: 'CUS-0001', vehicleId: 'VEH-0001', mileage: 48200,
        complaint: 'Engine oil change due, slight vibration at idle',
        inspection: 'Oil dark, air filter dirty. Recommended oil + filter change.',
        mechanicId: 'MEC-0001',
        services: [{ serviceId: 'SRV-0001', name: 'Engine Oil Change', qty: 1, unitPrice: 800, total: 800 }],
        partsUsed: [
          { partId: 'PRT-0001', name: 'Engine Oil 5W-30 (4L)', partNo: 'EO-5W30-4L', qty: 1, unitPrice: 2800, total: 2800 },
          { partId: 'PRT-0002', name: 'Oil Filter', partNo: 'OF-TYT-90915', qty: 1, unitPrice: 500, total: 500 }
        ],
        labourCost: 0, discount: 100, taxRate: 5, subtotal: 4100, tax: 200, total: 4200, paid: 4200, due: 0,
        priority: 'normal', appointmentId: null, invoiceId: 'INV-0001', fuelLevel: 'half', mileageOut: 48210, diagnosis: 'Oil degraded; filter clogged.', technicianNotes: 'Oil + filter replaced, idle smooth after change.', recommendations: 'Air filter replacement suggested at next service.', conditionNotes: '', completedAt: iso(6, 16),
        estDelivery: dateOnly(6), actualDelivery: dateOnly(6), status: 'Delivered'
      },
      {
        id: 'JOB-0002', date: dateOnly(3), customerId: 'CUS-0002', vehicleId: 'VEH-0002', mileage: 26500,
        complaint: 'AC cooling weak',
        inspection: 'Refrigerant low, cabin filter clogged.',
        mechanicId: 'MEC-0002',
        services: [{ serviceId: 'SRV-0004', name: 'AC Service', qty: 1, unitPrice: 2500, total: 2500 }],
        partsUsed: [
          { partId: 'PRT-0005', name: 'AC Refrigerant R134a', partNo: 'AC-R134A', qty: 1, unitPrice: 1300, total: 1300 },
          { partId: 'PRT-0008', name: 'Cabin Filter', partNo: 'CF-UNI-01', qty: 1, unitPrice: 600, total: 600 }
        ],
        labourCost: 300, discount: 0, taxRate: 5, subtotal: 4700, tax: 235, total: 4935, paid: 3000, due: 1935,
        priority: 'normal', appointmentId: null, invoiceId: 'INV-0002', fuelLevel: 'quarter', mileageOut: 26510, diagnosis: 'Low refrigerant, clogged cabin filter.', technicianNotes: 'Gas refilled to spec, filter replaced.', recommendations: 'Check compressor belt in 6 months.', conditionNotes: 'Small scratch on rear bumper (pre-existing).', completedAt: iso(2, 17),
        estDelivery: dateOnly(2), actualDelivery: dateOnly(2), status: 'Delivered'
      },
      {
        id: 'JOB-0003', date: dateOnly(1), customerId: 'CUS-0003', vehicleId: 'VEH-0003', mileage: 71800,
        complaint: 'Squealing noise when braking, pulls slightly left',
        inspection: 'Front brake pads worn below limit. Alignment off.',
        mechanicId: 'MEC-0003',
        services: [
          { serviceId: 'SRV-0003', name: 'Brake Service', qty: 1, unitPrice: 1500, total: 1500 },
          { serviceId: 'SRV-0005', name: 'Wheel Alignment', qty: 1, unitPrice: 1200, total: 1200 }
        ],
        partsUsed: [{ partId: 'PRT-0004', name: 'Brake Pad Set (Front)', partNo: 'BP-FR-D1234', qty: 1, unitPrice: 2500, total: 2500 }],
        labourCost: 500, discount: 200, taxRate: 5, subtotal: 5700, tax: 275, total: 5775, paid: 2000, due: 3775,
        priority: 'high', appointmentId: null, invoiceId: null, fuelLevel: 'half', mileageOut: null, diagnosis: 'Front pads below 2mm, toe misaligned.', technicianNotes: '', recommendations: '', conditionNotes: '', completedAt: null,
        estDelivery: dateOnly(0), actualDelivery: '', status: 'In Progress'
      },
      {
        id: 'JOB-0004', date: dateOnly(0), customerId: 'CUS-0004', vehicleId: 'VEH-0004', mileage: 89400,
        complaint: 'Full service before long trip',
        inspection: 'Pending inspection.',
        mechanicId: 'MEC-0001',
        services: [{ serviceId: 'SRV-0010', name: 'Full Vehicle Inspection', qty: 1, unitPrice: 2000, total: 2000 }],
        partsUsed: [],
        labourCost: 0, discount: 0, taxRate: 5, subtotal: 2000, tax: 100, total: 2100, paid: 0, due: 2100,
        priority: 'normal', appointmentId: 'APT-0003', invoiceId: null, fuelLevel: 'three-quarter', mileageOut: null, diagnosis: '', technicianNotes: '', recommendations: '', conditionNotes: 'Child seat in rear — do not remove.', completedAt: null,
        estDelivery: dateOnly(-1), actualDelivery: '', status: 'Inspection'
      },
      {
        id: 'JOB-0005', date: dateOnly(0), customerId: 'CUS-0005', vehicleId: 'VEH-0005', mileage: 112300,
        complaint: 'Hard gear shifts, delayed engagement',
        inspection: 'ATF dark and burnt smell. Transmission service required.',
        mechanicId: 'MEC-0001',
        services: [{ serviceId: 'SRV-0009', name: 'Transmission Service', qty: 1, unitPrice: 5000, total: 5000 }],
        partsUsed: [],
        labourCost: 0, discount: 0, taxRate: 5, subtotal: 5000, tax: 250, total: 5250, paid: 5250, due: 0,
        priority: 'urgent', appointmentId: null, invoiceId: 'INV-0003', fuelLevel: 'full', mileageOut: null, diagnosis: 'ATF burnt; service required.', technicianNotes: 'ATF replaced once stock arrived; shifts smooth on test drive.', recommendations: '', conditionNotes: '', completedAt: iso(0, 14),
        estDelivery: dateOnly(-2), actualDelivery: dateOnly(0), status: 'Delivered'
      }
    ];

    /* ---------- appointments (some today) ---------- */
    const appointments = [
      { id: 'APT-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', serviceId: 'SRV-0007', date: dateOnly(0),  time: '10:00', duration: 30,  mechanicId: 'MEC-0002', complaint: 'Battery draining overnight', notes: '', status: 'Confirmed',   reminderSent: false, jobCardId: null, createdAt: iso(3) },
      { id: 'APT-0002', customerId: 'CUS-0002', vehicleId: 'VEH-0002', serviceId: 'SRV-0005', date: dateOnly(0),  time: '12:30', duration: 60,  mechanicId: 'MEC-0003', complaint: 'Steering pulls right on highway', notes: '', status: 'Scheduled', reminderSent: false, jobCardId: null, createdAt: iso(2) },
      { id: 'APT-0003', customerId: 'CUS-0004', vehicleId: 'VEH-0004', serviceId: 'SRV-0010', date: dateOnly(0),  time: '09:00', duration: 120, mechanicId: 'MEC-0001', complaint: 'Full check before long trip', notes: 'Arrived on time', status: 'Confirmed', reminderSent: true, jobCardId: 'JOB-0004', createdAt: iso(4) },
      { id: 'APT-0004', customerId: 'CUS-0003', vehicleId: 'VEH-0003', serviceId: 'SRV-0004', date: dateOnly(-2), time: '11:00', duration: 90,  mechanicId: 'MEC-0002', complaint: 'AC cooling dropped again', notes: 'Follow-up visit', status: 'Confirmed', reminderSent: false, jobCardId: null, createdAt: iso(1) },
      { id: 'APT-0005', customerId: 'CUS-0005', vehicleId: 'VEH-0005', serviceId: 'SRV-0001', date: dateOnly(4),  time: '15:00', duration: 45,  mechanicId: 'MEC-0001', complaint: 'Routine oil change', notes: '', status: 'Completed', reminderSent: true, jobCardId: null, createdAt: iso(6) }
    ];

    /* ---------- invoices ---------- */
    // Structurally match createInvoiceFromJobCard()'s output shape exactly:
    // services/partsUsed are historical snapshots copied from the linked Job
    // Card at seed time (never re-derived from the live catalog), plus
    // labourCost/taxRate/notes/createdAt alongside the existing totals.
    const invoices = [
      {
        id: 'INV-0001', jobCardId: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', date: dateOnly(6),
        services: [{ serviceId: 'SRV-0001', name: 'Engine Oil Change', qty: 1, unitPrice: 800, total: 800 }],
        partsUsed: [
          { partId: 'PRT-0001', name: 'Engine Oil 5W-30 (4L)', partNo: 'EO-5W30-4L', qty: 1, unitPrice: 2800, total: 2800 },
          { partId: 'PRT-0002', name: 'Oil Filter', partNo: 'OF-TYT-90915', qty: 1, unitPrice: 500, total: 500 }
        ],
        labourCost: 0, discount: 100, taxRate: 5, subtotal: 4100, tax: 200, total: 4200, paid: 4200, due: 0,
        status: 'Paid', notes: '', createdAt: iso(6, 16)
      },
      {
        id: 'INV-0002', jobCardId: 'JOB-0002', customerId: 'CUS-0002', vehicleId: 'VEH-0002', date: dateOnly(2),
        services: [{ serviceId: 'SRV-0004', name: 'AC Service', qty: 1, unitPrice: 2500, total: 2500 }],
        partsUsed: [
          { partId: 'PRT-0005', name: 'AC Refrigerant R134a', partNo: 'AC-R134A', qty: 1, unitPrice: 1300, total: 1300 },
          { partId: 'PRT-0008', name: 'Cabin Filter', partNo: 'CF-UNI-01', qty: 1, unitPrice: 600, total: 600 }
        ],
        labourCost: 300, discount: 0, taxRate: 5, subtotal: 4700, tax: 235, total: 4935, paid: 3000, due: 1935,
        status: 'Partial', notes: '', createdAt: iso(2, 17)
      },
      {
        id: 'INV-0003', jobCardId: 'JOB-0005', customerId: 'CUS-0005', vehicleId: 'VEH-0005', date: dateOnly(0),
        services: [{ serviceId: 'SRV-0009', name: 'Transmission Service', qty: 1, unitPrice: 5000, total: 5000 }],
        partsUsed: [],
        labourCost: 0, discount: 0, taxRate: 5, subtotal: 5000, tax: 250, total: 5250, paid: 5250, due: 0,
        status: 'Paid', notes: '', createdAt: iso(0, 14)
      }
    ];

    /* ---------- payments ---------- */
    // Structurally match what payments.js will produce for a real recorded
    // payment: explicit status (for the Void/Active model) and jobCardId
    // (kept for context even once linked to an invoice). invoiceId uses null
    // for "no invoice yet", matching the rest of the codebase's convention
    // for empty relations (mechanicId, appointmentId, etc.).
    const payments = [
      { id: 'PAY-0001', invoiceId: 'INV-0001', customerId: 'CUS-0001', jobCardId: 'JOB-0001', date: dateOnly(6), amount: 4200, method: 'Cash', notes: '', status: 'Active', createdAt: iso(6, 16) },
      { id: 'PAY-0002', invoiceId: 'INV-0002', customerId: 'CUS-0002', jobCardId: 'JOB-0002', date: dateOnly(2), amount: 3000, method: 'Mobile Banking', notes: 'bKash — advance', status: 'Active', createdAt: iso(2, 17) },
      { id: 'PAY-0003', invoiceId: 'INV-0003', customerId: 'CUS-0005', jobCardId: 'JOB-0005', date: dateOnly(0), amount: 5250, method: 'Card', notes: '', status: 'Active', createdAt: iso(0, 14) },
      { id: 'PAY-0004', invoiceId: null,        customerId: 'CUS-0003', jobCardId: 'JOB-0003', date: dateOnly(1), amount: 2000, method: 'Cash', notes: 'Advance for JOB-0003', status: 'Active', createdAt: iso(1, 11) }
    ];

    /* ---------- expenses ---------- */
    // Normalized to the same shape expenses.js will produce for a newly
    // created expense: explicit status, payee/reference (empty where not
    // recorded), createdAt, and `method` standardized to the same fixed
    // list Payments uses ('Bank' -> 'Bank Transfer'). No amounts changed.
    const expenses = [
      { id: 'EXP-0001', date: dateOnly(8), category: 'Parts Purchase', description: 'Engine oil restock — 12 cans', amount: 26400, method: 'Bank Transfer', payee: 'Dhaka Auto Parts', reference: '', notes: '', status: 'Active', createdAt: iso(8) },
      { id: 'EXP-0002', date: dateOnly(5), category: 'Electricity',    description: 'Monthly electricity bill', amount: 8500, method: 'Mobile Banking', payee: '', reference: '', notes: '', status: 'Active', createdAt: iso(5) },
      { id: 'EXP-0003', date: dateOnly(1), category: 'Tools',          description: 'Torque wrench replacement', amount: 4200, method: 'Cash', payee: '', reference: '', notes: '', status: 'Active', createdAt: iso(1) },
      { id: 'EXP-0004', date: dateOnly(0), category: 'Transport',      description: 'Parts pickup from Motor Bhaban', amount: 600, method: 'Cash', payee: '', reference: '', notes: '', status: 'Active', createdAt: iso(0) }
    ];

    /* ---------- write everything ---------- */
    // Initial-stock audit transactions for seeded parts.
    // NOTE: seeded historical job cards are treated as ALREADY settled —
    // their parts are NOT retro-deducted (stock figures above are current).
    const inventoryTransactions = parts.map((p, i) => ({
      id: 'STK-' + String(i + 1).padStart(4, '0'),
      partId: p.id, type: 'initial-stock', quantity: p.stock,
      unitCost: p.purchasePrice, referenceType: 'manual', referenceId: null,
      prevStock: 0, newStock: p.stock,
      notes: 'Opening stock', createdAt: p.createdAt
    }));

    db.saveData('customers', customers);
    db.saveData('vehicles', vehicles);
    db.saveData('services', services);
    db.saveData('mechanics', mechanics);
    db.saveData('parts', parts);
    db.saveData('jobCards', jobCards);
    db.saveData('appointments', appointments);
    db.saveData('invoices', invoices);
    db.saveData('payments', payments);
    db.saveData('expenses', expenses);
    db.saveData('inventoryTransactions', inventoryTransactions);

    // sync id counters so new records continue the sequence
    const counters = {
      customers: 5, vehicles: 5, appointments: 5, jobCards: 5, services: 12,
      mechanics: 3, parts: 8, invoices: 3, payments: 4, expenses: 4, inventoryTransactions: 8
    };
    localStorage.setItem('taqwa_counters', JSON.stringify(counters));
  }

  return { load };
})();
