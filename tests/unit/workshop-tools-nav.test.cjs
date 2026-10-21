/* workshop-tools-nav — the Workshop Tools & Equipment link in the sidebar.

   What must hold:
     1. It is a top-level link after the Customer CRM group and right before
        Notifications Center, linking to the demo page, which exists.
     2. On that page it is the only active link and the header has its title;
        elsewhere it is not active.

   Drives the REAL js/app.js through the harness. */
const fs = require('fs'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

function shellFor(page, root = '') {
  const h = boot({
    modules: ['js/app.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = page;
      doc.body.dataset.root = root;
      ctx.sessionStorage = { getItem: () => null, setItem: () => {} };
    },
  });
  h.fireReady();
  return h.ctx.document.body._lastShellHtml || '';
}
const toolsLink = (html, root = '') => (html.match(new RegExp(`<a class="nav__link(?: is-active)?" href="${root.replace(/\./g, '\\.')}pages/workshop-tools\\.html">[\\s\\S]*?</a>`)) || [''])[0];

console.log('=== workshop-tools-nav: the Workshop Tools & Equipment link ===\n');

console.log('-- 1. placement and target --');
{
  const html = shellFor('dashboard');
  const link = toolsLink(html);
  ok('the sidebar has a "Workshop Tools" link (the full name is the page title)', /<span>Workshop Tools<\/span><\/a>$/.test(link), link.slice(0, 160));
  check('   ...exactly once', html.split('href="pages/workshop-tools.html"').length - 1, 1);
  ok('   ...linking to a page that exists', fs.existsSync(path.join(ROOT, 'pages/workshop-tools.html')), '');
  ok('   ...with a filled icon like the other links', /<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"/.test(link), link.slice(0, 160));
  const iCrm = html.indexOf('id="navCrm"'), iTools = html.indexOf('href="pages/workshop-tools.html"'), iNotify = html.indexOf('id="navNotify"');
  ok('   ...after the Customer CRM group and before Notifications Center', iCrm > -1 && iCrm < iTools && iTools < iNotify, JSON.stringify({ iCrm, iTools, iNotify }));
  ok('   ...directly after the CRM group', !/<a |<details /.test(html.slice(html.indexOf('</details>', iCrm) + '</details>'.length, html.lastIndexOf('<a ', iTools))), '');
  ok('   ...and not active on another page', !/is-active/.test(link), link.slice(0, 120));
}

console.log('\n-- 2. on the Workshop Tools page --');
{
  const html = shellFor('workshop-tools', '../');
  const link = toolsLink(html, '../');
  ok('the link is active', /^<a class="nav__link is-active" href="\.\.\/pages\/workshop-tools\.html">/.test(link), link.slice(0, 120));
  check('   ...and it is the only active top-level link', (html.match(/class="nav__link[^"]*is-active/g) || []).length, 1);
  ok('the header shows the page title', /<h1>Workshop Tools &(amp;)? Equipment<\/h1>/.test(html), (html.match(/<h1>[^<]*<\/h1>/) || [''])[0]);
  ok('the page itself declares data-page="workshop-tools"',
    fs.readFileSync(path.join(ROOT, 'pages/workshop-tools.html'), 'utf8').includes('<body data-page="workshop-tools" data-root="../">'), '');
}

process.exit(summary('workshop-tools-nav') === 0 ? 0 : 1);
