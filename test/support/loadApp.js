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
// filesystem/host storage. `seed` pre-populates entries (e.g. a serialized
// "velocast_settings" blob) so top-level code that reads localStorage
// during script evaluation itself (e.g. `const savedSettings =
// loadSettings()` at index.html's top level) sees them, which a post-load
// localStorage.setItem() call could never do.
function makeLocalStorageStub(seed) {
  const data = new Map(Object.entries(seed || {}));
  return {
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
    clear() { data.clear(); },
  };
}

// Minimal GPX-only DOMParser stub -- NOT a general XML/DOM parser. Supports
// exactly the narrow surface parseGpxTrack() (index.html, "---------- GPX
// import ----------" section) exercises: `new DOMParser().parseFromString(xml,
// mime)` -> a "document" exposing `.querySelector("parsererror")` (a truthy
// value on malformed/non-XML input, falsy otherwise -- used purely as an
// early-bail error signal) and `.querySelectorAll("trkpt, rtept")` (an
// iterable of element-stubs, immediately spread into an array by the caller).
// Each element-stub exposes `.getAttribute("lat"|"lon")` (string or null) and
// `.querySelector("ele")` (another element-stub, or null, with `.textContent`
// giving the elevation string). Implemented with plain regex scanning rather
// than a real parser -- this repo deliberately ships zero npm dependencies
// (no jsdom, no XML library; see package.json), and DOMParser has exactly one
// call site in the whole app, so a hand-written stub covering only that
// call's actual usage is the right amount of machinery.
function makeGpxNodeStub(innerXml, attrs) {
  return {
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    querySelector(selector) {
      if (selector !== 'ele') return null;
      const m = /<ele\b[^>]*>([\s\S]*?)<\/ele>/.exec(innerXml);
      return m ? { textContent: m[1] } : null;
    },
  };
}
function parseGpxAttrs(attrsStr) {
  const attrs = {};
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(attrsStr))) attrs[m[1]] = m[2];
  return attrs;
}
class DOMParserStub {
  parseFromString(xmlText) {
    const text = String(xmlText == null ? '' : xmlText);
    // Heuristic "well-formed enough" check, used only to decide
    // querySelector("parsererror")'s truthy/falsy return -- parseGpxTrack()
    // bails early on it as a signal and nothing else in the app depends on
    // it being precise, so "does this even start like XML" is enough: text
    // must open with an XML declaration or an opening tag.
    const looksLikeXml = /^\s*(<\?xml\b|<[a-zA-Z])/.test(text);
    return {
      querySelector(selector) {
        if (selector === 'parsererror') return looksLikeXml ? null : { textContent: 'not well-formed' };
        return null;
      },
      querySelectorAll(selector) {
        if (selector !== 'trkpt, rtept') return [];
        const out = [];
        const tagRe = /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
        let m;
        while ((m = tagRe.exec(text))) {
          out.push(makeGpxNodeStub(m[3] || '', parseGpxAttrs(m[2] || '')));
        }
        return out;
      },
    };
  }
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
function loadApp({ onFetchCall, initialLocalStorage } = {}) {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const scriptSrc = extractInlineScript(html);

  const fetchStub = (...args) => {
    if (onFetchCall) onFetchCall(...args);
    return Promise.reject(new Error('fetch disabled in test sandbox (loadApp.js fetch stub)'));
  };

  const sandbox = {
    console,
    localStorage: makeLocalStorageStub(initialLocalStorage),
    fetch: fetchStub,
    navigator: { userAgent: 'node-test-sandbox', onLine: true },
    DOMParser: DOMParserStub,
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
  const exposedSrc = `${scriptSrc}\n;globalThis.__exposed = { state, BEARING_SMOOTHING_WINDOW_KM, MMP_DURATIONS_SEC, CEILING_WINDOW_DAYS, POWER_ZONE_META, computeTargetPressureBar, computeLossRateFractionPerDay, updateLearnedRateFractionPerDay, estimateCurrentPressureBar, isPressureLow, getWheelTargetBar, computeTirePressureReminder, defaultTirePressureData, defaultTireWheelData, loadTirePressureData, TIRE_PRESSURE_KEY, TIRE_PRESSURE_DEFAULT_RATE_FRACTION_PER_DAY, TIRE_PRESSURE_MAX_FRACTION_PER_DAY, applyNachmessenUpdate, gearWearStatus, sumRiddenDistanceM, getChainWearDistanceM, computeChainWearReminder, applyChainWearReset, defaultChainWearData, loadAktivitaetenListCache, saveAktivitaetenListCache, decodePolyline, haversineKm, buildCumulativeDistances, estimateArrival, indexAtDistance, weightedLinearRegression, parseIsoDateUTC, toIsoDate, addDaysUTC, mondayOfUTC, computeTestDueSignal, TEST_DURATIONS_SEC, TEST_DURATION_CLASS, TEST_STALENESS_DAYS, xmlEscape, fitCrc, fitString, slugify, segmentjaegerIsDefaultEligible, segmentjaegerComputeDefaults, segmentjaegerFavorableWind, segmentjaegerGapSeconds, loadSegmentjaegerSelections, saveSegmentjaegerSelection, ensureSegmentjaegerSelection, toggleSegmentjaegerSelection, SEGMENTJAEGER_XOM_TOLERANCE, SEGMENTJAEGER_SELECTION_KEY, SEGMENTJAEGER_POTENTIAL_CEILING, segmentPotentialValue, loadLocalFavoriteSegments, saveLocalFavoriteSegments, isLocalFavorite, toggleLocalFavorite, migrateStarredSegmentsToLocalFavorites, mergeFavoritesFromStarred, LOCAL_FAVORITES_KEY, LOCAL_FAVORITES_MIGRATED_KEY, fetchStarredSegments, segmentjaegerComputeStarSyncPlan, syncSegmentjaegerStars, applySegmentStar, resetRouteSegments, computeSegmentStatChips, computeRideEffortStatChips, buildXomChip, segmentIsStarred, fmtDuration, parseDuration, evaluateWorkout, TRAINING_CONFIG, buildZwo, buildFit, buildCourseFit, downsampleRoutePoints, stepTargetValue, computeSyncMergePlan, SYNC_KEYS, smoothElevation, computeCurvature, detectIntersectionCandidates, analyzeRoute, placeIntervalsOnRoute, classPerformanceScores, computeTrainingPriorities, computeWeeklyBudgetTargets, weeklyClassProgress, reconcileWeeklyBudgets, computeTrainingDecisionState, pickIntendedTrainingClass, computeTrainingOpportunity, TRAINING_CLASSES, scoreRouteWindForStartTime, pickRecommendedRoutes };\n`;

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
