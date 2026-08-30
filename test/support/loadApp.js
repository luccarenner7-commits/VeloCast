'use strict';
// Loads index.html's single inline <script> into a fresh Node vm context so
// tests can call its top-level pure functions directly, without turning the
// app into a module system or duplicating its logic.
//
// Why a generic auto-stubbing DOM instead of a hand-built one: index.html's
// top level runs `render()` (via the trailing init() call), which walks the
// ENTIRE UI tree (every page, every card, Chart.js canvases, the Leaflet
// map, ...). Hand-stubbing every DOM method that path touches would be a
// large, constantly-drifting surface -- any future UI change could need a
// new stub method added here just to keep tests running, even though tests
// only care about six unrelated calculation functions. Since none of that
// DOM traffic is being asserted on, a permissive Proxy-based "stub element"
// that silently accepts and chains any property get/set/call is the
// pragmatic choice: it can't drift out of sync with the app's DOM usage,
// because it doesn't encode any assumption about what that usage *is*.
//
// Real assertions (localStorage, fetch, network) are NOT covered by this
// generic stub -- those are explicit, controlled fakes below, since tests
// (and this file's own verification) need to reason about them precisely.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', '..', 'index.html');

function extractInlineScript(html) {
  // Same technique as the project's ad-hoc syntax-check one-liners: the app
  // is one big inline <script>...</script> (no src=) containing all app
  // logic, preceded by two <script src="..."> CDN tags (Leaflet, Chart.js)
  // that must NOT be matched.
  const matches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one inline <script> (no src=) in index.html, found ${matches.length}. ` +
      `The extraction regex in test/support/loadApp.js may need updating.`
    );
  }
  return matches[0][1];
}

// A permissive "stub element": any property read returns a chainable
// stub/no-op function, any property write is stored and read back, and
// calling it as a function returns another stub. This is enough for the
// app's el() helper (createElement/className/setAttribute/addEventListener/
// appendChild/textContent) and for arbitrary deeper DOM traffic
// (style.xyz, classList.add(), querySelector(), scrollIntoView(), ...)
// touched during the top-level render() triggered by init(), all without
// hand-enumerating the DOM API surface render() happens to use today.
function makeStubNode() {
  const store = new Map();
  const target = function stubNode() {};
  const handler = {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        return () => '';
      }
      if (prop === 'nodeType') return 1;
      if (prop === 'children' || prop === 'childNodes') return [];
      if (prop === 'classList') {
        return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      }
      if (prop === 'dataset') return {};
      if (store.has(prop)) return store.get(prop);
      // Unknown property: return a stub that works both as a value and,
      // if invoked, as a method returning another stub (chainable).
      return makeStubNode();
    },
    set(_t, prop, value) {
      store.set(prop, value);
      return true;
    },
    has() { return true; },
    apply() {
      return makeStubNode();
    },
  };
  return new Proxy(target, handler);
}

function makeDocumentStub() {
  return {
    createElement() { return makeStubNode(); },
    createDocumentFragment() { return makeStubNode(); },
    createTextNode() { return makeStubNode(); },
    getElementById() { return makeStubNode(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    body: makeStubNode(),
    documentElement: makeStubNode(),
  };
}

// In-memory localStorage -- isolated per context, never touches the real
// filesystem/host storage.
function makeLocalStorageStub() {
  const data = new Map();
  return {
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
    clear() { data.clear(); },
  };
}

// Loads a fresh copy of the app script into a brand-new vm context and
// returns { ctx, get }, where `get(name)` reads a top-level binding
// (function/const/`state`) back out of that context's global scope.
//
// A fresh context per call is used (not shared/cached) so `state` mutations
// made by one test (e.g. buildPotentialChip() tests writing
// state.profilPage.riderProfile) can never leak into another test -- see
// the task's fresh-context-per-test guidance. Re-evaluating the ~11.6k line
// script per test is fast enough in practice for this suite's size.
function loadApp({ onFetchCall } = {}) {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const scriptSrc = extractInlineScript(html);

  const fetchStub = (...args) => {
    if (onFetchCall) onFetchCall(...args);
    return Promise.reject(new Error('fetch disabled in test sandbox (loadApp.js fetch stub)'));
  };

  const sandbox = {
    console,
    localStorage: makeLocalStorageStub(),
    fetch: fetchStub,
    navigator: { userAgent: 'node-test-sandbox', onLine: true },
    URLSearchParams,
    history: { replaceState() {} },
    requestAnimationFrame(cb) { return setTimeout(cb, 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    L: { map() { return makeStubNode(); }, tileLayer() { return makeStubNode(); }, marker() { return makeStubNode(); }, polyline() { return makeStubNode(); }, divIcon() { return makeStubNode(); }, latLngBounds() { return makeStubNode(); } },
    Chart: Object.assign(function StubChart() { return makeStubNode(); }, {
      defaults: { font: {}, plugins: { legend: {}, tooltip: {} }, scale: {} },
      register() {},
    }),
  };
  sandbox.document = makeDocumentStub();
  sandbox.window = sandbox; // scripts reference both bare globals and window.X for the same globals
  sandbox.window.location = { search: '', pathname: '/', href: 'http://localhost/' };
  sandbox.globalThis = sandbox;

  // Top-level `let`/`const` bindings (e.g. `let state = {...}`,
  // `const BEARING_SMOOTHING_WINDOW_KM = 0.2`) live in the script's lexical
  // scope, not as properties of the global object, so they don't come back
  // out through `ctx[name]` the way top-level `function` declarations do.
  // Appending one line in the SAME script text (same top-level scope) that
  // copies them onto the sandbox's global object exposes them without
  // touching index.html itself. Listed explicitly (rather than trying to
  // auto-discover every top-level const) so a typo here fails loudly as a
  // ReferenceError instead of silently returning undefined.
  const exposedSrc = `${scriptSrc}\n;globalThis.__exposed = { state, BEARING_SMOOTHING_WINDOW_KM, MMP_DURATIONS_SEC, CEILING_WINDOW_DAYS, computeTargetPressureBar, computeLossRateBarPerDay, updateLearnedRateBarPerDay, estimateCurrentPressureBar, isPressureLow, getWheelTargetBar, computeTirePressureReminder, defaultTirePressureData };\n`;

  const ctx = vm.createContext(sandbox);
  const script = new vm.Script(exposedSrc, { filename: 'index.html-inline-script.js' });
  script.runInContext(ctx);

  return {
    ctx,
    get(name) {
      if (Object.prototype.hasOwnProperty.call(ctx.__exposed, name)) return ctx.__exposed[name];
      return ctx[name];
    },
  };
}

module.exports = { loadApp, extractInlineScript, INDEX_HTML_PATH };
