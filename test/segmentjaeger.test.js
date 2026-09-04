'use strict';
// Segmentjäger: curated target-segment picker for an already-ridden Strava
// activity (see index.html's "---------- Segmentjäger ----------" section).
// Pure/testable pieces per the task brief:
//   - segmentjaegerIsDefaultEligible()/segmentjaegerComputeDefaults(): the
//     default-selection-eligibility rule (8% KOM/QOM-closeness threshold,
//     below the potential ceiling, with a confirmed tailwind). No "already
//     top-10 on this ride" bypass anymore -- removed 04.09.2026, see
//     segmentjaegerIsDefaultEligible()'s comment in index.html for why.
//   - segmentjaegerGapSeconds()/the minimum-gap pass inside
//     segmentjaegerComputeDefaults(): suppresses an otherwise-eligible
//     segment that starts too soon after the last SELECTED one, so two
//     back-to-back full-gas targets can't both land in the default
//     selection with no recovery in between.
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

// Minimal segment fixture -- same shape convention as
// test/local-favorites.test.js's own seg() helper. Only used by the
// segmentjaegerComputeStarSyncPlan()/syncSegmentjaegerStars() tests below,
// which need actual segment objects (not just ids) since the plan carries
// full segments in toStar/toUnstar.
function seg(id, extra) {
  return Object.assign({ id, name: `Segment ${id}`, distance: 1000, average_grade: 3 }, extra || {});
}

test('segmentjaegerIsDefaultEligible', async (t) => {
  const { get } = loadApp();
  const isEligible = get('segmentjaegerIsDefaultEligible');
  // Every call below passes showKomChip:true, showQomChip:true explicitly,
  // matching today's default-on settings (state.showKomChip/showQomChip
  // both default true) -- see the dedicated
  // "respects showKomChip/showQomChip" block below for the false cases.
  // None of these pass a 4th (potentialPercent) argument, so it's always
  // `undefined` here -- exercises the "no potential data available, can't
  // judge, don't exclude" fallback path (`!= null` treats undefined the same
  // as null) -- see the dedicated "SEGMENTJAEGER_POTENTIAL_CEILING" block
  // below for the cases where a real potential value is supplied.

  await t.test('no detail -> false (nothing to judge realism by)', () => {
    assert.equal(isEligible(null, true, true), false);
    assert.equal(isEligible(undefined, true, true), false);
  });

  await t.test('detail present but no PR ever recorded -> false via the record path, even with a KOM/QOM time', () => {
    const detail = { athlete_segment_stats: {}, xoms: { kom: '3:00' } };
    assert.equal(isEligible(detail, true, true), false);
  });

  await t.test('detail present but no xoms at all -> false via the record path, even with a PR', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 180 } };
    assert.equal(isEligible(detail, true, true), false);
  });

  await t.test('PR exactly at the 8% boundary -> eligible (boundary is inclusive, <=)', () => {
    // xom = 100s ("1:40"), pr = 108s -> (108-100)/100 = 0.08 exactly
    const detail = { athlete_segment_stats: { pr_elapsed_time: 108 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, true, true), true);
  });

  await t.test('PR just over the 8% boundary -> not eligible via the record path', () => {
    // pr = 109s -> (109-100)/100 = 0.09
    const detail = { athlete_segment_stats: { pr_elapsed_time: 109 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, true, true), false);
  });

  await t.test('PR already at or beating the record (zero/negative delta) -> eligible', () => {
    const atRecord = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { qom: '1:40' } };
    const beatsRecord = { athlete_segment_stats: { pr_elapsed_time: 90 }, xoms: { qom: '1:40' } };
    assert.equal(isEligible(atRecord, true, true), true);
    assert.equal(isEligible(beatsRecord, true, true), true);
  });

  await t.test('QOM checked independently of KOM -- close to QOM but no KOM time at all still counts', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { qom: '1:34' } }; // (100-94)/94 < 0.08
    assert.equal(isEligible(detail, true, true), true);
  });

  await t.test('far from both KOM and QOM -> not eligible', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 300 }, xoms: { kom: '1:40', qom: '1:45' } };
    assert.equal(isEligible(detail, true, true), false);
  });

  await t.test('unparseable xom string -> treated as missing, falls through to false', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: 'not-a-duration' } };
    assert.equal(isEligible(detail, true, true), false);
  });

  await t.test('respects showKomChip/showQomChip: a suppressed chip\'s xom-closeness rule no longer contributes', () => {
    // Same detail as the "PR exactly at the 8% boundary" case above (would be
    // eligible via the KOM path when showKomChip is true) -- with
    // showKomChip:false, the KOM-gap rule must not fire, and there's no QOM
    // time here either, so this now falls through to false.
    const komDetail = { athlete_segment_stats: { pr_elapsed_time: 108 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(komDetail, false, true), false);
    // With showQomChip:false and only a QOM time present, same story.
    const qomDetail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { qom: '1:34' } };
    assert.equal(isEligible(qomDetail, true, false), false);
    // Both toggled off, both xoms present -> false via the record path
    // either way.
    const both = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40', qom: '1:34' } };
    assert.equal(isEligible(both, false, false), false);
    // The OTHER xom (QOM) still works when only showKomChip is off.
    const bothCloseQom = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '9:99', qom: '1:34' } };
    assert.equal(isEligible(bothCloseQom, false, true), true);
  });

  await t.test('SEGMENTJAEGER_POTENTIAL_CEILING: an otherwise record-eligible segment is excluded once potentialPercent reaches the ceiling', () => {
    const CEILING = get('SEGMENTJAEGER_POTENTIAL_CEILING');
    // Same at-record fixture as the earlier "PR already at or beating the
    // record" case -- would be eligible with no/low potential, per the
    // tests right below.
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, true, true, CEILING), false, 'exactly at the ceiling must exclude (>= is inclusive)');
    assert.equal(isEligible(detail, true, true, CEILING + 1), false, 'above the ceiling must exclude');
  });

  await t.test('the same record-eligible segment stays eligible below the potential ceiling, and when potential data is entirely unavailable', () => {
    const CEILING = get('SEGMENTJAEGER_POTENTIAL_CEILING');
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, true, true, CEILING - 1), true, 'just under the ceiling must not exclude');
    assert.equal(isEligible(detail, true, true, 0), true, 'low potential (lots of headroom) must not exclude');
    assert.equal(isEligible(detail, true, true, null), true, 'no potential data at all -- can\'t judge, falls back to the record-gap rule alone');
    assert.equal(isEligible(detail, true, true, undefined), true, 'undefined behaves the same as null (no 4th arg passed)');
  });

  await t.test('a segment NOT eligible via the record-gap rule stays ineligible regardless of potential -- the ceiling only ever excludes, never includes', () => {
    const farDetail = { athlete_segment_stats: { pr_elapsed_time: 300 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(farDetail, true, true, 0), false);
    assert.equal(isEligible(farDetail, true, true, 50), false);
  });

  await t.test('wind gate: an otherwise record-eligible segment is excluded when there is no confirmed tailwind (cross/head)', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, true, true, null, false), false, 'a confirmed non-tailwind reading must exclude');
  });

  await t.test('wind gate: stays eligible with a confirmed tailwind, or when wind data is unavailable', () => {
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, true, true, null, true), true, 'confirmed tailwind must not exclude');
    assert.equal(isEligible(detail, true, true, null, null), true, 'no wind data at all -- can\'t judge, falls back to the other criteria');
    assert.equal(isEligible(detail, true, true, null, undefined), true, 'undefined behaves the same as null (no 5th arg passed)');
  });

  await t.test('a segment NOT eligible via the record-gap rule stays ineligible regardless of wind -- the wind gate only ever excludes, never includes on its own', () => {
    const farDetail = { athlete_segment_stats: { pr_elapsed_time: 300 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(farDetail, true, true, null, true), false);
  });

  await t.test('a segment excluded by the potential ceiling stays excluded even with a favorable wind -- both gates must pass', () => {
    const CEILING = get('SEGMENTJAEGER_POTENTIAL_CEILING');
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } };
    assert.equal(isEligible(detail, true, true, CEILING, true), false);
  });
});

test('segmentjaegerFavorableWind', async (t) => {
  const { get } = loadApp();
  const favorableWind = get('segmentjaegerFavorableWind');
  // Heading due north (same longitude, increasing latitude) -- bearing ~0deg.
  const northSeg = { start_latlng: [48.0, 11.0], end_latlng: [48.01, 11.0] };

  await t.test('a tailwind (wind blowing the same direction as travel) -> true', () => {
    // windDir=180 means wind FROM the south, i.e. blowing due north -- same
    // direction as the segment -> tailwind.
    assert.equal(favorableWind(northSeg, { windDir: 180 }), true);
  });

  await t.test('a headwind -> false', () => {
    // windDir=0 means wind FROM the north, blowing due south -- straight
    // into a due-north-traveling segment -> headwind.
    assert.equal(favorableWind(northSeg, { windDir: 0 }), false);
  });

  await t.test('a crosswind -> false (only a confirmed tailwind counts, per explicit product decision)', () => {
    assert.equal(favorableWind(northSeg, { windDir: 90 }), false);
  });

  await t.test('no weather data -> null ("can\'t judge", not "unfavorable")', () => {
    assert.equal(favorableWind(northSeg, null), null);
    assert.equal(favorableWind(northSeg, undefined), null);
  });

  await t.test('segment missing start/end coords -> null, even with weather data present', () => {
    assert.equal(favorableWind({}, { windDir: 180 }), null);
    assert.equal(favorableWind({ start_latlng: [48, 11] }, { windDir: 180 }), null, 'missing end_latlng alone still can\'t compute a bearing');
  });
});

test('segmentjaegerGapSeconds', async (t) => {
  const { get } = loadApp();
  const gapSeconds = get('segmentjaegerGapSeconds');

  await t.test('normal case: effortB starts after effortA ends, by the expected number of seconds', () => {
    // effortA: starts at t=0, runs 100s -> ends at t=100s. effortB starts at
    // t=400s -> 300s gap.
    const effortA = { start_date: '2026-09-04T10:00:00Z', elapsed_time: 100 };
    const effortB = { start_date: '2026-09-04T10:06:40Z', elapsed_time: 50 }; // +400s from effortA's start
    assert.equal(gapSeconds(effortA, effortB), 300);
  });

  await t.test('overlapping/reversed segments -> negative gap, returned as-is (not clamped)', () => {
    const effortA = { start_date: '2026-09-04T10:00:00Z', elapsed_time: 300 }; // ends at t=300s
    const effortB = { start_date: '2026-09-04T10:04:00Z', elapsed_time: 50 }; // starts at t=240s, before A ends
    assert.equal(gapSeconds(effortA, effortB), -60);
  });

  await t.test('missing effortA or effortB entirely -> null', () => {
    const effort = { start_date: '2026-09-04T10:00:00Z', elapsed_time: 100 };
    assert.equal(gapSeconds(null, effort), null);
    assert.equal(gapSeconds(effort, null), null);
    assert.equal(gapSeconds(undefined, undefined), null);
  });

  await t.test('missing start_date on either side -> null', () => {
    const effort = { start_date: '2026-09-04T10:00:00Z', elapsed_time: 100 };
    assert.equal(gapSeconds({ elapsed_time: 100 }, effort), null, 'effortA missing start_date');
    assert.equal(gapSeconds(effort, { elapsed_time: 100 }), null, 'effortB missing start_date');
  });

  await t.test('missing elapsed_time on effortA is treated as 0 (not null) -- still computes a gap', () => {
    const effortA = { start_date: '2026-09-04T10:00:00Z' }; // no elapsed_time
    const effortB = { start_date: '2026-09-04T10:01:00Z', elapsed_time: 10 };
    assert.equal(gapSeconds(effortA, effortB), 60);
  });
});

test('segmentjaegerComputeDefaults', async (t) => {
  const { get } = loadApp();
  const computeDefaults = get('segmentjaegerComputeDefaults');

  await t.test('builds one boolean per segment, keyed by segment id, independent of arrival order', () => {
    const segments = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const details = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } }, // eligible: at record (100s == 100s)
      2: { athlete_segment_stats: { pr_elapsed_time: 300 }, xoms: { kom: '1:00' } }, // not eligible via record: far off
      // 3: no detail at all -> not eligible
    };
    const result = computeDefaults(segments, details, {}, true, true);
    assert.deepEqual(plain(result), { 1: true, 2: false, 3: false });
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

  await t.test('forwards each segment\'s own winds[seg.id] to its eligibility check, independent of the other segments', () => {
    const segments = [{ id: 1 }, { id: 2 }, { id: 3 }];
    // All three are record-eligible on their own -- only their wind reading differs.
    const details = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      2: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      3: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
    };
    const winds = { 1: false, 2: true }; // 3: no entry at all -> undefined
    const result = computeDefaults(segments, details, {}, true, true, null, winds);
    assert.deepEqual(plain(result), { 1: false, 2: true, 3: true });
  });

  await t.test('a missing winds argument entirely (undefined) never throws -- every segment falls back to "no data, don\'t exclude"', () => {
    const segments = [{ id: 1 }];
    const details = { 1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } } };
    assert.deepEqual(plain(computeDefaults(segments, details, {}, true, true, null)), { 1: true });
  });

  // Minimum-gap pass: `segments` must be in ride-chronological order (as it
  // always is when built from state.routeSegments, see ensureRideSegments()).
  await t.test('two otherwise-eligible segments too close together -> only the chronologically earlier one stays selected', () => {
    const segments = [{ id: 1 }, { id: 2 }];
    const details = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      2: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
    };
    const efforts = {
      1: { start_date: '2026-09-04T10:00:00Z', elapsed_time: 100 }, // ends at t=100s
      2: { start_date: '2026-09-04T10:02:00Z', elapsed_time: 50 }, // starts at t=120s -> 20s gap
    };
    const result = computeDefaults(segments, details, efforts, true, true, null, null, 300); // 300s minimum
    assert.deepEqual(plain(result), { 1: true, 2: false });
  });

  await t.test('a chain of three closely-spaced eligible segments -> only the first stays (a suppressed segment never becomes the new reference point)', () => {
    const segments = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const details = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      2: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      3: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
    };
    // Segment 1 ends at t=100s. Segment 2 starts at t=150s (50s gap -> too
    // close, suppressed). Segment 3 starts at t=200s -- only 50s after
    // segment 2's start, but if the gap were (wrongly) measured from
    // segment 2 it would still read as "too close"; measured correctly from
    // segment 1 (the last actually SELECTED one) it's 100s since segment 1
    // ended (t=100s -> t=200s), still under the 300s threshold -> also
    // suppressed. This proves segment 2 never became the new reference.
    const efforts = {
      1: { start_date: '2026-09-04T10:00:00Z', elapsed_time: 100 },
      2: { start_date: '2026-09-04T10:02:30Z', elapsed_time: 20 },
      3: { start_date: '2026-09-04T10:03:20Z', elapsed_time: 20 },
    };
    const result = computeDefaults(segments, details, efforts, true, true, null, null, 300);
    assert.deepEqual(plain(result), { 1: true, 2: false, 3: false });
  });

  await t.test('enough gap between two otherwise-eligible segments -> both stay selected', () => {
    const segments = [{ id: 1 }, { id: 2 }];
    const details = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      2: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
    };
    const efforts = {
      1: { start_date: '2026-09-04T10:00:00Z', elapsed_time: 100 }, // ends at t=100s
      2: { start_date: '2026-09-04T10:10:00Z', elapsed_time: 50 }, // starts at t=600s -> 500s gap
    };
    const result = computeDefaults(segments, details, efforts, true, true, null, null, 300);
    assert.deepEqual(plain(result), { 1: true, 2: true });
  });

  await t.test('missing time data on either effort -> gap not computable, rule does not apply (fail-open), both stay selected', () => {
    const segments = [{ id: 1 }, { id: 2 }];
    const details = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      2: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
    };
    const efforts = {
      1: { elapsed_time: 100 }, // no start_date
      2: { start_date: '2026-09-04T10:02:00Z', elapsed_time: 50 },
    };
    const result = computeDefaults(segments, details, efforts, true, true, null, null, 300);
    assert.deepEqual(plain(result), { 1: true, 2: true });
  });

  await t.test('minGapSec missing or 0 -> the whole pass is disabled, matching today\'s behavior', () => {
    const segments = [{ id: 1 }, { id: 2 }];
    const details = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      2: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
    };
    const efforts = {
      1: { start_date: '2026-09-04T10:00:00Z', elapsed_time: 100 },
      2: { start_date: '2026-09-04T10:00:20Z', elapsed_time: 50 }, // essentially back-to-back
    };
    assert.deepEqual(plain(computeDefaults(segments, details, efforts, true, true, null, null, 0)), { 1: true, 2: true });
    assert.deepEqual(plain(computeDefaults(segments, details, efforts, true, true, null, null, undefined)), { 1: true, 2: true });
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

  await t.test('end-to-end: a segment without a confirmed tailwind is excluded by ensureSegmentjaegerSelection() itself, not just by the underlying pure helpers', () => {
    // Proves the segmentBucket("route")/segmentjaegerFavorableWind() wiring
    // inside ensureSegmentjaegerSelection() is actually connected -- the
    // unit tests above only exercise segmentjaegerIsDefaultEligible()/
    // segmentjaegerComputeDefaults() directly with a hand-built
    // favorableWind, they don't prove ensureSegmentjaegerSelection() itself
    // computes that value correctly from state.routeSegmentWeather.
    const { get } = loadApp();
    const state = get('state');
    const ensure = get('ensureSegmentjaegerSelection');
    state.selectedActivity = activity(777);
    state.routeSegmentsFetched = true;
    // Both heading due north (bearing ~0deg), both record-eligible on their own.
    state.routeSegments = [
      { id: 1, start_latlng: [48.0, 11.0], end_latlng: [48.01, 11.0] },
      { id: 2, start_latlng: [48.0, 11.0], end_latlng: [48.01, 11.0] },
    ];
    state.routeSegmentDetails = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      2: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
    };
    state.routeSegmentEfforts = { 1: {}, 2: {} };
    // Segment 1: windDir=0 (wind FROM the north) blows straight into a
    // due-north-traveling segment -> headwind -> excluded. Segment 2:
    // windDir=180 blows the same direction as travel -> tailwind -> stays.
    state.routeSegmentWeather = {
      1: { windDir: 0 },
      2: { windDir: 180 },
    };

    ensure();

    assert.deepEqual(plain(state.segmentjaegerSelection), { 1: false, 2: true });
  });

  await t.test('end-to-end: state.segmentjaegerMinGapMinutes is actually wired into ensureSegmentjaegerSelection()\'s minimum-gap pass', () => {
    // Proves the (state.segmentjaegerMinGapMinutes || 0) * 60 conversion and
    // pass-through inside ensureSegmentjaegerSelection() is connected -- the
    // unit tests above only exercise segmentjaegerComputeDefaults() directly
    // with a hand-built minGapSec in seconds.
    const { get } = loadApp();
    const state = get('state');
    const ensure = get('ensureSegmentjaegerSelection');
    state.selectedActivity = activity(888);
    state.routeSegmentsFetched = true;
    state.routeSegments = [{ id: 1 }, { id: 2 }];
    state.routeSegmentDetails = {
      1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
      2: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:40' } },
    };
    // Segment 1 ends at t=100s, segment 2 starts at t=150s -- 50s gap, well
    // under the default 5-minute (300s) setting.
    state.routeSegmentEfforts = {
      1: { start_date: '2026-09-04T10:00:00Z', elapsed_time: 100 },
      2: { start_date: '2026-09-04T10:02:30Z', elapsed_time: 20 },
    };
    assert.equal(state.segmentjaegerMinGapMinutes, 5, 'sanity check: default setting is 5 minutes');

    ensure();

    assert.deepEqual(plain(state.segmentjaegerSelection), { 1: true, 2: false });
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

// ---------------------------------------------------------------------
// segmentjaegerComputeStarSyncPlan(segments, selection, starredMap) -- pure
// diff between the Segmentjäger selection and the current Strava star
// state, scoped to exactly the segments passed in (see
// syncSegmentjaegerStars()'s comment in index.html for why that scope is
// always just the current ride's own segment list, never anything wider).
// ---------------------------------------------------------------------
test('segmentjaegerComputeStarSyncPlan', async (t) => {
  await t.test('selected but not starred -> toStar', () => {
    const { get } = loadApp();
    const plan = get('segmentjaegerComputeStarSyncPlan');
    const result = plan([seg(1)], { 1: true }, { 1: false });
    assert.deepEqual(plain(result.toStar), [seg(1)]);
    assert.deepEqual(plain(result.toUnstar), []);
  });

  await t.test('not selected but starred -> toUnstar', () => {
    const { get } = loadApp();
    const plan = get('segmentjaegerComputeStarSyncPlan');
    const result = plan([seg(1)], { 1: false }, { 1: true });
    assert.deepEqual(plain(result.toStar), []);
    assert.deepEqual(plain(result.toUnstar), [seg(1)]);
  });

  await t.test('selected and already starred -> no action', () => {
    const { get } = loadApp();
    const plan = get('segmentjaegerComputeStarSyncPlan');
    const result = plan([seg(1)], { 1: true }, { 1: true });
    assert.deepEqual(plain(result.toStar), []);
    assert.deepEqual(plain(result.toUnstar), []);
  });

  await t.test('not selected and not starred -> no action', () => {
    const { get } = loadApp();
    const plan = get('segmentjaegerComputeStarSyncPlan');
    const result = plan([seg(1)], { 1: false }, { 1: false });
    assert.deepEqual(plain(result.toStar), []);
    assert.deepEqual(plain(result.toUnstar), []);
  });

  await t.test('missing entry in selection or starredMap is treated as falsy, not an error', () => {
    const { get } = loadApp();
    const plan = get('segmentjaegerComputeStarSyncPlan');
    // Not present in `selection` at all (undefined) -- same as `false`.
    const noSelectionEntry = plan([seg(1)], {}, { 1: true });
    assert.deepEqual(plain(noSelectionEntry.toUnstar), [seg(1)]);
    // Not present in `starredMap` at all (undefined) -- same as `false`.
    const noStarredEntry = plan([seg(1)], { 1: true }, {});
    assert.deepEqual(plain(noStarredEntry.toStar), [seg(1)]);
  });

  await t.test('mixes independently across multiple segments', () => {
    const { get } = loadApp();
    const plan = get('segmentjaegerComputeStarSyncPlan');
    const result = plan(
      [seg(1), seg(2), seg(3), seg(4)],
      { 1: true, 2: false, 3: true, 4: false },
      { 1: false, 2: true, 3: true, 4: false }
    );
    assert.deepEqual(plain(result.toStar), [seg(1)]);
    assert.deepEqual(plain(result.toUnstar), [seg(2)]);
  });

  await t.test('empty segment list -> empty plan', () => {
    const { get } = loadApp();
    const plan = get('segmentjaegerComputeStarSyncPlan');
    const result = plan([], { 1: true }, { 1: true });
    assert.deepEqual(plain(result), { toStar: [], toUnstar: [] });
  });
});

// ---------------------------------------------------------------------
// syncSegmentjaegerStars() -- orchestrator. Calls fetch() (via
// applySegmentStar()/starSegment()) for any mismatched segment, and the
// test sandbox's fetch stub always rejects (see test/support/loadApp.js),
// so only the no-mismatch no-op branch is directly exercised here, same
// boundary as migrateStarredSegmentsToLocalFavorites() in
// test/local-favorites.test.js.
// ---------------------------------------------------------------------
test('syncSegmentjaegerStars', async (t) => {
  await t.test('selection already matches star state -> no fetch, stays not-running', async () => {
    let fetchCalls = 0;
    const { get } = loadApp({ onFetchCall: () => { fetchCalls++; } });
    const state = get('state');
    const sync = get('syncSegmentjaegerStars');
    // segmentIsStarred() falls back to seg.starred when nothing else is
    // known (see index.html) -- set it directly so the segment's current
    // star state is deterministic without a network call.
    state.routeSegments = [seg(1, { starred: true })];
    state.segmentjaegerSelection = { 1: true };

    await sync();

    assert.equal(fetchCalls, 0, 'nothing to sync -> no Strava write attempted');
    assert.equal(state.segmentjaegerSyncRunning, false);
  });

  await t.test('already running -> re-entrant call is a no-op', async () => {
    let fetchCalls = 0;
    const { get } = loadApp({ onFetchCall: () => { fetchCalls++; } });
    const state = get('state');
    const sync = get('syncSegmentjaegerStars');
    state.routeSegments = [seg(1, { starred: false })];
    state.segmentjaegerSelection = { 1: true }; // mismatched, would normally trigger a call
    state.segmentjaegerSyncRunning = true;

    await sync();

    assert.equal(fetchCalls, 0, 'must not fire while already running');
  });
});
