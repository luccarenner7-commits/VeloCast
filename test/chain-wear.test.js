'use strict';
// Tests for the Kettenverschleiß (chain wear) tool's pure functions:
// sumRiddenDistanceM, getChainWearDistanceM, computeChainWearReminder, and
// applyChainWearReset (see index.html's "---------- Kettenverschleiß
// (unabhängig von Ausrüstung) ----------" section). Deliberately independent
// from the existing Ausrüstung gear-wear feature (GEAR_COMPONENTS/
// gearWearStatus) -- this tool reuses gearWearStatus() directly rather than
// duplicating its math, so that function is exercised here too via
// computeChainWearReminder(), but not re-tested in isolation (already
// effectively covered).
//
// The reset baseline is date-based (resetAtMs), not distance-based
// (resetAtKm) -- a prior version pinned the baseline to a lifetime-distance
// snapshot, which broke as soon as loadAktivitaetenListCache() backfilled
// OLDER activities after a reset (the cache is not append-only from "now"
// forward -- paging further back on the Aktivitäten tab adds older rides to
// the same cache). Filtering by timestamp instead means a ride that
// happened before the reset can never retroactively count toward wear,
// regardless of when it gets cached.
//
// Each test gets a FRESH app instance via loadApp() (see
// test/support/loadApp.js), matching the existing suite's per-test
// isolation convention.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// ---------------------------------------------------------------------
// sumRiddenDistanceM(activities, sinceMs) -- RIDE_SPORT_TYPES-filtered
// distance sum, optionally restricted to activities at/after sinceMs.
// ---------------------------------------------------------------------
test('sumRiddenDistanceM', async (t) => {
  await t.test('sums distance across multiple ride-type activities', () => {
    const { get } = loadApp();
    const sumRiddenDistanceM = get('sumRiddenDistanceM');
    const activities = [
      { sport_type: 'Ride', distance: 30000 },
      { sport_type: 'GravelRide', distance: 15000 },
      { type: 'VirtualRide', distance: 5000 }, // legacy `.type` fallback, same as RIDE_SPORT_TYPES' other call sites
    ];
    assert.equal(sumRiddenDistanceM(activities), 50000);
  });

  await t.test('excludes non-ride sport types (e.g. a run)', () => {
    const { get } = loadApp();
    const sumRiddenDistanceM = get('sumRiddenDistanceM');
    const activities = [
      { sport_type: 'Ride', distance: 30000 },
      { sport_type: 'Run', distance: 10000 },
    ];
    assert.equal(sumRiddenDistanceM(activities), 30000);
  });

  await t.test('empty/missing activities -> 0, not an error', () => {
    const { get } = loadApp();
    const sumRiddenDistanceM = get('sumRiddenDistanceM');
    assert.equal(sumRiddenDistanceM([]), 0);
    assert.equal(sumRiddenDistanceM(null), 0);
    assert.equal(sumRiddenDistanceM(undefined), 0);
  });

  await t.test('activities with no distance field count as 0, not NaN', () => {
    const { get } = loadApp();
    const sumRiddenDistanceM = get('sumRiddenDistanceM');
    const activities = [{ sport_type: 'Ride' }, { sport_type: 'Ride', distance: 1000 }];
    assert.equal(sumRiddenDistanceM(activities), 1000);
  });

  await t.test('sinceMs excludes activities that started before it', () => {
    const { get } = loadApp();
    const sumRiddenDistanceM = get('sumRiddenDistanceM');
    const activities = [
      { sport_type: 'Ride', distance: 10000, start_date: isoDaysAgo(10) },
      { sport_type: 'Ride', distance: 20000, start_date: isoDaysAgo(1) },
    ];
    const sinceMs = Date.now() - 5 * 86400000; // 5 days ago -- only the 2nd ride qualifies
    assert.equal(sumRiddenDistanceM(activities, sinceMs), 20000);
  });

  await t.test('no sinceMs (0/undefined) includes everything, same as before', () => {
    const { get } = loadApp();
    const sumRiddenDistanceM = get('sumRiddenDistanceM');
    const activities = [
      { sport_type: 'Ride', distance: 10000, start_date: isoDaysAgo(10) },
      { sport_type: 'Ride', distance: 20000, start_date: isoDaysAgo(1) },
    ];
    assert.equal(sumRiddenDistanceM(activities, 0), 30000);
    assert.equal(sumRiddenDistanceM(activities), 30000);
  });

  await t.test('start_date_local is preferred over start_date, matching every other call site', () => {
    const { get } = loadApp();
    const sumRiddenDistanceM = get('sumRiddenDistanceM');
    const activities = [
      { sport_type: 'Ride', distance: 10000, start_date_local: isoDaysAgo(1), start_date: isoDaysAgo(10) },
    ];
    const sinceMs = Date.now() - 5 * 86400000;
    assert.equal(sumRiddenDistanceM(activities, sinceMs), 10000, 'should use start_date_local (1 day ago), not start_date (10 days ago)');
  });
});

// ---------------------------------------------------------------------
// computeChainWearReminder(chainWear, distanceSinceResetM) -- true only once
// gearWearStatus()'s "danger" level (pct>=100) is reached, matching the
// literal "threshold reached" ask (not the softer 80% "warn" pre-level).
// The caller is responsible for pre-filtering distanceSinceResetM to
// chainWear.resetAtMs (via getChainWearDistanceM(chainWear.resetAtMs)) --
// this function itself only reads chainWear.thresholdKm.
// ---------------------------------------------------------------------
test('computeChainWearReminder', async (t) => {
  await t.test('below threshold -> false', () => {
    const { get } = loadApp();
    const computeChainWearReminder = get('computeChainWearReminder');
    const chainWear = { thresholdKm: 3000, resetAtMs: 0 };
    assert.equal(computeChainWearReminder(chainWear, 2000 * 1000), false);
  });

  await t.test('at "warn" level (>=80%) but below 100% -> still false (danger only)', () => {
    const { get } = loadApp();
    const computeChainWearReminder = get('computeChainWearReminder');
    const chainWear = { thresholdKm: 3000, resetAtMs: 0 };
    assert.equal(computeChainWearReminder(chainWear, 2500 * 1000), false);
  });

  await t.test('exactly at threshold (100%) -> true', () => {
    const { get } = loadApp();
    const computeChainWearReminder = get('computeChainWearReminder');
    const chainWear = { thresholdKm: 3000, resetAtMs: 0 };
    assert.equal(computeChainWearReminder(chainWear, 3000 * 1000), true);
  });

  await t.test('past threshold -> true', () => {
    const { get } = loadApp();
    const computeChainWearReminder = get('computeChainWearReminder');
    const chainWear = { thresholdKm: 3000, resetAtMs: 0 };
    assert.equal(computeChainWearReminder(chainWear, 4000 * 1000), true);
  });

  await t.test('does not itself read chainWear.resetAtMs -- caller must pre-filter the distance', () => {
    const { get } = loadApp();
    const computeChainWearReminder = get('computeChainWearReminder');
    // Same distanceSinceResetM, different resetAtMs -- answer must be identical,
    // proving resetAtMs isn't consulted inside this function.
    const a = { thresholdKm: 3000, resetAtMs: 0 };
    const b = { thresholdKm: 3000, resetAtMs: Date.now() };
    assert.equal(computeChainWearReminder(a, 3500 * 1000), computeChainWearReminder(b, 3500 * 1000));
  });
});

// ---------------------------------------------------------------------
// getChainWearDistanceM(sinceMs) -- bug fix #1: must read a LIFETIME/
// cumulative distance source (the persistent velocast_activity_list_cache,
// written by loadAktivitaetenList()/saveAktivitaetenListCache() as the
// Aktivitäten tab pages through activities), NOT state.activities
// (fetchActivities()'s hardcoded `per_page=8` rolling window of only the 8
// most recent rides -- see index.html ~line 2153). A fixture with MORE than
// 8 rides is the direct regression test for that bug.
//
// Bug fix #2 (round 2): must also correctly restrict to sinceMs, since the
// cache can be backfilled with OLDER activities after a reset (see
// applyChainWearReset tests below for the full regression scenario).
// ---------------------------------------------------------------------
test('getChainWearDistanceM', async (t) => {
  await t.test('cold start, cache never populated -- degrades to 0, does not throw', () => {
    const { get } = loadApp();
    const getChainWearDistanceM = get('getChainWearDistanceM');
    assert.doesNotThrow(() => getChainWearDistanceM());
    assert.equal(getChainWearDistanceM(), 0);
  });

  await t.test('sums MORE than 8 rides from the cache -- proves it is not an 8-item rolling window', () => {
    const { get } = loadApp();
    const saveAktivitaetenListCache = get('saveAktivitaetenListCache');
    const getChainWearDistanceM = get('getChainWearDistanceM');

    // 12 rides, each 60km -- a realistic "several months of riding" fixture.
    // The old state.activities-based bug could only ever see the 8 most
    // recent of these (8 * 60000 = 480000m); the fix must see all 12.
    const RIDE_COUNT = 12;
    const RIDE_DISTANCE_M = 60000;
    const cache = {};
    for (let i = 0; i < RIDE_COUNT; i++) {
      cache[String(i)] = {
        id: i,
        sport_type: 'Ride',
        distance: RIDE_DISTANCE_M,
        start_date: isoDaysAgo(RIDE_COUNT - i),
        start_date_local: isoDaysAgo(RIDE_COUNT - i),
      };
    }
    saveAktivitaetenListCache(cache);

    const total = getChainWearDistanceM();
    const oldRollingWindowTotal = 8 * RIDE_DISTANCE_M; // what the pre-fix bug would have summed
    assert.equal(total, RIDE_COUNT * RIDE_DISTANCE_M);
    assert.ok(total > oldRollingWindowTotal, 'lifetime total must exceed what an 8-ride rolling window could ever sum');
  });

  await t.test('still filters by RIDE_SPORT_TYPES (e.g. excludes a cached run)', () => {
    const { get } = loadApp();
    const saveAktivitaetenListCache = get('saveAktivitaetenListCache');
    const getChainWearDistanceM = get('getChainWearDistanceM');
    saveAktivitaetenListCache({
      '1': { id: 1, sport_type: 'Ride', distance: 40000, start_date: isoDaysAgo(2) },
      '2': { id: 2, sport_type: 'Run', distance: 10000, start_date: isoDaysAgo(1) },
    });
    assert.equal(getChainWearDistanceM(), 40000);
  });

  await t.test('sinceMs filters out cached rides older than the reset point', () => {
    const { get } = loadApp();
    const saveAktivitaetenListCache = get('saveAktivitaetenListCache');
    const getChainWearDistanceM = get('getChainWearDistanceM');
    saveAktivitaetenListCache({
      '1': { id: 1, sport_type: 'Ride', distance: 50000, start_date: isoDaysAgo(10) },
      '2': { id: 2, sport_type: 'Ride', distance: 20000, start_date: isoDaysAgo(1) },
    });
    const sinceMs = Date.now() - 5 * 86400000;
    assert.equal(getChainWearDistanceM(sinceMs), 20000);
  });
});

// ---------------------------------------------------------------------
// applyChainWearReset(chainWear) -- extracted out of buildChainWearCard()'s
// "Zurückgesetzt" button onclick so the reset baseline logic is
// unit-testable. Baselines on a TIMESTAMP (resetAtMs = now), not a distance
// snapshot -- covers exactly the property that was broken twice:
//   1. (round 1) right after a reset, wear-since-reset must be ~0, and it
//      must grow again as new rides accumulate.
//   2. (round 2) a reset must stay valid even if OLDER activities get
//      backfilled into loadAktivitaetenListCache() afterwards (e.g. the
//      rider pages further back on the Aktivitäten tab) -- those older
//      rides happened before the reset and must never retroactively count.
// ---------------------------------------------------------------------
test('applyChainWearReset', async (t) => {
  await t.test('pins resetAtMs to "now", not 0', () => {
    const { get } = loadApp();
    const applyChainWearReset = get('applyChainWearReset');
    const chainWear = { thresholdKm: 3000, resetAtMs: 0 };
    const before = Date.now();
    const updated = applyChainWearReset(chainWear);
    const after = Date.now();
    assert.ok(updated.resetAtMs >= before && updated.resetAtMs <= after, 'resetAtMs should be set to the current time');
  });

  await t.test('preserves thresholdKm and does not mutate the input object', () => {
    const { get } = loadApp();
    const applyChainWearReset = get('applyChainWearReset');
    const chainWear = { thresholdKm: 2500, resetAtMs: 0 };
    const updated = applyChainWearReset(chainWear);
    assert.equal(updated.thresholdKm, 2500);
    assert.equal(chainWear.resetAtMs, 0, 'original object must be left untouched');
  });

  await t.test('right after reset, wear-since-reset is ~0, and it grows again as new rides accumulate', () => {
    const { get } = loadApp();
    const applyChainWearReset = get('applyChainWearReset');
    const computeChainWearReminder = get('computeChainWearReminder');
    const getChainWearDistanceM = get('getChainWearDistanceM');
    const saveAktivitaetenListCache = get('saveAktivitaetenListCache');

    // Chain was at "danger" (100%) right before resetting.
    saveAktivitaetenListCache({
      '1': { id: 1, sport_type: 'Ride', distance: 3000 * 1000, start_date: isoDaysAgo(2) },
    });
    let chainWear = { thresholdKm: 3000, resetAtMs: 0 };
    assert.equal(computeChainWearReminder(chainWear, getChainWearDistanceM(chainWear.resetAtMs)), true);

    chainWear = applyChainWearReset(chainWear);
    assert.equal(getChainWearDistanceM(chainWear.resetAtMs), 0, 'wear-since-reset must be ~0 immediately after resetting (no new rides yet)');
    assert.equal(computeChainWearReminder(chainWear, getChainWearDistanceM(chainWear.resetAtMs)), false);

    // A new ride happens after the reset -- wear must accumulate again.
    saveAktivitaetenListCache({
      '1': { id: 1, sport_type: 'Ride', distance: 3000 * 1000, start_date: isoDaysAgo(2) },
      '2': { id: 2, sport_type: 'Ride', distance: 1500 * 1000, start_date: new Date().toISOString() },
    });
    assert.equal(getChainWearDistanceM(chainWear.resetAtMs), 1500 * 1000);
    assert.equal(computeChainWearReminder(chainWear, getChainWearDistanceM(chainWear.resetAtMs)), false);
  });

  await t.test('regression: backfilling OLDER activities after a reset must not retroactively inflate wear', () => {
    const { get } = loadApp();
    const applyChainWearReset = get('applyChainWearReset');
    const computeChainWearReminder = get('computeChainWearReminder');
    const getChainWearDistanceM = get('getChainWearDistanceM');
    const saveAktivitaetenListCache = get('saveAktivitaetenListCache');

    // Rider has only ever opened Aktivitäten once -- a handful of recent
    // rides are cached (~1500km), then they replace the chain and reset.
    saveAktivitaetenListCache({
      '1': { id: 1, sport_type: 'Ride', distance: 1500 * 1000, start_date: isoDaysAgo(1) },
    });
    let chainWear = applyChainWearReset({ thresholdKm: 3000, resetAtMs: 0 });
    assert.equal(getChainWearDistanceM(chainWear.resetAtMs), 0);

    // Later, the rider pages further back on the Aktivitäten tab ("Weitere
    // laden"), backfilling 90 OLDER rides (~4500km) that all happened
    // BEFORE the reset into the very same cache.
    const backfilled = { '1': { id: 1, sport_type: 'Ride', distance: 1500 * 1000, start_date: isoDaysAgo(1) } };
    for (let i = 0; i < 90; i++) {
      backfilled[`old-${i}`] = { id: `old-${i}`, sport_type: 'Ride', distance: 50000, start_date: isoDaysAgo(100 + i) };
    }
    saveAktivitaetenListCache(backfilled);

    // The reset must still hold -- none of the backfilled (pre-reset) rides
    // may count toward wear-since-reset.
    assert.equal(getChainWearDistanceM(chainWear.resetAtMs), 0, 'backfilled older rides must not retroactively inflate wear-since-reset');
    assert.equal(computeChainWearReminder(chainWear, getChainWearDistanceM(chainWear.resetAtMs)), false, 'a freshly-reset chain must not falsely show as worn out after unrelated backfill');
  });
});
