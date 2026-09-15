/* ============================================================
   app.js — Application shell
   Injects the sidebar + header into every page (one source of
   truth, no duplicated layout HTML), handles theme + mobile nav.
   Each page declares itself via <body data-page="..." data-root="">
   data-root is "" for index.html and "../" for files in /pages.
   ============================================================ */

const App = (() => {

  const NAV = [
    { key: 'dashboard',    label: 'Dashboard',    href: 'index.html',            icon: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z' },
    { key: 'customers',    label: 'Customers',    href: 'pages/customers.html',  icon: 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z' },
    { key: 'vehicles',     label: 'Vehicles',     href: 'pages/vehicles.html',   icon: 'M18.9 6c-.2-.6-.8-1-1.4-1H6.5c-.6 0-1.2.4-1.4 1L3 12v8c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h12v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-8l-2.1-6zM6.5 15c-.8 0-1.5-.7-1.5-1.5S5.7 12 6.5 12s1.5.7 1.5 1.5S7.3 15 6.5 15zm11 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zM5 10l1.5-4.5h11L19 10H5z' },
    { key: 'appointments', label: 'Appointments', href: 'pages/appointments.html', icon: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z' },
    { key: 'job-cards',    label: 'Job Cards',    href: 'pages/job-cards.html',  icon: 'M20 6h-4V4c0-1.1-.9-2-2-2h-4C8.9 2 8 2.9 8 4v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10 4h4v2h-4V4z' },
    { key: 'services',     label: 'Services',     href: 'pages/services.html',   icon: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z' },
    { key: 'mechanics',    label: 'Mechanics',    href: 'pages/mechanics.html',  icon: 'M12 2L4 6v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V6l-8-4zm0 10.9c-1.6 0-2.9-1.3-2.9-2.9S10.4 7.1 12 7.1s2.9 1.3 2.9 2.9-1.3 2.9-2.9 2.9zm0 2c1.9 0 5.8.9 5.8 2.9v1.3c-1.4 1.9-3.5 3.3-5.8 3.8-2.3-.5-4.4-1.9-5.8-3.8v-1.3c0-2 3.9-2.9 5.8-2.9z' },
    { key: 'inventory',    label: 'Inventory',    href: 'pages/inventory.html',  icon: 'M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.4 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.3 1-1 1-1.7V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z' },
    { key: 'invoices',     label: 'Invoices',     href: 'pages/invoices.html',   icon: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z' },
    { key: 'payments',     label: 'Payments',     href: 'pages/payments.html',   icon: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z' },
    { key: 'expenses',     label: 'Expenses',     href: 'pages/expenses.html',   icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' },
    { key: 'reports',      label: 'Reports',      href: 'pages/reports.html',    icon: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z' },
    { key: 'settings',     label: 'Settings',     href: 'pages/settings.html',   icon: 'M19.1 12.9c0-.3.1-.6.1-.9s0-.6-.1-.9l2-1.6c.2-.1.2-.4.1-.6l-1.9-3.3c-.1-.2-.4-.3-.6-.2l-2.4 1c-.5-.4-1-.7-1.6-.9l-.4-2.5c0-.2-.2-.4-.5-.4h-3.8c-.2 0-.4.2-.5.4l-.4 2.5c-.6.2-1.1.6-1.6.9l-2.4-1c-.2-.1-.5 0-.6.2L2.6 9c-.1.2-.1.4.1.6l2 1.6c0 .3-.1.6-.1.9s0 .6.1.9l-2 1.6c-.2.1-.2.4-.1.6l1.9 3.3c.1.2.4.3.6.2l2.4-1c.5.4 1 .7 1.6.9l.4 2.5c0 .2.2.4.5.4h3.8c.2 0 .4-.2.5-.4l.4-2.5c.6-.2 1.1-.6 1.6-.9l2.4 1c.2.1.5 0 .6-.2l1.9-3.3c.1-.2.1-.4-.1-.6l-2-1.6zM12 15.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z' }
  ];

  const PAGE_TITLES = {
    dashboard: 'Dashboard', customers: 'Customers', vehicles: 'Vehicles',
    appointments: 'Appointments', 'job-cards': 'Job Cards', services: 'Service Catalog',
    mechanics: 'Mechanics', inventory: 'Inventory', invoices: 'Invoices',
    payments: 'Payments', expenses: 'Expenses', reports: 'Reports', settings: 'Settings'
  };

  function icon(path) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
  }

  /* ---------- layout injection ---------- */

  function renderShell() {
    const body = document.body;
    const page = body.dataset.page || 'dashboard';
    const root = body.dataset.root || '';
    const settings = Storage.getSettings();

    const navHtml = NAV.map(item => {
      const active = item.key === page ? ' is-active' : '';
      const href = item.key === 'dashboard' ? `${root}index.html` : `${root}${item.href}`;
      return `<a class="nav__link${active}" href="${href}">${icon(item.icon)}<span>${item.label}</span></a>`;
    }).join('');

    const shell = document.createElement('div');
    shell.className = 'shell';
    shell.innerHTML = `
      <aside class="sidebar" id="sidebar">
        <div class="sidebar__brand">
          <img class="brand-logo" src="${root}assets/logo/logo-white.png" alt="Taqwa Automobile">
          <span class="brand-tag">Service Center Management</span>
        </div>
        <nav class="nav" aria-label="Main navigation">${navHtml}</nav>
        <div class="sidebar__foot">
          <span class="sidebar__foot-dot"></span> Workshop open
        </div>
      </aside>
      <div class="sidebar-scrim" id="sidebarScrim" hidden></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn topbar__menu" id="menuToggle" aria-label="Open menu" aria-expanded="false">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/></svg>
          </button>
          <div class="topbar__title">
            <h1>${PAGE_TITLES[page] || 'Dashboard'}</h1>
            <span class="topbar__date" id="topbarDate"></span>
          </div>
          <div class="topbar__actions">
            <button class="icon-btn" id="themeToggle" aria-label="Toggle dark mode" title="Toggle dark mode">
              <svg class="ico-sun" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 7a5 5 0 100 10 5 5 0 000-10zm0-5h0v3h0zm0 17v3zm10-7h-3zM5 12H2zm14.1-7.1l-2.1 2.1zM7 17l-2.1 2.1zm12.1 2.1L17 17zM7 7L4.9 4.9z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              <svg class="ico-moon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12.3 2c-5.6 0-10 4.5-10 10s4.4 10 10 10c3.9 0 7.3-2.3 9-5.6-8 1.9-13.9-6.4-9-14.4z"/></svg>
            </button>
            <div class="topbar__user">
              <div class="avatar">TA</div>
              <div class="topbar__user-text">
                <strong>Admin</strong>
                <span>${Utils.esc(settings.businessName.split(' ')[0])} ASC</span>
              </div>
            </div>
          </div>
        </header>
        <main class="content" id="content"></main>
      </div>`;

    // Move existing page content into the content area
    const pageContent = document.getElementById('page-content');
    body.prepend(shell);
    if (pageContent) shell.querySelector('#content').appendChild(pageContent);

    // Date in header
    document.getElementById('topbarDate').textContent =
      new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    bindShellEvents();
  }

  /* ---------- theme ---------- */

  function applyTheme(theme) {
    // 'system' resolves to the OS preference for the actual applied
    // data-theme attribute, but the user's chosen preference (which may be
    // 'system' itself) is what gets persisted -- so returning here later
    // still remembers "follow system" rather than freezing whatever it
    // resolved to at the time.
    const resolved = theme === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    document.documentElement.dataset.theme = resolved;
    Storage.saveTheme(theme);
  }

  /* ---------- events ---------- */

  function bindShellEvents() {
    const sidebar = document.getElementById('sidebar');
    const scrim = document.getElementById('sidebarScrim');
    const menuBtn = document.getElementById('menuToggle');

    function setMenu(open) {
      sidebar.classList.toggle('is-open', open);
      scrim.hidden = !open;
      menuBtn.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('no-scroll', open);
    }

    menuBtn.addEventListener('click', () => setMenu(!sidebar.classList.contains('is-open')));
    scrim.addEventListener('click', () => setMenu(false));
    window.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

    document.getElementById('themeToggle').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });
  }

  /* ---------- init ---------- */

  function init() {
    applyTheme(Storage.getTheme());
    // Live-follow OS theme changes only while the user has chosen "System".
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (Storage.getTheme() === 'system') applyTheme('system');
      });
    }
    Storage.seedIfEmpty();
    renderShell();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { NAV, applyTheme };
})();
