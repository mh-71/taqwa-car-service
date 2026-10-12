/* ============================================================
   profile.js — Profile page (read-only)
   ------------------------------------------------------------
   Shows the workshop's account truthfully. There is one shared
   workshop account (a passphrase, no per-person users -- see
   src/lib/auth.js), so this page names no person. It fills in:

     - how this browser reached the records (the same rule the
       sidebar footer uses: database, this browser only, or
       signed out), and
     - the business details from Storage.getSettings(), the same
       values the Settings page shows.

   Read-only by design: no writes, no requests of its own. The
   data is what the shell already loaded. Every value goes in
   with textContent, never innerHTML, because settings are
   free text typed by staff.
   ============================================================ */

(() => {

  const NOT_SET = 'Not set';

  /** Put a value into every [data-pf="<key>"] element, as plain text. */
  function setText(key, value) {
    document.querySelectorAll(`[data-pf="${key}"]`).forEach(el => {
      const text = typeof value === 'string' ? value.trim() : '';
      el.textContent = text || NOT_SET;
      el.classList.toggle('pf-empty', !text);
    });
  }

  function setStatus(label, tone) {
    const el = document.getElementById('pfStatus');
    if (!el) return;
    el.textContent = label;
    el.className = `badge badge--${tone}`;
  }

  function showNotice(text) {
    const el = document.getElementById('pfNotice');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }

  function renderBusiness(s) {
    ['businessName', 'phone', 'email', 'website', 'address'].forEach(k => setText(k, s[k]));
    // Only the database stamps updatedAt; without one there is no date to show.
    const row = document.getElementById('pfUpdatedRow');
    if (row && s.updatedAt) {
      setText('updatedAt', Utils.fmtDate(s.updatedAt));
      row.hidden = false;
    }
  }

  function render() {
    // Signed out: the sign-in screen covers the page. Read nothing, so the
    // page holds no business details behind it.
    if (Storage.isLocked()) {
      setStatus('Signed out', 'neutral');
      setText('signedInWith', 'Not signed in');
      setText('connection', 'Signed out');
      showNotice('Sign in to see the workshop details.');
      return;
    }

    if (Storage.isApi()) {
      // Reaching the database at all requires a valid passphrase session
      // (storage.js hydrate() checks /api/session first), so that is the
      // sign-in in use. A machine token is only ever set by hand in a
      // developer's console; say so when one is present.
      setStatus('Connected', 'good');
      setText('signedInWith', Api.hasToken()
        ? 'Workshop passphrase (and a machine token set in this browser)'
        : 'Workshop passphrase');
      setText('connection', 'Connected to the database');
    } else {
      setStatus('This browser only', 'warn');
      setText('signedInWith', 'Not signed in (no server connection)');
      setText('connection', 'This browser only');
      showNotice('No server is answering, so these details come from this browser’s own copy, not the shared database.');
    }

    renderBusiness(Storage.getSettings());
  }

  Storage.ready(render);

})();
