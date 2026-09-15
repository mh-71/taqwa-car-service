/* ============================================================
   storage.js — Centralized data layer for Taqwa Automobile SC
   ------------------------------------------------------------
   ALL persistence goes through this file. UI code never touches
   localStorage directly. To migrate to a backend later, replace
   the bodies of these functions with fetch() calls — the rest
   of the app stays unchanged.
   ============================================================ */

const Storage = (() => {
  const PREFIX = 'taqwa_';

  const COLLECTIONS = [
    'customers', 'vehicles', 'appointments', 'jobCards', 'services',
    'mechanics', 'parts', 'invoices', 'payments', 'expenses',
    'inventoryTransactions'   // stock movement audit trail (added with Inventory module)
  ];

  /* ---------- low-level helpers ---------- */

  function read(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('Storage read failed:', key, e);
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('Storage write failed:', key, e);
      return false;
    }
  }

  /* ---------- public CRUD API ---------- */

  /** Get all records of a collection (always returns an array). */
  function getData(collection) {
    return read(collection) || [];
  }

  /** Overwrite an entire collection. */
  function saveData(collection, records) {
    return write(collection, records);
  }

  /** Get one record by id. */
  function getById(collection, id) {
    return getData(collection).find(r => r.id === id) || null;
  }

  /** Insert a new record. Assigns id + createdAt if missing. Returns the record. */
  function addData(collection, record) {
    const records = getData(collection);
    if (!record.id) record.id = generateId(collection);
    if (!record.createdAt) record.createdAt = new Date().toISOString();
    records.push(record);
    saveData(collection, records);
    return record;
  }

  /** Merge changes into an existing record by id. Returns updated record or null. */
  function updateData(collection, id, changes) {
    const records = getData(collection);
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return null;
    records[idx] = { ...records[idx], ...changes, updatedAt: new Date().toISOString() };
    saveData(collection, records);
    return records[idx];
  }

  /** Delete a record by id. Returns true if something was removed. */
  function deleteData(collection, id) {
    const records = getData(collection);
    const next = records.filter(r => r.id !== id);
    if (next.length === records.length) return false;
    saveData(collection, next);
    return true;
  }

  /* ---------- id generation ---------- */

  const ID_PREFIXES = {
    customers: 'CUS', vehicles: 'VEH', appointments: 'APT', jobCards: 'JOB',
    services: 'SRV', mechanics: 'MEC', parts: 'PRT', invoices: 'INV',
    payments: 'PAY', expenses: 'EXP', inventoryTransactions: 'STK'
  };

  /** Sequential, human-readable ids like JOB-0007. */
  function generateId(collection) {
    const prefix = ID_PREFIXES[collection] || 'REC';
    const counters = read('counters') || {};
    counters[collection] = (counters[collection] || 0) + 1;
    write('counters', counters);
    return `${prefix}-${String(counters[collection]).padStart(4, '0')}`;
  }

  /* ---------- settings ---------- */

  const DEFAULT_SETTINGS = {
    businessName: 'Taqwa Automobile Service Center',
    phone: '+880 1XXX-XXXXXX',
    email: 'info@taqwaauto.com',
    website: '',
    taxId: '',
    address: 'Sector #15, Block #C, Road #3/A, Plot #40, Diabari, Uttara, Dhaka',
    businessDescription: '',
    invoiceFooter: 'Thank you for servicing with Taqwa Automobile Service Center.',
    paymentTerms: '',
    taxRate: 5,
    currency: '৳',
    // Workshop-profile reference info only -- not read or enforced by
    // Appointments or Job Cards. Stored here so it can be recorded and
    // shown, without touching those modules' logic (see settings.js).
    defaultAppointmentDuration: 60,
    openingTime: '',
    closingTime: '',
    workingDays: []
  };

  function getSettings() {
    return { ...DEFAULT_SETTINGS, ...(read('settings') || {}) };
  }

  function saveSettings(settings) {
    return write('settings', { ...getSettings(), ...settings });
  }

  /* ---------- theme ---------- */

  function getTheme() { return read('theme') || 'light'; }
  function saveTheme(theme) { write('theme', theme); }

  /* ---------- seed data (first run only) ---------- */

  function isSeeded() { return read('seeded') === true; }

  function seedIfEmpty() {
    if (isSeeded()) return;
    SeedData.load({ addData, saveData });
    write('seeded', true);
  }

  /**
   * Wipes every business collection and counter, then reloads the original
   * demo dataset -- the symmetric opposite of seedIfEmpty(). Settings and
   * theme are deliberately left untouched: this resets DEMO DATA, not the
   * shop's own configured Settings. Used only by Settings' "Reset to Seed
   * Data" action, which gates this behind a strong typed confirmation.
   */
  function resetToSeedData() {
    COLLECTIONS.forEach(c => write(c, []));
    write('counters', {});
    write('seeded', false);
    SeedData.load({ addData, saveData });
    write('seeded', true);
    return true;
  }

  return {
    COLLECTIONS,
    getData, saveData, getById, addData, updateData, deleteData,
    generateId, getSettings, saveSettings, getTheme, saveTheme, seedIfEmpty, resetToSeedData
  };
})();
