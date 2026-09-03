'use strict';
// Segmentjäger: curated target-segment picker for an already-ridden Strava
// activity (see index.html's "---------- Segmentjäger ----------" section).
// Two pure/testable pieces per the task brief:
//   - segmentjaegerIsDefaultEligible()/segmentjaegerComputeDefaults(): the
//     default-selection-eligibility rule (8% KOM/QOM-closeness threshold OR
//     an already-top-10 effort on this specific ride).
//   - loadSegmentjaegerSelections()/saveSegmentjaegerSelection(): the
//     per-activity-id persistence helpers, same defensive-read discipline as
//     every other localStorage reader in this app (see
//     test/settings-migration.test.js for why that discipline matters).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

test('segmentjaegerIsDefaultEligible', async (t) => {
  const { get } = loadApp();
  const isEligible = get('segmentjaegerIsDefaultEligible');
  // Every call below passes showKomChip:true, showQomChip:true explicitly,
  // matching today's default-on settings (state.showKomChip/showQomChip
  // both default true) -- see the dedicated
  // "respects showKomChip/showQomChip" block below for the false cases.
  // None of these pass a 5th (potentialPercent) argument, so it's always
  // `undefined` here -- exercises the "no potential data available, can't
  // judge, don't exclude" fallback path (`!= null` treats undefined the same
  // as null) -- see the dedicated "SEGMENTJAEGER_POTENTIAL_CEILING" block
  // below for the cases where a real potential value is supplied.

  await t.test('no detail, no effort -> false (nothing to judge realism by)', () => {
    assert.equal(isEligible(null, null, true, true), false);
    assert.equal(isEligible(undefined, undefined, true, true), false);
  });

  await t.test('detail present but no PR ever recorded -> false via the record path, even with a KOM/QOM time', () => {
    const detail = { athlete_segment_stats: {}, xoms: { kom: '3:00' } };
    assert.equal(isEligible(detail, null, true, true), false);
  });

  await t.test('detail present but no xoms at all -> false via the record path, even with a PR', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 180 } };
    assert.equal(isEligible(detail, null, true, true), false);
  });

  await t.test('PR exactly at the 8% boundary -> eligible (boundary is inclusive, <=)', () => {
    // xom = 100s ("1:40"), pr = 108s -> (108-100)/100 = 0.08 exactly
    const detail = { athlete_segment_stats: { pr_elapsed_time: 108 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, null, true, true), true);
  });

  await t.test('PR just over the 8% boundary -> not eligible via the record path', () => {
    // pr = 109s -> (109-100)/100 = 0.09
    const detail = { athlete_segment_stats: { pr_elapsed_time: 109 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, null, true, true), false);
  });

  await t.test('PR already at or beating the record (zero/negative delta) -> eligible', () => {
    const atRecord = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { qom: '1:40' } };
    const beatsRecord = { athlete_segment_stats: { pr_elapsed_time: 90 }, xoms: { qom: '1:40' } };
    assert.equal(isEligible(atRecord, null, true, true), true);
    assert.equal(isEligible(beatsRecord, null, true, true), true);
  });

  await t.test('QOM checked independently of KOM -- close to QOM but no KOM time at all still counts', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { qom: '1:34' } }; // (100-94)/94 < 0.08
    assert.equal(isEligible(detail, null, true, true), true);
  });

  await t.test('far from both KOM and QOM, no top-10 effort -> not eligible', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 300 }, xoms: { kom: '1:40', qom: '1:45' } };
    assert.equal(isEligible(detail, null, true, true), false);
  });

  await t.test('already top-10 on the segment leaderboard this ride (kom_rank) -> eligible despite a huge gap', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 999 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, { kom_rank: 10 }, true, true), true);
    assert.equal(isEligible(detail, { kom_rank: 1 }, true, true), true);
  });

  await t.test('already top-10 on the athlete\'s own leaderboard this ride (pr_rank) -> eligible even with no detail at all', () => {
    assert.equal(isEligible(null, { pr_rank: 3 }, true, true), true);
  });

  await t.test('kom_rank/pr_rank present but outside top 10 (defensive guard) -> not eligible via that path alone', () => {
    assert.equal(isEligible(null, { kom_rank: 11 }, true, true), false);
    assert.equal(isEligible(null, { pr_rank: 25 }, true, true), false);
  });

  await t.test('unparseable xom string -> treated as missing, falls through to false unless top-10', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: 'not-a-duration' } };
    assert.equal(isEligible(detail, null, true, true), false);
    assert.equal(isEligible(detail, { kom_rank: 4 }, true, true), true);
  });

  await t.test('respects showKomChip/showQomChip: a suppressed chip\'s xom-closeness rule no longer contributes', () => {
    // Same detail as the "PR exactly at the 8% boundary" case above (would be
    // eligible via the KOM path when showKomChip is true) -- with
    // showKomChip:false, the KOM-gap rule must not fire, and there's no QOM
    // time here either, so this now falls through to false.
    const komDetail = { athlete_segment_stats: { pr_elapsed_time: 108 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(komDetail, null, false, true), false);
    // With showQomChip:false and only a QOM time present, same story.
    const qomDetail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { qom: '1:34' } };
    assert.equal(isEligible(qomDetail, null, true, false), false);
    // Both toggled off, both xoms present -> false via the record path
    // either way.
    const both = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40', qom: '1:34' } };
    assert.equal(isEligible(both, null, false, false), false);
    // The OTHER xom (QOM) still works when only showKomChip is off.
    const bothCloseQom = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '9:99', qom: '1:34' } };
    assert.equal(isEligible(bothCloseQom, null, false, true), true);
  });

  await t.test('the top-10-this-ride rule (kom_rank/pr_rank) stays active regardless of showKomChip/showQomChip -- it is the rider\'s own placement, not a KOM/QOM display fact', () => {
    assert.equal(isEligible(null, { kom_rank: 1 }, false, false), true);
    assert.equal(isEligible(null, { pr_rank: 1 }, false, false), true);
  });

  await t.test('SEGMENTJAEGER_POTENTIAL_CEILING: an otherwise record-eligible segment is excluded once potentialPercent reaches the ceiling', () => {
    const CEILING = get('SEGMENTJAEGER_POTENTIAL_CEILING');
    // Same at-record fixture as the earlier "PR already at or beating the
    // record" case -- would be eligible with no/low potential, per the
    // tests right below.
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, null, true, true, CEILING), false, 'exactly at the ceiling must exclude (>= is inclusive)');
    assert.equal(isEligible(detail, null, true, true, CEILING + 1), false, 'above the ceiling must exclude');
  });

  await t.test('the same record-eligible segment stays eligible below the potential ceiling, and when potential data is entirely unavailable', () => {
    const CEILING = get('SEGMENTJAEGER_POTENTIAL_CEILING');
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, null, true, true, CEILING - 1), true, 'just under the ceiling must not exclude');
    assert.equal(isEligible(detail, null, true, true, 0), true, 'low potential (lots of headroom) must not exclude');
    assert.equal(isEligible(detail, null, true, true, null), true, 'no potential data at all -- can\'t judge, falls back to the record-gap rule alone');
    assert.equal(isEligible(detail, null, true, true, undefined), true, 'undefined behaves the same as null (no 5th arg passed)');
  });

  await t.test('a segment NOT eligible via the record-gap rule stays ineligible regardless of potential -- the ceiling only ever excludes, never includes', () => {
    const farDetail = { athlete_segment_stats: { pr_elapsed_time: 300 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(farDetail, null, true, true, 0), false);
    assert.equal(isEligible(farDetail, null, true, true, 50), false);
  });

  await t.test('the top-10-this-ride rule stays eligible even at/above the potential ceiling -- an achieved placement is proof enough on its own, per explicit product decision', () => {
    const CEILING = get('SEGMENTJAEGER_POTENTIAL_CEILING');
    assert.equal(isEligible(null, { kom_rank: 1 }, true, true, CEILING), true);
    assert.equal(isEligible(null, { pr_rank: 1 }, true, true, 100), true);
  });
});

test('segmentjaegerComputeDefaults', async (t) => {
  const { get } = loadApp();
  const computeDefaults = get('segmentjaegerComputeDefaults');

  await t.test('builds one boolean per segment, keyed by segment id, independent of arrival order', () => {
    const segments = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const details = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } }, // eligible: at record (100s == 100s)
      2: { athlete_segment_stats: { pr_elapsed_time: 300 }, xoms: { kom: '1:00' } }, // not eligible via record: far off, no top10 either
      // 3: no detail at all
    };
    const efforts = {
      2: { kom_rank: 2 }, // eligible via top-10 despite the huge detail-based gap
      3: {}, // no detail, no rank -> not eligible
    };
    const result = computeDefaults(segments, details, efforts, true, true);
    assert.deepEqual(plain(result), { 1: true, 2: true, 3: false });
  });

  await t.test('empty segment list -> empty map', () => {
    assert.deepEqual(plain(computeDefaults([], {}, {}, true, true)), {});
  });

  await t.test('forwards showKomChip/showQomChip to every segment\'s eligibility check', () => {
    const segments = [{ id: 1 }];
    // Eligible via the KOM-gap rule when showKomChip is true, not eligible
    // when it's false (and there's no QOM data / top-10 effort to fall back
    // on) -- proves the flags actually reach segmentjaegerIsDefaultEligible()
    // per segment, not just accepted-and-ignored.
    const details = { 1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } } };
    assert.deepEqual(plain(computeDefaults(segments, details, {}, true, true)), { 1: true });
    assert.deepEqual(plain(computeDefaults(segments, details, {}, false, true)), { 1: false });
  });

  await t.test('forwards each segment\'s own potentials[seg.id] to its eligibility check, independent of the other segments', () => {
    const CEILING = get('SEGMENTJAEGER_POTENTIAL_CEILING');
    const segments = [{ id: 1 }, { id: 2 }, { id: 3 }];
    // All three are record-eligible on their own (same at-record fixture) --
    // only their potentials differ.
    const details = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      2: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      3: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
    };
    const potentials = { 1: CEILING, 2: CEILING - 1 }; // 3: no entry at all -> undefined
    const result = computeDefaults(segments, details, {}, true, true, potentials);
    assert.deepEqual(plain(result), { 1: false, 2: true, 3: true });
  });

  await t.test('a missing potentials argument entirely (undefined) never throws -- every segment falls back to "no data, don\'t exclude"', () => {
    const segments = [{ id: 1 }];
    const details = { 1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } } };
    assert.deepEqual(plain(computeDefaults(segments, details, {}, true, true)), { 1: true });
  });
});

test('Segmentjäger selection persistence (loadSegmentjaegerSelections/saveSegmentjaegerSelection)', async (t) => {
  await t.test('nothing saved yet -> empty object, not a throw', () => {
    const { get } = loadApp();
    assert.deepEqual(plain(get('loadSegmentjaegerSelections')()), {});
  });

  await t.test('malformed/corrupt JSON in the storage key is swallowed -- falls back to {}', () => {
    const key = 'velocast_segmentjaeger_selection';
    const { get } = loadApp({ initialLocalStorage: { [key]: '{not valid json' } });
    assert.deepEqual(plain(get('loadSegmentjaegerSelections')()), {});
  });

  await t.test('a top-level non-object (e.g. a bare number or array) is treated as absent -- {}', () => {
    const key = 'velocast_segmentjaeger_selection';
    const { get: getA } = loadApp({ initialLocalStorage: { [key]: '42' } });
    assert.deepEqual(plain(getA('loadSegmentjaegerSelections')()), {});
    const { get: getB } = loadApp({ initialLocalStorage: { [key]: '[1,2,3]' } });
    // An array is a JS "object" but has no meaningful activity-id entries --
    // Object.entries() on it yields index keys, each of whose values (plain
    // numbers) aren't objects either, so every entry is dropped.
    assert.deepEqual(plain(getB('loadSegmentjaegerSelections')()), {});
  });

  await t.test('round-trip: save then load returns exactly what was saved', () => {
    const { get } = loadApp();
    const save = get('saveSegmentjaegerSelection');
    const load = get('loadSegmentjaegerSelections');
    save(555, { 10: true, 20: false });
    assert.deepEqual(plain(load()), { 555: { 10: true, 20: false } });
  });

  await t.test('explicit false survives the round-trip (not coerced back to true/dropped)', () => {
    const { get } = loadApp();
    const save = get('saveSegmentjaegerSelection');
    const load = get('loadSegmentjaegerSelections');
    save(1, { 99: false });
    const result = load();
    assert.equal(result['1']['99'], false);
    assert.ok(Object.prototype.hasOwnProperty.call(result['1'], '99'), 'the false entry must actually be present, not dropped');
  });

  await t.test('non-boolean values inside a selection map are dropped (defensive read), booleans survive', () => {
    const key = 'velocast_segmentjaeger_selection';
    const { get } = loadApp({
      initialLocalStorage: {
        [key]: JSON.stringify({ 7: { a: true, b: false, c: 'true', d: 1, e: null } }),
      },
    });
    const result = plain(get('loadSegmentjaegerSelections')());
    assert.deepEqual(result['7'], { a: true, b: false });
  });

  await t.test('a selection entry that is not itself an object is dropped for that activity id, others unaffected', () => {
    const key = 'velocast_segmentjaeger_selection';
    const { get } = loadApp({
      initialLocalStorage: {
        [key]: JSON.stringify({ 1: 'not-an-object', 2: { a: true } }),
      },
    });
    const result = plain(get('loadSegmentjaegerSelections')());
    assert.deepEqual(result, { 2: { a: true } });
  });

  await t.test('per-activity-id isolation: saving one activity\'s selection never touches another\'s', () => {
    const { get } = loadApp();
    const save = get('saveSegmentjaegerSelection');
    const load = get('loadSegmentjaegerSelections');
    save(1, { a: true });
    save(2, { a: false });
    save(1, { a: false, b: true }); // overwrite activity 1 only
    const result = plain(load());
    assert.deepEqual(result, {
      1: { a: false, b: true },
      2: { a: false },
    });
  });

  await t.test('activity id is normalized to a string key both ways (numeric id in, string id out)', () => {
    const { get } = loadApp();
    const save = get('saveSegmentjaegerSelection');
    const load = get('loadSegmentjaegerSelections');
    save(42, { x: true });
    const result = load();
    assert.ok(Object.prototype.hasOwnProperty.call(result, '42'));
  });
});

test('ensureSegmentjaegerSelection', async (t) => {
  // Minimal fixture that satisfies ensureSegmentjaegerSelection()'s guard
  // (a genuine ridden activity, routeSegmentsFetched true, non-empty
  // routeSegments) without going through the real fetch pipeline.
  function activity(id) { return { id, isRoute: false, isGpx: false }; }

  await t.test('first-ever visit to an activity computes AND persists the defaults', () => {
    const { get } = loadApp();
    const state = get('state');
    const ensure = get('ensureSegmentjaegerSelection');
    state.selectedActivity = activity(777);
    state.routeSegmentsFetched = true;
    state.routeSegments = [{ id: 1 }, { id: 2 }];
    state.routeSegmentDetails = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } }, // eligible (at record)
      2: { athlete_segment_stats: { pr_elapsed_time: 300 }, xoms: { kom: '1:00' } }, // not eligible
    };
    state.routeSegmentEfforts = {};

    ensure();

    assert.deepEqual(plain(state.segmentjaegerSelection), { 1: true, 2: false });
    assert.equal(state.segmentjaegerSelectionActivityId, 777);
    // Persisted, not just held in memory -- a fresh read via
    // loadSegmentjaegerSelections() must see the same computed defaults.
    const persisted = plain(get('loadSegmentjaegerSelections')())['777'];
    assert.deepEqual(persisted, { 1: true, 2: false });
  });

  await t.test('an activity with an already-stored selection restores it instead of recomputing defaults', () => {
    const key = 'velocast_segmentjaeger_selection';
    // Deliberately disagrees with what segmentjaegerIsDefaultEligible() would
    // compute from routeSegmentDetails below (segment 1 would default to
    // true) -- proves restore-from-storage wins over recomputation.
    const { get } = loadApp({ initialLocalStorage: { [key]: JSON.stringify({ 99: { 1: false } }) } });
    const state = get('state');
    const ensure = get('ensureSegmentjaegerSelection');
    state.selectedActivity = activity(99);
    state.routeSegmentsFetched = true;
    state.routeSegments = [{ id: 1 }];
    state.routeSegmentDetails = { 1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } } };
    state.routeSegmentEfforts = {};

    ensure();

    assert.equal(state.segmentjaegerSelection[1], false, 'must restore the stored false, not recompute the true default');
    assert.equal(state.segmentjaegerSelectionActivityId, 99);
  });

  await t.test('revisiting the same activity does not recompute/overwrite an already-stored selection (a manual toggle survives)', () => {
    const { get } = loadApp();
    const state = get('state');
    const ensure = get('ensureSegmentjaegerSelection');
    const save = get('saveSegmentjaegerSelection');
    state.selectedActivity = activity(42);
    state.routeSegmentsFetched = true;
    state.routeSegments = [{ id: 1 }];
    // Default-eligible: true (at-record KOM).
    state.routeSegmentDetails = { 1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } } };
    state.routeSegmentEfforts = {};

    ensure(); // first visit: computes + persists the true default
    assert.equal(state.segmentjaegerSelection[1], true);

    // Manually toggle (same effect as toggleSegmentjaegerSelection(), minus
    // the render() call) and persist it, exactly as a real user override
    // would leave things.
    state.segmentjaegerSelection[1] = false;
    save(42, state.segmentjaegerSelection);

    // "Revisit" the same activity -- segmentjaegerSelectionActivityId is
    // still 42, so the once-per-activity guard must make this a no-op.
    ensure();

    assert.equal(state.segmentjaegerSelection[1], false, 'the manual override must survive a second visit, not revert to the computed default');
  });

  await t.test('a segment id missing from an existing stored selection falls back to deselected (false)', () => {
    const key = 'velocast_segmentjaeger_selection';
    const { get } = loadApp({ initialLocalStorage: { [key]: JSON.stringify({ 5: { 1: true } }) } }); // segment 2 has no stored key
    const state = get('state');
    const ensure = get('ensureSegmentjaegerSelection');
    state.selectedActivity = activity(5);
    state.routeSegmentsFetched = true;
    state.routeSegments = [{ id: 1 }, { id: 2 }];
    state.routeSegmentDetails = {};
    state.routeSegmentEfforts = {};

    ensure();

    assert.deepEqual(plain(state.segmentjaegerSelection), { 1: true, 2: false });
  });

  await t.test('end-to-end: a maxed-out-potential segment is excluded by ensureSegmentjaegerSelection() itself, not just by the underlying pure helpers', () => {
    // Proves the segmentBucket("route")/segmentPotentialValue() wiring
    // inside ensureSegmentjaegerSelection() is actually connected -- the
    // unit tests above only exercise segmentjaegerIsDefaultEligible()/
    // segmentjaegerComputeDefaults() directly with a hand-built
    // potentialPercent, they don't prove ensureSegmentjaegerSelection()
    // itself computes that number correctly from state.
    const { get } = loadApp();
    const state = get('state');
    const ensure = get('ensureSegmentjaegerSelection');
    state.selectedActivity = activity(555);
    state.routeSegmentsFetched = true;
    state.routeSegments = [{ id: 1 }, { id: 2 }];
    // Both segments are record-eligible on their own (at-record KOM).
    state.routeSegmentDetails = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      2: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
    };
    state.routeSegmentEfforts = {
      1: { elapsed_time: 300 }, // matches the mmpCurve point below exactly
      2: { elapsed_time: 300 },
    };
    // Segment 1's own ride watts equal the rider's MMP-curve ceiling for
    // that duration -> 100% potential, well above the 95% ceiling.
    // Segment 2's ride watts are well under the ceiling -> low potential,
    // stays eligible.
    state.routeSegmentPrWatts = {
      1: { watts: 300, measured: true },
      2: { watts: 150, measured: true },
    };
    state.profilPage.riderProfile = { mmpCurve: { 180: 300, 300: 300 } };

    ensure();

    assert.deepEqual(plain(state.segmentjaegerSelection), { 1: false, 2: true });
  });
});

// The row click handler (renderSegmentjaegerRow()'s onclick) -- flips one
// segment's membership and persists the WHOLE updated map immediately, not
// just on navigating away, so a toggle survives even an unexpected tab
// close. Verified live in a real browser against the actual app (a genuine
// DOM .click() on a rendered row) during this feature's manual verification
// pass; these tests cover the same logic at the unit level so a regression
// here fails fast without needing a browser.
test('toggleSegmentjaegerSelection', async (t) => {
  function activity(id) { return { id, isRoute: false, isGpx: false }; }

  await t.test('flips a selected segment to deselected', () => {
    const { get } = loadApp();
    const state = get('state');
    const toggle = get('toggleSegmentjaegerSelection');
    state.selectedActivity = activity(1);
    state.segmentjaegerSelection = { 7: true };

    toggle({ id: 7 });

    assert.equal(state.segmentjaegerSelection[7], false);
  });

  await t.test('flips a deselected segment to selected', () => {
    const { get } = loadApp();
    const state = get('state');
    const toggle = get('toggleSegmentjaegerSelection');
    state.selectedActivity = activity(1);
    state.segmentjaegerSelection = { 7: false };

    toggle({ id: 7 });

    assert.equal(state.segmentjaegerSelection[7], true);
  });

  await t.test('a segment id with no prior entry toggles from falsy (undefined) to true', () => {
    const { get } = loadApp();
    const state = get('state');
    const toggle = get('toggleSegmentjaegerSelection');
    state.selectedActivity = activity(1);
    state.segmentjaegerSelection = {};

    toggle({ id: 9 });

    assert.equal(state.segmentjaegerSelection[9], true);
  });

  await t.test('persists the toggle immediately, keyed by the current activity id', () => {
    const { get } = loadApp();
    const state = get('state');
    const toggle = get('toggleSegmentjaegerSelection');
    const load = get('loadSegmentjaegerSelections');
    state.selectedActivity = activity(321);
    state.segmentjaegerSelection = { 7: true, 8: false };

    toggle({ id: 8 });

    const persisted = plain(load())['321'];
    assert.deepEqual(persisted, { 7: true, 8: true });
  });

  await t.test('no-op (does not throw) when no activity is selected', () => {
    const { get } = loadApp();
    const state = get('state');
    const toggle = get('toggleSegmentjaegerSelection');
    state.selectedActivity = null;
    state.segmentjaegerSelection = { 7: true };

    assert.doesNotThrow(() => toggle({ id: 7 }));
    assert.equal(state.segmentjaegerSelection[7], true, 'selection must stay untouched with no activity selected');
  });

  await t.test('toggling one segment does not affect another segment\'s stored state', () => {
    const { get } = loadApp();
    const state = get('state');
    const toggle = get('toggleSegmentjaegerSelection');
    state.selectedActivity = activity(1);
    state.segmentjaegerSelection = { 7: true, 8: false, 9: true };

    toggle({ id: 8 });

    assert.deepEqual(plain(state.segmentjaegerSelection), { 7: true, 8: true, 9: true });
  });
});
