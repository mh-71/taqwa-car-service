/* ============================================================
   account-settings.js — Account Settings hub (read-only)
   ------------------------------------------------------------
   Shows the workshop's REAL saved settings and edits none of
   them: business, invoice and workshop details are changed on
   the Settings page, which stays the one place that saves the
   settings row. Nothing here exports, resets, deletes or writes
   business data.

   Where the values come from:
     - connected: GET /api/settings, the saved row as the server
       holds it. Not Storage.getSettings(), which fills gaps with
       the browser's display defaults (storage.js DEFAULT_SETTINGS)
       -- this page must show "Not set", never a default posing as
       a saved value.
     - offline (this browser only) or signed out: nothing is
       shown; the state line says why.
   Every value goes in with textContent, never innerHTML.

   Appearance is the one control. It reuses the existing
   per-device preference exactly as the header toggle and the
   Settings page do: App.applyTheme(theme) applies and persists
   it, Storage.getTheme() reads it back. No new storage.
   ============================================================ */

(() => {

  const NOT_SET = 'Not set';
  const UNAVAILABLE = 'Unavailable';
  const THEMES = ['light', 'dark', 'system'];
  const THEME_NAMES = { light: 'Light', dark: 'Dark', system: 'System' };
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

  const FIELDS = [
    'businessName', 'phone', 'address', 'email', 'website', 'taxId', 'businessDescription',
    'taxRate', 'currency', 'invoiceFooter', 'paymentTerms',
    'defaultAppointmentDuration', 'openingTime', 'closingTime', 'workingDays',
  ];

  /* ---------- formatting: '' means "nothing saved" ---------- */

  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  }

  function time(v) {
    const t = str(v);
    return TIME.test(t) ? Utils.fmtTime(t) : t;
  }

  const FORMAT = {
    taxRate: (v) => { const n = num(v); return n === null ? '' : `${n}%`; },
    defaultAppointmentDuration: (v) => { const n = num(v); return n === null || n <= 0 ? '' : `${n} minutes`; },
    openingTime: time,
    closingTime: time,
    workingDays: (v) => (Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : ''),
  };

  /* ---------- output ---------- */

  function setField(key, text, empty) {
    document.querySelectorAll(`[data-as="${key}"]`).forEach((el) => {
      el.textContent = text;
      el.classList.toggle('as-empty', empty);
    });
  }

  function renderSettings(s) {
    FIELDS.forEach((key) => {
      const text = (FORMAT[key] || str)(s[key]);
      setField(key, text || NOT_SET, !text);
    });
    const row = document.getElementById('asUpdatedRow');
    if (row && str(s.updatedAt)) {
      setField('updatedAt', Utils.fmtDate(s.updatedAt), false);
      row.hidden = false;
    }
  }

  /** No values could be read: say so in every field rather than show anything. */
  function renderUnavailable() {
    FIELDS.forEach((key) => setField(key, UNAVAILABLE, true));
  }

  function setState(kind, message) {
    const el = document.getElementById('asState');
    if (!el) return;
    el.dataset.state = kind;
    el.textContent = message || '';
    el.hidden = !message;
  }

  /* ---------- the five sections' data ---------- */

  async function loadSettings() {
    // Signed out: the sign-in screen covers the page. Read nothing.
    if (Storage.isLocked()) {
      renderUnavailable();
      setState('warn', 'Signed out. Sign in to see the workshop settings.');
      return;
    }
    // No server: the shared settings cannot be read, and the browser's own
    // copy may hold display defaults rather than saved values.
    if (!Storage.isApi()) {
      renderUnavailable();
      setState('warn', 'No server is answering, so the shared workshop settings cannot be shown here. '
        + 'This browser\'s own copy can be viewed on the Settings page.');
      return;
    }

    setState('loading', 'Loading the saved settings…');
    let res;
    try {
      res = await Api.get('/settings');
    } catch (e) {
      res = { ok: false, code: 'request_failed', message: '' };
    }

    if (res && res.ok && res.data && typeof res.data === 'object') {
      renderSettings(res.data);
      setState('ok', '');
      return;
    }
    if (res && res.code === 'not_found') {
      renderSettings({});
      setState('info', 'No settings have been saved to the database yet. Add them on the Settings page.');
      return;
    }
    renderUnavailable();
    if (res && res.code === 'unauthorized') {
      setState('warn', 'Your session has ended. Sign in again to see the workshop settings.');
      return;
    }
    const why = res && typeof res.message === 'string' && res.message ? ` (${res.message})` : '';
    setState('error', `The saved settings could not be loaded${why}. Nothing is shown rather than a guess.`);
  }

  /* ---------- Appearance (existing per-device preference) ---------- */

  const radios = () => Array.from(document.querySelectorAll('input[name="as-theme"]'));

  function currentTheme() {
    const t = Storage.getTheme();
    return THEMES.includes(t) ? t : 'light';
  }

  function syncThemeRadios() {
    const t = currentTheme();
    radios().forEach((r) => {
      r.checked = r.value === t;
      const card = typeof r.closest === 'function' ? r.closest('label') : null;
      if (card && card.classList) card.classList.toggle('is-selected', r.checked);
    });
  }

  function announceTheme() {
    const el = document.getElementById('asThemeStatus');
    if (el) el.textContent = `Theme set to ${THEME_NAMES[currentTheme()]} on this device.`;
  }

  function bindTheme() {
    radios().forEach((r) => {
      r.addEventListener('change', () => {
        if (!r.checked || !THEMES.includes(r.value)) return;
        App.applyTheme(r.value);
        syncThemeRadios();
        announceTheme();
      });
    });
    syncThemeRadios();
    // The header's theme button changes the same preference; follow it.
    if (typeof MutationObserver === 'function') {
      new MutationObserver(syncThemeRadios)
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
  }

  Storage.ready(() => {
    bindTheme();
    loadSettings().catch(() => {
      renderUnavailable();
      setState('error', 'The saved settings could not be loaded. Nothing is shown rather than a guess.');
    });
  });

})();
