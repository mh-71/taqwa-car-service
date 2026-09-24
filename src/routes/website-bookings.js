/* ============================================================
   routes/website-bookings.js — POST /api/website-bookings
   ============================================================
   Endpoint for receiving booking submissions from the website.

   This is the sync point between the public website booking form
   and the dashboard's appointment system. The website creates
   bookings in its own D1, then POSTs them here with a shared secret.

   This route:
   1. Validates the Authorization header with timing-safe comparison
   2. Validates and normalizes the booking payload
   3. Finds or creates customer by normalized phone number
   4. Finds or creates vehicle by normalized registration number
   5. Creates an appointment linked to customer, vehicle, and service
   6. Returns 201 with the appointment ID, or 4xx/5xx on error

   SECURITY:
   - All queries use prepared statements (.bind())
   - NO string concatenation in SQL
   - Timing-safe comparison for secret
   - SQL injection in text fields safely handled (stored as-is, escaped on read)
   - Returns generic 401/403 on auth failure (no details)
============================================================ */

import { readJsonBody } from '../lib/write.js';
import { ok, fail, conflict, unprocessable } from '../lib/http.js';
import { allocateId } from '../lib/write.js';

/* ---------------------------------------------------------------
   Timing-safe comparison (match auth.js pattern)
   --------------------------------------------------------------- */

function constantTimeEqual(supplied, expected) {
  const encoder = new TextEncoder();
  const a = encoder.encode(supplied);
  const b = encoder.encode(expected);

  if (a.length !== b.length) return false;
  if (a.length === 0) return false;

  if (typeof crypto?.subtle?.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------------------------------------------------------------
   Authentication
   --------------------------------------------------------------- */

/**
 * Check Authorization: Bearer <SECRET> header.
 * Returns error Response if auth fails, null if valid.
 */
function checkWebsiteBookingAuth(request, env) {
  const secret = env.WEBSITE_BOOKING_SYNC_SECRET;
  if (!secret || typeof secret !== 'string' || secret.trim() === '') {
    console.error('[Website Booking] WEBSITE_BOOKING_SYNC_SECRET not configured');
    return fail('auth_not_configured', 'Server not configured for website bookings.', 503);
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return fail('unauthorized', 'Missing authentication.', 401);
  }

  const match = /^Bearer +(.+)$/i.exec(authHeader);
  if (!match) {
    return fail('unauthorized', 'Invalid authorization format.', 401);
  }

  if (!constantTimeEqual(match[1], secret.trim())) {
    return fail('unauthorized', 'Invalid credentials.', 401);
  }

  return null;
}

/* ---------------------------------------------------------------
   Validation
   --------------------------------------------------------------- */

/**
 * Normalize phone: remove all non-digits.
 * Used for finding existing customers by phone.
 */
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Normalize registration number: trim and uppercase.
 * Used for finding existing vehicles by registration.
 */
function normalizeRegNumber(regNo) {
  return (String(regNo || '').trim()).toUpperCase();
}

/**
 * Validate request body and normalize fields.
 * Returns { error: string } or { value: normalized payload }
 */
function validateBookingPayload(body) {
  // Required fields
  const name = (body.name || '').trim();
  if (!name || name.length < 2 || name.length > 100) {
    return { error: 'Name must be 2-100 characters.' };
  }

  const phoneNumber = (body.phone_number || '').trim();
  if (!phoneNumber) {
    return { error: 'Phone number is required.' };
  }
  const phoneDigits = normalizePhone(phoneNumber);
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    return { error: 'Phone number must be 10-15 digits.' };
  }

  // Email optional but validated if provided
  const email = (body.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'Email address format is invalid.' };
  }

  // Vehicle fields required
  const vehicleMake = (body.vehicle_make || '').trim();
  if (!vehicleMake || vehicleMake.length < 2 || vehicleMake.length > 50) {
    return { error: 'Vehicle make must be 2-50 characters.' };
  }

  const vehicleModel = (body.vehicle_model || '').trim();
  if (!vehicleModel || vehicleModel.length < 2 || vehicleModel.length > 50) {
    return { error: 'Vehicle model must be 2-50 characters.' };
  }

  // Registration optional, but validated if provided
  let registrationNo = null;
  if (body.registration_no) {
    const regTrimmed = (body.registration_no || '').trim();
    if (regTrimmed.length > 20) {
      return { error: 'Registration number too long (max 20 characters).' };
    }
    if (regTrimmed) {
      registrationNo = regTrimmed;
    }
  }

  // Service type required and must be in allowed list
  const serviceType = (body.service_type || '').trim();
  const ALLOWED_SERVICES = [
    'lpg-conversion',
    'cng-conversion',
    'engine-repair',
    'car-ac',
    'battery-electrical',
    'denting-painting',
    'car-wash',
    'periodic-maintenance',
    'hybrid',
    'other',
  ];
  if (!serviceType || !ALLOWED_SERVICES.includes(serviceType)) {
    return { error: 'Service type is invalid or missing.' };
  }

  // Date must be valid and today or later
  const preferredDate = (body.preferred_date || '').trim();
  if (!preferredDate) {
    return { error: 'Preferred date is required.' };
  }
  const dateObj = new Date(preferredDate);
  if (isNaN(dateObj.getTime())) {
    return { error: 'Preferred date format is invalid.' };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (dateObj < today) {
    return { error: 'Preferred date must be today or later.' };
  }

  // Time format HH:MM
  const preferredTime = (body.preferred_time || '').trim();
  if (!/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(preferredTime)) {
    return { error: 'Preferred time must be in HH:MM format.' };
  }

  // Message optional, but validate if provided
  const message = (body.message || '').trim();
  if (message && message.length > 1000) {
    return { error: 'Message too long (max 1000 characters).' };
  }

  return {
    value: {
      name,
      phone_number: phoneNumber,
      phone_digits: phoneDigits,
      email: email || null,
      vehicle_make: vehicleMake,
      vehicle_model: vehicleModel,
      registration_no: registrationNo,
      service_type: serviceType,
      preferred_date: preferredDate,
      preferred_time: preferredTime,
      message: message || null,
    },
  };
}

/* ---------------------------------------------------------------
   Database operations
   --------------------------------------------------------------- */

/**
 * Find existing customer by normalized phone digits.
 * Returns customer ID or null.
 */
async function findCustomerByPhone(env, phoneDigits) {
  const row = await env.DB.prepare(
    `SELECT id FROM customers
      WHERE replace(replace(replace(replace(replace(phone,
              '+', ''), '-', ''), ' ', ''), '(', ''), ')', '') = ?1
      LIMIT 1`
  )
    .bind(phoneDigits)
    .first();
  return row?.id ?? null;
}

/**
 * Create new customer for a website booking.
 * Uses the next available customer ID (CUS-XXXX format).
 */
async function createCustomerForBooking(env, data) {
  const idResult = await allocateId(env, 'customers');
  if (idResult.error) throw new Error(idResult.error);

  const { id } = idResult;
  const now = new Date().toISOString();

  const result = await env.DB.prepare(
    `INSERT INTO customers (id, name, phone, email, status, created_at)
      VALUES (?1, ?2, ?3, ?4, 'Active', ?5)`
  )
    .bind(
      id,
      data.name,
      data.phone_number,
      data.email,
      now
    )
    .run();

  if (!result.success) {
    throw new Error(`Failed to create customer: ${result}`);
  }

  return id;
}

/**
 * Find existing vehicle by normalized registration number.
 * Returns vehicle ID or null.
 */
async function findVehicleByRegNo(env, regNo) {
  if (!regNo) return null;

  const normalized = normalizeRegNumber(regNo);
  const row = await env.DB.prepare(
    `SELECT id FROM vehicles WHERE UPPER(reg_no) = ?1 LIMIT 1`
  )
    .bind(normalized)
    .first();

  return row?.id ?? null;
}

/**
 * Create new vehicle for a website booking.
 * Linked to the given customer.
 * Uses the next available vehicle ID (VEH-XXXX format).
 */
async function createVehicleForBooking(env, customerId, data) {
  const idResult = await allocateId(env, 'vehicles');
  if (idResult.error) throw new Error(idResult.error);

  const { id } = idResult;
  const now = new Date().toISOString();

  // If no registration number provided, use a placeholder or generate one
  let regNo = data.registration_no || `WEB-${customerId}`;

  const result = await env.DB.prepare(
    `INSERT INTO vehicles (id, customer_id, reg_no, brand, model, status, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'Active', ?6)`
  )
    .bind(
      id,
      customerId,
      regNo,
      data.vehicle_make,
      data.vehicle_model,
      now
    )
    .run();

  if (!result.success) {
    throw new Error(`Failed to create vehicle: ${result}`);
  }

  return id;
}

/**
 * Find a service by name or return a fallback service ID.
 * Since services are created by admin, we look for a service matching the type.
 * If not found, we use a generic "Other" service or create one.
 */
async function getOrCreateServiceForBooking(env, serviceType) {
  // Map website service types to dashboard service names
  const serviceNameMap = {
    'lpg-conversion': 'LPG Conversion',
    'cng-conversion': 'CNG Conversion',
    'engine-repair': 'Engine Repair',
    'car-ac': 'Car AC',
    'battery-electrical': 'Battery & Electrical',
    'denting-painting': 'Denting & Painting',
    'car-wash': 'Car Wash',
    'periodic-maintenance': 'Periodic Maintenance',
    'hybrid': 'Hybrid Service',
    'other': 'Other Service',
  };

  const serviceName = serviceNameMap[serviceType] || 'Other Service';

  // Try to find existing service
  const existing = await env.DB.prepare(
    `SELECT id FROM services WHERE name = ?1 LIMIT 1`
  )
    .bind(serviceName)
    .first();

  if (existing) {
    return existing.id;
  }

  // Create new service if not found
  const idResult = await allocateId(env, 'services');
  if (idResult.error) throw new Error(idResult.error);

  const { id } = idResult;
  const now = new Date().toISOString();

  const result = await env.DB.prepare(
    `INSERT INTO services (id, name, status, created_at)
      VALUES (?1, ?2, 'Active', ?3)`
  )
    .bind(id, serviceName, now)
    .run();

  if (!result.success) {
    throw new Error(`Failed to create service: ${result}`);
  }

  return id;
}

/**
 * Check for duplicate appointment (same customer, vehicle, service, date, time).
 * Returns appointment ID if duplicate found, null otherwise.
 */
async function findDuplicateAppointment(env, customerId, vehicleId, serviceId, date, time) {
  const row = await env.DB.prepare(
    `SELECT id FROM appointments
      WHERE customer_id = ?1
        AND vehicle_id = ?2
        AND service_id = ?3
        AND date = ?4
        AND time = ?5
        AND status <> 'Cancelled'
      LIMIT 1`
  )
    .bind(customerId, vehicleId, serviceId, date, time)
    .first();

  return row?.id ?? null;
}

/**
 * Map website booking status to dashboard appointment status.
 * Website booking is always "pending" (new), which maps to "Scheduled".
 */
function mapBookingStatusToAppointment(websiteStatus) {
  const statusMap = {
    pending: 'Scheduled',
    confirmed: 'Confirmed',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  return statusMap[websiteStatus] || 'Scheduled';
}

/**
 * Create appointment in the dashboard D1.
 */
async function createAppointmentForBooking(env, data) {
  const idResult = await allocateId(env, 'appointments');
  if (idResult.error) throw new Error(idResult.error);

  const { id } = idResult;
  const now = new Date().toISOString();

  const result = await env.DB.prepare(
    `INSERT INTO appointments (
      id, customer_id, vehicle_id, service_id,
      date, time, status, source, complaint, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  )
    .bind(
      id,
      data.customer_id,
      data.vehicle_id,
      data.service_id,
      data.preferred_date,
      data.preferred_time,
      'Scheduled', // Website bookings start as Scheduled
      'Website',   // source = Website
      data.message,
      now
    )
    .run();

  if (!result.success) {
    throw new Error(`Failed to create appointment: ${result}`);
  }

  return id;
}

/* ---------------------------------------------------------------
   Main handler
   --------------------------------------------------------------- */

export async function handleWebsiteBooking(request, env) {
  // Check authentication first
  const authError = checkWebsiteBookingAuth(request, env);
  if (authError) return authError;

  // Parse and validate request body
  const bodyResult = await readJsonBody(request);
  if (bodyResult.error) {
    return fail('invalid_request', bodyResult.error, 400);
  }

  const validationResult = validateBookingPayload(bodyResult.value);
  if (validationResult.error) {
    return fail('validation_error', validationResult.error, 400);
  }

  const payload = validationResult.value;

  try {
    if (!env.DB) {
      return fail('database_error', 'Database not available.', 503);
    }

    // Find or create customer
    let customerId = await findCustomerByPhone(env, payload.phone_digits);
    if (!customerId) {
      customerId = await createCustomerForBooking(env, payload);
      console.log(`[Website Booking] Created new customer: ${customerId}`);
    } else {
      console.log(`[Website Booking] Found existing customer: ${customerId}`);
    }

    // Find or create vehicle
    let vehicleId = null;
    if (payload.registration_no) {
      vehicleId = await findVehicleByRegNo(env, payload.registration_no);
    }
    if (!vehicleId) {
      vehicleId = await createVehicleForBooking(env, customerId, payload);
      console.log(`[Website Booking] Created new vehicle: ${vehicleId}`);
    } else {
      console.log(`[Website Booking] Found existing vehicle: ${vehicleId}`);
    }

    // Get or create service
    const serviceId = await getOrCreateServiceForBooking(env, payload.service_type);
    console.log(`[Website Booking] Using service: ${serviceId}`);

    // Check for duplicate appointment
    const duplicateId = await findDuplicateAppointment(
      env,
      customerId,
      vehicleId,
      serviceId,
      payload.preferred_date,
      payload.preferred_time
    );
    if (duplicateId) {
      console.warn(`[Website Booking] Duplicate appointment detected: ${duplicateId}`);
      return fail(
        'duplicate_appointment',
        `An identical appointment already exists: ${duplicateId}.`,
        409,
        { conflictsWith: duplicateId }
      );
    }

    // Create the appointment
    const appointmentId = await createAppointmentForBooking(env, {
      ...payload,
      customer_id: customerId,
      vehicle_id: vehicleId,
      service_id: serviceId,
    });

    console.log(
      `[Website Booking] Created appointment: ${appointmentId} ` +
      `for customer ${customerId}, vehicle ${vehicleId}, service ${serviceId}`
    );

    return ok(
      { appointmentId, customerId, vehicleId, serviceId },
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Check if it's a constraint error (duplicate vehicle reg_no, etc.)
    if (errorMessage.includes('UNIQUE constraint')) {
      console.error(`[Website Booking] Constraint error: ${errorMessage}`);
      return fail(
        'constraint_error',
        'A record with that value already exists.',
        409
      );
    }
    if (errorMessage.includes('FOREIGN KEY constraint')) {
      console.error(`[Website Booking] Foreign key error: ${errorMessage}`);
      return fail(
        'referential_error',
        'Referenced record does not exist.',
        409
      );
    }

    console.error(`[Website Booking] Error: ${errorMessage}`);
    return fail(
      'booking_sync_error',
      'Failed to create appointment.',
      500
    );
  }
}
