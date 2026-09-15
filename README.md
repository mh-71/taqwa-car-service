# Taqwa Automobile Service Center — Car Service Management System

Frontend-only build: HTML5 + CSS3 + Vanilla JavaScript (ES6+) + localStorage.

## Run it
No build step, no server required. Just open `index.html` in a browser.
(For best results, serve the folder, e.g. VS Code "Live Server", since some
browsers restrict localStorage on file:// URLs.)

## Structure
- `index.html` — Dashboard
- `pages/` — one HTML file per module (placeholders until each step is built)
- `css/style.css` — design tokens, base, app shell (sidebar/header)
- `css/components.css` — cards, tables, badges, buttons, forms, modals, toasts
- `css/dashboard.css` — dashboard stats + pure-CSS revenue chart
- `css/responsive.css` — tablet/mobile + print
- `js/storage.js` — THE data layer. All persistence goes through here.
- `js/seed-data.js` — realistic demo data (loaded once on first run)
- `js/utils.js` — formatting, badges, toasts, lookups
- `js/app.js` — injects sidebar/header on every page, theme, mobile nav
- `js/dashboard.js` — dashboard page logic

## Reset demo data
Run in the browser console:
    localStorage.clear(); location.reload();

## Backend migration path
UI code calls `Storage.getData / addData / updateData / deleteData` only.
Replace those function bodies with fetch() calls later — UI stays unchanged.
