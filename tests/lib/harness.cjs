/* Shared harness: boots the REAL shipped js/ modules in Node with the
   minimum localStorage + DOM they touch. No source is copied or rewritten. */
const fs = require('fs'), vm = require('vm'), path = require('path');
// Repo root, derived from this file's location (tests/lib/ -> ../..),
// so the suites run from any checkout rather than one hardcoded path.
const ROOT = path.resolve(__dirname, '..', '..');

function makeElement(id) {
  return { id, _html: '', _text: '',
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set value(v) { this._value = v; }, get value() { return this._value ?? ''; },
    _on: {},
    addEventListener(t, cb) { (this._on[t] = this._on[t] || []).push(cb); },
    dispatch(t, ev) { (this._on[t] || []).forEach(cb => cb(ev || { target: this })); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, appendChild() {}, remove() {}, prepend() {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    dataset: {}, style: {}, setAttribute(){}, focus(){} };
}

function boot({ modules = [], tz, fetch: fetchStub, origin } = {}) {
  if (tz) process.env.TZ = tz;
  const store = new Map();
  const els = new Map();
  const listeners = [];
  const doc = {
    addEventListener(ev, cb) { if (ev === 'DOMContentLoaded') listeners.push(cb); },
    removeEventListener() {},
    getElementById(id) { if (!els.has(id)) els.set(id, makeElement(id)); return els.get(id); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement(tag) { return makeElement(tag); },
    body: makeElement('body'), documentElement: makeElement('html'),
    readyState: 'loading',
  };
  doc.body.dataset = {}; doc.documentElement.dataset = {};

  const ctx = {
    console,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); }, clear: () => store.clear(),
    },
    document: doc,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    requestAnimationFrame: cb => cb(), setTimeout, clearTimeout,
    Date, Math, JSON, Number, String, Object, Array, Map, Set, isNaN, parseInt, parseFloat,
    URLSearchParams, location: { search: '', origin: origin || '' },
    Promise, AbortController, TextEncoder, Error, Boolean, Symbol,
    fetch: fetchStub,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  for (const m of ['js/api.js', 'js/seed-data.js', 'js/storage.js', 'js/utils.js', ...modules]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, m), 'utf8'), ctx, { filename: m });
  }
  // Top-level const/let in a VM script live in the context's global LEXICAL
  // scope -- shared between scripts, but not properties of the context object.
  // Copy the module singletons onto globalThis so the host side can reach them.
  vm.runInContext(
    ['Api', 'Storage', 'Utils', 'SeedData', 'App'].map(n =>
      `try { globalThis.${n} = ${n}; } catch (e) {}`).join('\n'), ctx);

  // fireReady() is "the page finished parsing": the document stops being
  // 'loading' and the DOMContentLoaded handlers run -- which is where the
  // modules' Storage.ready() gate picks up.
  return { ctx, els, fireReady: () => { doc.readyState = 'complete'; listeners.forEach(cb => cb()); } };
}

/* tiny assertion runner */
let pass = 0, fail = 0;
const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  results.push({ ok, name, actual, expected });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(name, cond, detail = '') {
  cond ? pass++ : fail++;
  results.push({ ok: !!cond, name });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
}
function summary(label) {
  console.log(`\n${label}: ${pass} passed, ${fail} failed`);
  return fail;
}
module.exports = { boot, check, ok, summary, makeElement };
