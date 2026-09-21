/* service-duration — the Estimated Time field as hours + minutes.

   The Service Catalog used to ask for a single "Estimated Time (minutes)"
   box. It now asks for Hours and Minutes, and that pair is a UI convenience
   only: the value that leaves the browser is still the same single `estTime`
   in minutes that it always was.

   That is the whole risk in this change, so it is what this suite pins down:

     - (hours * 60) + minutes is what gets stored, for every combination;
     - `estHours` and `estMinutes` NEVER reach the wire. They are form inputs,
       not fields of the API. src/routes/services.js takes exactly six keys
       and fieldSet.take() ignores the rest in silence, so a stray key would
       not 422 -- it would just be a lie in the request, invisible until
       someone tightened the route. The assertion has to be "we never sent
       it", which is also how C-16..C-19's payload suites are written;
     - editing converts the stored minutes back to the pair it came from, so
       a save that changes only the name cannot quietly rewrite the duration;
     - the invalid pairs are refused in the browser rather than sent. The API
       is readNumber(estTime, { min: 1, integer: true }) and the column's
       CHECK is "NULL or > 0"; neither knows anything about a 60 in the
       minutes box, because by the time it gets there it is just 60 minutes.

   These tests drive the REAL shipped js/services.js. fake-api does not
   re-implement the Worker's refusals (its own header says so), which is why
   the payload assertions look at what was sent, not at what came back. */
process.env.TZ = 'Asia/Dhaka';
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

/* ---------- a form the module can read, and a record of what it asked for ---------- */

function field(value) {
  return { value: String(value), innerHTML: '', hidden: false, addEventListener() {} };
}

const FORM_FIELDS = ['name', 'category', 'description', 'estHours', 'estMinutes', 'price', 'status'];

/* showErrors() clears every .field and [data-err] and then asks for the one
   slot per failing key. Recording those keys is how a suite sees which rule
   fired without reaching into the module. */
function fakeOverlay(values, cap) {
  const form = {
    querySelector(sel) {
      const m = /data-err="([^"]+)"/.exec(sel || '');
      if (!m) return null;
      cap.errorKeys.push(m[1]);
      return {
        set textContent(v) { cap.errorText[m[1]] = String(v); },
        get textContent() { return cap.errorText[m[1]] || ''; },
        closest: () => ({ classList: { add() {}, remove() {} } }),
      };
    },
    querySelectorAll: () => [],
  };
  for (const name of FORM_FIELDS) form[name] = field(values[name] ?? '');
  return {
    querySelector(sel) {
      if (sel === '[data-save]') {
        return { addEventListener: (_e, cb) => { cap.saveHandler = cb; } };
      }
      if (sel === '#svcForm') return form;
      // The detail modal wires its "Edit Service" button straight off the
      // overlay, so the stub has to take a listener or opening it throws.
      if (sel === '[data-edit-from-view]') {
        return { addEventListener: (_e, cb) => { cap.editFromView = cb; } };
      }
      return null;
    },
    querySelectorAll: () => [],
  };
}

/* Modal.open() is where the module hands over its rendered form. Keeping the
   body string is how the edit tests read back what went INTO the two boxes. */
function hookModal(ctx, values) {
  const cap = { saveHandler: null, editFromView: null, body: '', title: '',
                errorKeys: [], errorText: {} };
  ctx.Utils.Modal.open = (opts) => {
    cap.body = (opts && opts.body) || '';
    cap.title = (opts && opts.title) || '';
    return fakeOverlay(values, cap);
  };
  ctx.Utils.Modal.close = () => {};
  ctx.Utils.Modal.confirm = () => {};
  return cap;
}

const VALID = { name: 'Engine Oil Change', category: 'Engine', description: '', price: '2500', status: 'Active' };

async function apiPage(services = []) {
  const f = fakeApi({ rows: { services: JSON.parse(JSON.stringify(services)) } });
  const h = boot({ modules: ['js/services.js'], origin: 'http://localhost:8787', fetch: f });
  await h.ctx.Storage.hydrate();
  h.ctx.Api.configure({ token: 'unit-token' });
  h.fireReady();
  return { ...h, f };
}

const sent = (f, method, re) => f.calls.filter((c) => c.method === method && re.test(c.path));

/* The value attribute the rendered form put in one of the two boxes. */
function boxValue(html, id) {
  const re = new RegExp(`id="${id}"[^>]*?value="([^"]*)"`);
  const m = re.exec(html);
  return m ? m[1] : null;
}

/* Drive an Add Service save with one hours/minutes pair. */
async function create(estHours, estMinutes, services = []) {
  const h = await apiPage(services);
  const cap = hookModal(h.ctx, { ...VALID, estHours, estMinutes });
  h.els.get('addServiceBtn').dispatch('click', {});
  if (!cap.saveHandler) throw new Error('the Add Service modal exposed no save handler');
  await cap.saveHandler();
  const posts = sent(h.f, 'POST', /^\/services$/);
  return { h, cap, posts, body: posts.length === 1 ? posts[0].body : null };
}

console.log('=== services: Estimated Time as hours + minutes ===\n');

(async () => {

/* ============================================================
   1. (hours * 60) + minutes is what gets stored
   ============================================================ */
console.log('-- 1. the create payload: hours + minutes -> minutes --');
{
  const CASES = [
    ['', '25', 25, '25 minutes typed as minutes alone'],
    ['0', '25', 25, '0 hours 25 minutes'],
    ['1', '0', 60, '1 hour 0 minutes'],
    ['1', '', 60, '1 hour, minutes left blank'],
    ['1', '30', 90, '1 hour 30 minutes'],
    ['2', '0', 120, '2 hours 0 minutes'],
    ['2', '', 120, '2 hours, minutes left blank'],
    ['0', '59', 59, 'the largest minutes value'],
    ['8', '45', 525, 'a long job'],
  ];
  for (const [hours, minutes, expected, label] of CASES) {
    const { posts, body } = await create(hours, minutes);
    if (posts.length !== 1) {
      ok(`${label} sends exactly one POST /services`, false, `got ${posts.length}`);
      continue;
    }
    check(`${label} -> estTime ${expected}`, body.estTime, expected);
  }
}

/* ============================================================
   2. THE REGRESSION: the two boxes are not fields of the API
   ============================================================ */
console.log('\n-- 2. estHours and estMinutes never leave the browser --');
{
  const { posts, body } = await create('1', '30');
  check('exactly one POST /services', posts.length, 1);
  ok('THE BODY CARRIES NO `estHours` -- it is an input, not a field',
    !('estHours' in body), JSON.stringify(Object.keys(body)));
  ok('THE BODY CARRIES NO `estMinutes` -- likewise',
    !('estMinutes' in body), JSON.stringify(Object.keys(body)));
  check('   ...and the payload is exactly the six keys the route takes',
    Object.keys(body).sort(),
    ['category', 'description', 'estTime', 'name', 'price', 'status']);
  check('   ...with estTime the single minutes figure', body.estTime, 90);
  check('   ...and the rest of the form untouched', [body.name, body.category, body.price],
    ['Engine Oil Change', 'Engine', 2500]);
}

/* ============================================================
   3. Both boxes empty is still "no estimate"
   ============================================================ */
console.log('\n-- 3. both empty keeps the existing rule --');
{
  const { posts, body } = await create('', '');
  check('an empty pair still saves', posts.length, 1);
  // '' is what an empty box has always sent, and src/lib/write.js:166 turns
  // it into a null est_time. Sending 0 instead would hit the column's
  // "NULL or > 0" CHECK, which is the bug this assertion exists to catch.
  check('   ...and sends estTime as the empty string, not 0', body.estTime, '');
  ok('   ...so the column stays NULL rather than failing its CHECK',
    body.estTime !== 0, JSON.stringify(body.estTime));
}

/* ============================================================
   4. Invalid pairs are refused before anything is sent
   ============================================================ */
console.log('\n-- 4. the invalid pairs --');
{
  const BAD = [
    ['0', '60', 'minutes of 60 -- an hour typed in the wrong box'],
    ['0', '75', 'minutes above 59'],
    ['1', '90', 'minutes above 59 alongside an hour'],
    ['-1', '30', 'negative hours'],
    ['1', '-30', 'negative minutes'],
    ['-1', '-1', 'both negative'],
    ['1.5', '0', 'fractional hours'],
    ['0', '30.5', 'fractional minutes'],
    ['abc', '30', 'hours that are not a number'],
    ['1', 'abc', 'minutes that are not a number'],
  ];
  for (const [hours, minutes, label] of BAD) {
    const { posts, cap } = await create(hours, minutes);
    ok(`${label} -> nothing is sent`, posts.length === 0,
      `POSTed ${JSON.stringify(posts[0] && posts[0].body)}`);
    ok(`   ...and the estimate is what is flagged`, cap.errorKeys.includes('estTime'),
      JSON.stringify(cap.errorKeys));
  }

  // 0 + 0 is well formed but adds up to nothing, so it falls through to the
  // rule that was already here and that the API states as { min: 1 }.
  const zero = await create('0', '0');
  ok('an explicit 0 hours 0 minutes -> nothing is sent', zero.posts.length === 0,
    JSON.stringify(zero.posts[0] && zero.posts[0].body));
  check('   ...with the pre-existing message',
    zero.cap.errorText.estTime, 'Estimated time must be greater than 0.');
}

/* ============================================================
   5. Editing converts the stored minutes back to the pair
   ============================================================ */
console.log('\n-- 5. editing an existing service --');
{
  const ROWS = [
    { id: 'SRV-0001', name: 'Quick Check', category: 'Inspection', description: '',
      estTime: 25, price: 500, status: 'Active' },
    { id: 'SRV-0002', name: 'Oil Change', category: 'Engine', description: '',
      estTime: 60, price: 1500, status: 'Active' },
    { id: 'SRV-0003', name: 'Brake Service', category: 'Brakes', description: '',
      estTime: 90, price: 2500, status: 'Active' },
    { id: 'SRV-0004', name: 'Full Inspection', category: 'Inspection', description: '',
      estTime: 120, price: 3500, status: 'Active' },
    { id: 'SRV-0005', name: 'Wheel Balancing', category: 'Wheels', description: '',
      estTime: null, price: 800, status: 'Active' },
  ];
  const EXPECTED = [
    ['SRV-0001', '0', '25', '25 minutes'],
    ['SRV-0002', '1', '0', '60 minutes'],
    ['SRV-0003', '1', '30', '90 minutes'],
    ['SRV-0004', '2', '0', '120 minutes'],
    ['SRV-0005', '', '', 'no stored estimate'],
  ];

  for (const [id, hours, minutes, label] of EXPECTED) {
    const h = await apiPage(ROWS);
    const cap = hookModal(h.ctx, {});
    const btn = { dataset: { action: 'edit' },
                  closest: (sel) => (sel === 'tr' ? { dataset: { id } } : btn) };
    h.els.get('svcTableBody').dispatch('click', {
      target: { closest: (sel) => (sel === '[data-action]' ? btn : null) },
    });
    check(`${label} -> the hours box reads "${hours}"`, boxValue(cap.body, 'sf-hours'), hours);
    check(`${label} -> the minutes box reads "${minutes}"`, boxValue(cap.body, 'sf-minutes'), minutes);
  }

  // And the round trip: reopen 90, change nothing about the time, save.
  const h = await apiPage(ROWS);
  const cap = hookModal(h.ctx, { ...VALID, name: 'Brake Service Plus', category: 'Brakes',
                                 estHours: '1', estMinutes: '30' });
  const btn = { dataset: { action: 'edit' },
                closest: (sel) => (sel === 'tr' ? { dataset: { id: 'SRV-0003' } } : btn) };
  h.els.get('svcTableBody').dispatch('click', {
    target: { closest: (sel) => (sel === '[data-action]' ? btn : null) },
  });
  ok('the Edit Service modal exposed a save handler', !!cap.saveHandler, 'no handler');
  if (cap.saveHandler) {
    await cap.saveHandler();
    const puts = sent(h.f, 'PUT', /^\/services\/SRV-0003$/);
    check('an edit sends exactly one PUT /services/:id', puts.length, 1);
    if (puts.length === 1) {
      check('   ...and the stored duration survives the round trip', puts[0].body.estTime, 90);
      ok('   ...with no estHours on the wire', !('estHours' in puts[0].body),
        JSON.stringify(Object.keys(puts[0].body)));
      ok('   ...and no estMinutes either', !('estMinutes' in puts[0].body),
        JSON.stringify(Object.keys(puts[0].body)));
    }
  }

  // Clearing both boxes on an edit must clear the stored estimate, which is
  // what '' has always meant on this form.
  const h2 = await apiPage(ROWS);
  const cap2 = hookModal(h2.ctx, { ...VALID, name: 'Brake Service', category: 'Brakes',
                                   estHours: '', estMinutes: '' });
  const btn2 = { dataset: { action: 'edit' },
                 closest: (sel) => (sel === 'tr' ? { dataset: { id: 'SRV-0003' } } : btn2) };
  h2.els.get('svcTableBody').dispatch('click', {
    target: { closest: (sel) => (sel === '[data-action]' ? btn2 : null) },
  });
  if (cap2.saveHandler) {
    await cap2.saveHandler();
    const puts = sent(h2.f, 'PUT', /^\/services\//);
    check('clearing both boxes sends estTime as the empty string',
      puts.length === 1 ? puts[0].body.estTime : 'no PUT', '');
  }
}

/* ============================================================
   6. The two display formats, and which surface gets which

   The catalog table's Est. Time column is narrow -- 95px below a 1280px
   viewport, measured in the browser -- so "1 hour 30 minutes" wrapped onto
   three lines there. The table therefore uses a compact form while the
   detail modal, which has room, keeps spelling it out. The whole point is
   that the two DIFFER, so both are pinned here: shortening the table by
   quietly shortening the modal too would undo the thing being asked for.
   ============================================================ */
const DISPLAY_ROWS = [
  { id: 'SRV-0001', name: 'A', category: 'Engine', estTime: 25, price: 1, status: 'Active' },
  { id: 'SRV-0002', name: 'B', category: 'Engine', estTime: 60, price: 1, status: 'Active' },
  { id: 'SRV-0003', name: 'C', category: 'Engine', estTime: 90, price: 1, status: 'Active' },
  { id: 'SRV-0004', name: 'D', category: 'Engine', estTime: 120, price: 1, status: 'Active' },
  { id: 'SRV-0005', name: 'E', category: 'Engine', estTime: 1, price: 1, status: 'Active' },
  { id: 'SRV-0006', name: 'F', category: 'Engine', estTime: 61, price: 1, status: 'Active' },
  { id: 'SRV-0007', name: 'G', category: 'Engine', estTime: null, price: 1, status: 'Active' },
  { id: 'SRV-0008', name: 'H', category: 'Engine', estTime: 525, price: 1, status: 'Active' },
];

console.log('\n-- 6a. the TABLE uses the compact form --');
{
  const h = await apiPage(DISPLAY_ROWS);
  const html = h.els.get('svcTableBody').innerHTML;
  const cellFor = (name) => {
    // Each row is one <tr>; find the one carrying this service's name and
    // read the first numeric cell, which is the one the formatter wrote.
    const row = html.split('<tr ').find((r) => r.includes(`>${name}</td>`));
    const m = row && /<td class="num">([^<]*)<\/td>/.exec(row);
    return m ? m[1] : null;
  };
  check('25 minutes  -> "25 min"', cellFor('A'), '25 min');
  check('60 minutes  -> "1 hour"', cellFor('B'), '1 hour');
  check('90 minutes  -> "1h 30m"', cellFor('C'), '1h 30m');
  check('120 minutes -> "2 hours"', cellFor('D'), '2 hours');
  check('1 minute    -> "1 min"', cellFor('E'), '1 min');
  check('61 minutes  -> "1h 1m"', cellFor('F'), '1h 1m');
  check('525 minutes -> "8h 45m"', cellFor('H'), '8h 45m');
  check('no estimate -> a dash', cellFor('G'), '—');

  ok('no table cell still spells out "minutes"',
    !/<td class="num">[^<]*minutes<\/td>/.test(html), html.slice(0, 300));
  ok('   ...and none is a bare minute count either',
    !/<td class="num">\d+<\/td>/.test(html), html.slice(0, 300));
  // The compact strings are what keep the column on one line. 7 characters
  // is "1h 30m"/"2 hours" plus room; the long form was 17.
  const cells = [...html.matchAll(/<td class="num">([^<]*)<\/td>/g)]
    .map((m) => m[1]).filter((t) => !/^৳|^\d[\d,]*$/.test(t));
  ok('every duration cell is short enough not to wrap',
    cells.every((t) => t.length <= 8), JSON.stringify(cells));
}

console.log('\n-- 6b. the DETAIL MODAL still spells it out --');
{
  const LONG = [
    ['SRV-0001', '25 minutes'],
    ['SRV-0002', '1 hour'],
    ['SRV-0003', '1 hour 30 minutes'],
    ['SRV-0004', '2 hours'],
    ['SRV-0005', '1 minute'],
    ['SRV-0006', '1 hour 1 minute'],
    ['SRV-0008', '8 hours 45 minutes'],
    ['SRV-0007', '—'],
  ];
  for (const [id, expected] of LONG) {
    const h = await apiPage(DISPLAY_ROWS);
    const cap = hookModal(h.ctx, {});
    const btn = { dataset: { action: 'view' },
                  closest: (sel) => (sel === 'tr' ? { dataset: { id } } : btn) };
    h.els.get('svcTableBody').dispatch('click', {
      target: { closest: (sel) => (sel === '[data-action]' ? btn : null) },
    });
    const m = /<span>Estimated Time<\/span><strong>([^<]*)<\/strong>/.exec(cap.body);
    check(`the detail view of ${id} reads "${expected}"`, m ? m[1] : null, expected);
  }
}

/* ============================================================
   7. LOCAL MODE stores the same minutes figure
   ============================================================ */
console.log('\n-- 7. local mode --');
{
  const h = boot({ modules: ['js/services.js'] });          // no fetch -> local
  h.ctx.Storage.seedIfEmpty();
  h.fireReady();
  check('the app is in local mode', h.ctx.Storage.mode, 'local');

  const before = h.ctx.Storage.getData('services').map((s) => s.id);
  const cap = hookModal(h.ctx, { ...VALID, name: 'Gearbox Overhaul', category: 'Transmission',
                                 estHours: '2', estMinutes: '15' });
  h.els.get('addServiceBtn').dispatch('click', {});
  ok('the local Add modal exposed a save handler', !!cap.saveHandler, 'no handler');
  if (cap.saveHandler) {
    await cap.saveHandler();
    const rec = h.ctx.Storage.getData('services').find((s) => !before.includes(s.id));
    ok('a service was stored offline', !!rec, 'none created');
    if (rec) {
      check('   ...with the total in minutes, as the server would have stored it',
        rec.estTime, 135);
      ok('   ...and no estHours on the record', !('estHours' in rec),
        JSON.stringify(Object.keys(rec)));
      ok('   ...and no estMinutes either', !('estMinutes' in rec),
        JSON.stringify(Object.keys(rec)));
    }
  }

  // The offline form refuses the same pairs the online one does.
  const cap2 = hookModal(h.ctx, { ...VALID, name: 'Bad Entry', category: 'Engine',
                                  estHours: '0', estMinutes: '60' });
  const countBefore = h.ctx.Storage.getData('services').length;
  h.els.get('addServiceBtn').dispatch('click', {});
  if (cap2.saveHandler) await cap2.saveHandler();
  check('60 in the minutes box is refused offline too',
    h.ctx.Storage.getData('services').length, countBefore);
}

summary('Service estimated time');
})();
