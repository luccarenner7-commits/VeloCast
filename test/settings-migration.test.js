'use strict';
// Settings migration: the old single `autoLoadOnVisit` flag was split into
// three granular flags (autoLoadActivities/autoLoadSegments/autoLoadTraining)
// -- see index.html's `state` literal and TODO.md's "Auto-Load granular
// einstellbar" entry. Flagged explicitly in the 2026-09-03 test-coverage
// audit as exactly the "silently breaks" risk shape: a migration path that
// isn't exercised by any real user's localStorage until it ships.
//
// This needs test/support/loadApp.js's `initialLocalStorage` option (added
// alongside this test) since `state` (and its migration fallback chain) is
// computed once at the app's top-level script evaluation, from
// `loadSettings()` reading `localStorage["velocast_settings"]` -- a
// pre-existing value must be in place BEFORE the script runs, which a
// post-load localStorage.setItem() call could never achieve.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function settingsBlob(obj) {
  return { velocast_settings: JSON.stringify(obj) };
}

test('auto-load settings migration (autoLoadOnVisit -> 3 granular flags)', async (t) => {
  await t.test('no saved settings at all (brand-new user) -> all three default to true', () => {
    const { get } = loadApp();
    const state = get('state');
    assert.equal(state.autoLoadActivities, true);
    assert.equal(state.autoLoadSegments, true);
    assert.equal(state.autoLoadTraining, true);
  });

  await t.test('old-flag-only settings blob, autoLoadOnVisit=false -> all three fall back to false', () => {
    const { get } = loadApp({ initialLocalStorage: settingsBlob({ autoLoadOnVisit: false }) });
    const state = get('state');
    assert.equal(state.autoLoadActivities, false);
    assert.equal(state.autoLoadSegments, false);
    assert.equal(state.autoLoadTraining, false);
  });

  await t.test('old-flag-only settings blob, autoLoadOnVisit=true -> all three fall back to true', () => {
    const { get } = loadApp({ initialLocalStorage: settingsBlob({ autoLoadOnVisit: true }) });
    const state = get('state');
    assert.equal(state.autoLoadActivities, true);
    assert.equal(state.autoLoadSegments, true);
    assert.equal(state.autoLoadTraining, true);
  });

  await t.test('new-flags-present settings blob -> old autoLoadOnVisit is ignored entirely, even if contradictory', () => {
    const { get } = loadApp({
      initialLocalStorage: settingsBlob({
        autoLoadOnVisit: true, // contradicts the new flags below on purpose
        autoLoadActivities: false,
        autoLoadSegments: true,
        autoLoadTraining: false,
      }),
    });
    const state = get('state');
    assert.equal(state.autoLoadActivities, false);
    assert.equal(state.autoLoadSegments, true);
    assert.equal(state.autoLoadTraining, false);
  });

  await t.test('a mix -- one new flag explicitly saved, others still on the old flag -- resolves each independently', () => {
    const { get } = loadApp({
      initialLocalStorage: settingsBlob({
        autoLoadOnVisit: false,
        autoLoadSegments: true, // explicitly overridden back on
      }),
    });
    const state = get('state');
    assert.equal(state.autoLoadActivities, false); // falls back to autoLoadOnVisit=false
    assert.equal(state.autoLoadSegments, true); // explicit override wins
    assert.equal(state.autoLoadTraining, false); // falls back to autoLoadOnVisit=false
  });

  await t.test('malformed/corrupt JSON in the settings key is swallowed -- falls back to all defaults, not a thrown error', () => {
    const { get } = loadApp({ initialLocalStorage: { velocast_settings: '{not valid json' } });
    const state = get('state');
    assert.equal(state.autoLoadActivities, true);
    assert.equal(state.autoLoadSegments, true);
    assert.equal(state.autoLoadTraining, true);
  });

  await t.test('explicit false on a new flag survives (not coerced back to true by `||`-style fallback)', () => {
    // Regression guard for the `!= null` (not `||`) pattern documented at
    // this state field's definition -- an explicit saved `false` must
    // survive, unlike a naive `savedSettings.autoLoadActivities || true`
    // which would silently ignore an explicit false.
    const { get } = loadApp({ initialLocalStorage: settingsBlob({ autoLoadActivities: false }) });
    assert.equal(get('state').autoLoadActivities, false);
  });
});
