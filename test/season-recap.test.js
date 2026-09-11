'use strict';
// Tests for the Jahresrückblick (season recap) pure helpers: isYearDataComplete(),
// getRecapYearOptions(), didCacheEvict(), closestCommuteReference(), and
// computeSeasonRecap() (plus the internal sub-functions it delegates to:
// filterSeasonRides(), computeSeasonBasisNumbers(), computeSeasonPRs(),
// computeSeasonProgress(), computeSeasonGearKm()). See index.html's
// "---------- Jahresrückblick (season recap) ----------" section (near the
// Aktivitäten-cache pipeline) for the functions themselves, and
// renderProfilRueckblickSection() for how the UI turns these numbers into
// actual sentences.
//
// backfillActivitiesForYear() itself (the async orchestration that calls
// didCacheEvict()) is NOT covered here -- same fetch-orchestration
// convention as pushSyncNow()/pullSyncOnLoad() elsewhere in this suite (see
// the comment atop test/sync.test.js): the sandbox's fetch stub always
// unconditionally rejects, so it can only be verified live in the browser.
//
// Each test gets a FRESH app instance via loadApp(), matching the existing
// suite's per-test isolation convention.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

// Objects returned from inside the vm sandbox belong to a different realm
// than plain object literals in this file -- assert/strict's deepEqual can
// fail on those even when structurally identical. Round-tripping through
// JSON strips the realm, same idiom already used by every other test file
// in this suite (see e.g. test/local-favorites.test.js's plain()).
function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

// Tolerance-based float comparison, same convention as e.g.
// test/pure-functions.test.js's `assert.ok(Math.abs(a - b) < eps)` calls --
// used throughout below instead of exact equality for anything derived from
// division (percentages, ratios) so this suite doesn't get brittle over
// floating-point noise in the last few decimal digits.
function close(actual, expected, eps, msg) {
  assert.ok(Math.abs(actual - expected) < (eps == null ? 1e-6 : eps),
    (msg ? msg + ' -- ' : '') + `expected ~${expected}, got ${actual}`);
}

// Tiny local copies of the app's own UTC-field date helpers, same idiom
// test/training-decision-engine.test.js already uses -- lets this file build
// exact expected week/day/month bucket keys without depending on (and so
// without accidentally validating itself circularly against) the very
// mondayOfUTC()/toIsoDate() the app's own computeSeasonPRs() calls.
function addDaysUTC(d, n) { const out = new Date(d); out.setUTCDate(out.getUTCDate() + n); return out; }
function mondayOfUTC(d) { const day = (d.getUTCDay() + 6) % 7; return addDaysUTC(d, -day); }
function toIsoDate(d) { return d.toISOString().slice(0, 10); }

// ---------------------------------------------------------------------
// isYearDataComplete(cachedActivities, year, exhaustedYears)
// ---------------------------------------------------------------------
test('isYearDataComplete', async (t) => {
  await t.test('an activity dated well before the year started -> complete', () => {
    const { get } = loadApp();
    const isYearDataComplete = get('isYearDataComplete');
    const cache = [{ id: 1, start_date_local: '2024-06-01T10:00:00Z' }];
    assert.equal(isYearDataComplete(cache, 2026, new Set()), true);
  });

  await t.test('nothing before the year, no exhaustedYears entry -> incomplete', () => {
    const { get } = loadApp();
    const isYearDataComplete = get('isYearDataComplete');
    const cache = [
      { id: 1, start_date_local: '2026-03-01T10:00:00Z' },
      { id: 2, start_date_local: '2026-07-01T10:00:00Z' },
    ];
    assert.equal(isYearDataComplete(cache, 2026, new Set()), false);
  });

  await t.test('nothing before the year, but the year is in exhaustedYears -> complete (first-ever-year escape hatch)', () => {
    const { get } = loadApp();
    const isYearDataComplete = get('isYearDataComplete');
    const cache = [{ id: 1, start_date_local: '2026-03-01T10:00:00Z' }];
    assert.equal(isYearDataComplete(cache, 2026, new Set([2026])), true);
  });

  await t.test('exhaustedYears may be passed as a plain array, not just a Set', () => {
    const { get } = loadApp();
    const isYearDataComplete = get('isYearDataComplete');
    const cache = [{ id: 1, start_date_local: '2026-03-01T10:00:00Z' }];
    assert.equal(isYearDataComplete(cache, 2026, [2025, 2026]), true);
  });

  await t.test('boundary: an activity dated exactly at the year start (local midnight Jan 1) does NOT count as "before"', () => {
    const { get } = loadApp();
    const isYearDataComplete = get('isYearDataComplete');
    const cache = [{ id: 1, start_date_local: '2026-01-01T00:00:00Z' }];
    assert.equal(isYearDataComplete(cache, 2026, new Set()), false);
  });

  await t.test('boundary: an activity dated one second before the year start DOES count as "before"', () => {
    const { get } = loadApp();
    const isYearDataComplete = get('isYearDataComplete');
    const cache = [{ id: 1, start_date_local: '2025-12-31T23:59:59Z' }];
    assert.equal(isYearDataComplete(cache, 2026, new Set()), true);
  });

  await t.test('accepts the cache MAP shape directly (Object.values under the hood), not just an array', () => {
    const { get } = loadApp();
    const isYearDataComplete = get('isYearDataComplete');
    const cache = { '1': { id: 1, start_date_local: '2024-01-01T00:00:00Z' } };
    assert.equal(isYearDataComplete(cache, 2026, new Set()), true);
  });

  await t.test('empty cache, no exhaustedYears -> incomplete, never throws', () => {
    const { get } = loadApp();
    const isYearDataComplete = get('isYearDataComplete');
    assert.equal(isYearDataComplete([], 2026, new Set()), false);
    assert.equal(isYearDataComplete({}, 2026, undefined), false);
  });

  await t.test('an activity with no start_date_local/start_date at all is skipped, not a crash', () => {
    const { get } = loadApp();
    const isYearDataComplete = get('isYearDataComplete');
    const cache = [{ id: 1 }, { id: 2, start_date_local: '2026-05-01T00:00:00Z' }];
    assert.equal(isYearDataComplete(cache, 2026, new Set()), false);
  });
});

// ---------------------------------------------------------------------
// getRecapYearOptions(cachedActivities, currentYear)
// ---------------------------------------------------------------------
test('getRecapYearOptions', async (t) => {
  await t.test('empty cache -> just [currentYear]', () => {
    const { get } = loadApp();
    const getRecapYearOptions = get('getRecapYearOptions');
    assert.deepEqual(plain(getRecapYearOptions([], 2026)), [2026]);
    assert.deepEqual(plain(getRecapYearOptions({}, 2026)), [2026]);
  });

  await t.test('multi-year cache -> all distinct years, currentYear included, sorted descending', () => {
    const { get } = loadApp();
    const getRecapYearOptions = get('getRecapYearOptions');
    const cache = [
      { id: 1, start_date_local: '2023-05-01T10:00:00Z' },
      { id: 2, start_date_local: '2024-06-01T10:00:00Z' },
      { id: 3, start_date_local: '2024-11-01T10:00:00Z' }, // same year as #2 -- must not duplicate
      { id: 4, start_date_local: '2025-01-01T10:00:00Z' },
    ];
    assert.deepEqual(plain(getRecapYearOptions(cache, 2026)), [2026, 2025, 2024, 2023]);
  });

  await t.test('currentYear already present in the cache is not duplicated', () => {
    const { get } = loadApp();
    const getRecapYearOptions = get('getRecapYearOptions');
    const cache = [{ id: 1, start_date_local: '2026-02-01T10:00:00Z' }];
    assert.deepEqual(plain(getRecapYearOptions(cache, 2026)), [2026]);
  });

  await t.test('accepts the cache MAP shape directly, and ignores entries with no date', () => {
    const { get } = loadApp();
    const getRecapYearOptions = get('getRecapYearOptions');
    const cache = { '1': { id: 1, start_date_local: '2022-02-01T10:00:00Z' }, '2': { id: 2 } };
    assert.deepEqual(plain(getRecapYearOptions(cache, 2026)), [2026, 2022]);
  });
});

// ---------------------------------------------------------------------
// didCacheEvict(mergedCountBeforeSave, persistedCountAfterSave)
// ---------------------------------------------------------------------
// See index.html's comment atop this function and atop
// backfillActivitiesForYear() for the bug this guards against: the 600-entry
// AKTIVITAETEN_LIST_CACHE_MAX cap can silently discard activities a backfill
// run just fetched, and recapExhaustedYears must never be trusted when that
// happened during the run that's about to set it.
test('didCacheEvict', async (t) => {
  await t.test('persisted count equals merged count -> no eviction', () => {
    const { get } = loadApp();
    const didCacheEvict = get('didCacheEvict');
    assert.equal(didCacheEvict(600, 600), false);
    assert.equal(didCacheEvict(200, 200), false);
    assert.equal(didCacheEvict(0, 0), false);
  });

  await t.test('persisted count smaller than merged count -> eviction happened', () => {
    const { get } = loadApp();
    const didCacheEvict = get('didCacheEvict');
    assert.equal(didCacheEvict(700, 600), true);
    assert.equal(didCacheEvict(601, 600), true);
  });

  await t.test('persisted count larger than merged count -- should never happen in practice, but must not crash or report an eviction', () => {
    const { get } = loadApp();
    const didCacheEvict = get('didCacheEvict');
    assert.equal(didCacheEvict(500, 600), false);
  });
});

// ---------------------------------------------------------------------
// closestCommuteReference(km)
// ---------------------------------------------------------------------
test('closestCommuteReference', async (t) => {
  await t.test('exact match returns that entry', () => {
    const { get } = loadApp();
    const closestCommuteReference = get('closestCommuteReference');
    const ref = closestCommuteReference(20);
    assert.equal(ref.km, 20);
    assert.equal(ref.label, 'Nürnberg – Erlangen');
  });

  await t.test('a value strictly between two entries picks the nearer one', () => {
    const { get } = loadApp();
    const closestCommuteReference = get('closestCommuteReference');
    // 33 is 3km from the 30km entry (Köln – Bonn) and 7km from the 40km
    // entry (Frankfurt – Wiesbaden) -- unambiguously nearer to 30.
    const ref = closestCommuteReference(33);
    assert.equal(ref.km, 30);
  });

  await t.test('a value far outside the list\'s range still picks the nearest end, never crashes', () => {
    const { get } = loadApp();
    const closestCommuteReference = get('closestCommuteReference');
    const COMMUTE_DISTANCE_REFERENCES = get('COMMUTE_DISTANCE_REFERENCES');
    const maxKm = Math.max(...COMMUTE_DISTANCE_REFERENCES.map(r => r.km));
    const minKm = Math.min(...COMMUTE_DISTANCE_REFERENCES.map(r => r.km));
    assert.equal(closestCommuteReference(10000).km, maxKm);
    assert.equal(closestCommuteReference(0).km, minKm);
    assert.equal(closestCommuteReference(-500).km, minKm);
  });
});

// ---------------------------------------------------------------------
// computeSeasonRecap(activities, year, confirmedTests, trainerHistory, gearList)
// ---------------------------------------------------------------------
// One realistic multi-activity fixture for the year 2026, reused across most
// sub-tests below. Ride-by-ride reasoning (all distances in meters, times in
// seconds, speeds in m/s):
//
//  A  2026-01-05 (Mon) 30000m / 800Hm / 3600s / 8.3333 m/s (30 km/h) / 150W (device_watts) / gear b1
//  B  2026-01-05 (Mon, SAME DAY as A) 15000m / 800Hm / 1800s / 8.3333 m/s / no power meter / gear b1
//     -> day 2026-01-05 elevation = 800+800 = 1600 Hm (proves per-day SUMMING, not "last one wins")
//     -> week-of-2026-01-05 (Mon) = 45 km (A+B)
//  C  2026-03-10 (Tue, week starting Mon 2026-03-09) 100000m / 1500Hm / 14400s / 6.9444 m/s (25 km/h) / 180W / gear b2
//     -> longest single ride (100 km); its own week totals 100 km (alone)
//  D  2026-03-17 (Tue, week starting Mon 2026-03-16) 20000m (exactly the 20km speed-PR threshold) / 250Hm / 3600s / 5.5556 m/s (20 km/h) / 160W / NO gear_id
//  E  2026-03-18 (Wed, same week as D) 5000m (UNDER the 20km threshold) / 50Hm / 600s / 15 m/s (54 km/h, deliberately faster than
//     every qualifying ride) / no power meter / gear_id references a gear that ISN'T in gearList
//     -> March as a MONTH totals C+D+E = 100+20+5 = 125 km, which is MORE than March's own busiest
//        WEEK (C's week alone, 100 km) -- proves week-bucketing and month-bucketing are genuinely
//        independent groupings, not aliases of each other
//     -> E's 54 km/h must NOT win "schnellster Ø-Speed" (it's under 20 km) -- if it ever did, that
//        would prove the >=20km filter silently broke
//  F  2026-06-01 (Mon) 40000m / 400Hm / 7200s / 5.5556 m/s (20 km/h) / 200W / gear b2
//
//  G  2026-06-02, sport_type "Run" -- must be fully excluded (RIDE_SPORT_TYPES filtering)
//  H  2025-12-31, a Ride -- must be fully excluded (wrong year)
//
// Qualifying-for-calories rides (device_watts===true && average_watts!=null): A, C, D, F.
// B and E deliberately have no power meter, to prove they contribute 0 kcal.
function buildFixtureActivities() {
  return [
    { id: 1, name: 'A', sport_type: 'Ride', start_date_local: '2026-01-05T08:00:00Z',
      distance: 30000, total_elevation_gain: 800, moving_time: 3600, average_speed: 30000 / 3600,
      device_watts: true, average_watts: 150, gear_id: 'b1' },
    { id: 2, name: 'B', sport_type: 'Ride', start_date_local: '2026-01-05T18:00:00Z',
      distance: 15000, total_elevation_gain: 800, moving_time: 1800, average_speed: 15000 / 1800,
      device_watts: false, average_watts: null, gear_id: 'b1' },
    { id: 3, name: 'C', sport_type: 'Ride', start_date_local: '2026-03-10T09:00:00Z',
      distance: 100000, total_elevation_gain: 1500, moving_time: 14400, average_speed: 100000 / 14400,
      device_watts: true, average_watts: 180, gear_id: 'b2' },
    { id: 4, name: 'D', sport_type: 'GravelRide', start_date_local: '2026-03-17T09:00:00Z',
      distance: 20000, total_elevation_gain: 250, moving_time: 3600, average_speed: 20000 / 3600,
      device_watts: true, average_watts: 160, gear_id: null },
    { id: 5, name: 'E', sport_type: 'Ride', start_date_local: '2026-03-18T09:00:00Z',
      distance: 5000, total_elevation_gain: 50, moving_time: 600, average_speed: 15,
      device_watts: false, average_watts: null, gear_id: 'unknown_gear_id' },
    { id: 6, name: 'F', sport_type: 'VirtualRide', start_date_local: '2026-06-01T07:00:00Z',
      distance: 40000, total_elevation_gain: 400, moving_time: 7200, average_speed: 40000 / 7200,
      device_watts: true, average_watts: 200, gear_id: 'b2' },
    { id: 7, name: 'G (Run, must be excluded)', sport_type: 'Run', start_date_local: '2026-06-02T07:00:00Z',
      distance: 10000, total_elevation_gain: 50, moving_time: 3000 },
    { id: 8, name: 'H (last year, must be excluded)', sport_type: 'Ride', start_date_local: '2025-12-31T23:00:00Z',
      distance: 99999, total_elevation_gain: 9999, moving_time: 99999, average_speed: 10,
      device_watts: true, average_watts: 999, gear_id: 'b1' },
  ];
}

const FIXTURE_GEAR_LIST = [
  { id: 'b1', name: 'Canyon Endurace', kind: 'Bike' },
  { id: 'b2', name: 'Trek Domane', kind: 'Bike' },
];

function buildFixtureConfirmedTests() {
  return {
    '101:1200': { rideId: 101, durationSec: 1200, rideDateIso: '2026-02-01', rideName: 'Test Feb',
      targetWatts: 250, achievedWatts: 245, passed: true, confirmedAtIso: '2026-02-02T10:00:00Z' },
    '102:1200': { rideId: 102, durationSec: 1200, rideDateIso: '2026-08-01', rideName: 'Test Aug',
      targetWatts: 260, achievedWatts: 265, passed: true, confirmedAtIso: '2026-08-02T10:00:00Z' },
    // Wrong duration (10-min test, not the 20-min FTP proxy) -- must be ignored.
    '103:600': { rideId: 103, durationSec: 600, rideDateIso: '2026-05-01', rideName: 'Test 10min',
      targetWatts: 280, achievedWatts: 290, passed: true, confirmedAtIso: '2026-05-02T10:00:00Z' },
    // Right duration, wrong year -- must be ignored.
    '104:1200': { rideId: 104, durationSec: 1200, rideDateIso: '2025-01-01', rideName: 'Test last year',
      targetWatts: 240, achievedWatts: 200, passed: false, confirmedAtIso: '2025-01-02T10:00:00Z' },
  };
}

function buildFixtureTrainerHistory() {
  return [
    { date: '2026-01-10T08:00:00Z', goal: 'ftp', activityId: '1', compliance: 1.0 },
    { date: '2026-04-15T08:00:00Z', goal: 'vo2max', activityId: '2', compliance: 0.95 },
    { date: '2025-12-01T08:00:00Z', goal: 'ftp', activityId: '3', compliance: 1.0 }, // wrong year
  ];
}

test('filterSeasonRides', async (t) => {
  await t.test('filters to RIDE_SPORT_TYPES AND the given year, using start_date_local', () => {
    const { get } = loadApp();
    const filterSeasonRides = get('filterSeasonRides');
    const rides = filterSeasonRides(buildFixtureActivities(), 2026);
    assert.deepEqual(rides.map(r => r.name).sort(), ['A', 'B', 'C', 'D', 'E', 'F']);
  });

  await t.test('a different year selects the (excluded-above) 2025 ride instead', () => {
    const { get } = loadApp();
    const filterSeasonRides = get('filterSeasonRides');
    const rides = filterSeasonRides(buildFixtureActivities(), 2025);
    assert.deepEqual(rides.map(r => r.name), ['H (last year, must be excluded)']);
  });

  await t.test('never throws on null/malformed entries', () => {
    const { get } = loadApp();
    const filterSeasonRides = get('filterSeasonRides');
    assert.deepEqual(filterSeasonRides([null, {}, { sport_type: 'Ride' }], 2026), []);
  });
});

test('computeSeasonRecap', async (t) => {
  await t.test('Basis-Zahlen: totals and every comparison ratio match hand-computed expectations', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const recap = computeSeasonRecap(buildFixtureActivities(), 2026, {}, [], []);
    const B = recap.basis;

    assert.equal(recap.year, 2026);
    assert.equal(recap.daysInYear, 365); // 2026 is not a leap year

    close(B.totalKm, 210);
    close(B.totalElevationM, 3800);
    assert.equal(B.rideCount, 6);
    close(B.totalMovingTimeSec, 31200);
    close(B.totalHours, 31200 / 3600);
    close(B.avgRideKm, 35);

    close(B.earthCircumferencePct, (210 / 40075) * 100);
    close(B.everestRatio, 3800 / 8849);
    assert.ok(B.everestRatio < 1, 'this fixture stays under 100% of Everest -- see the dedicated >100% test below');
    close(B.rideCountPctOfDays, (6 / 365) * 100);
    close(B.timePctOfYear, ((31200 / 3600) / (365 * 24)) * 100);
    close(B.movieCount, (31200 / 3600) / 2);

    // Calories: ONLY A, C, D, F have a power meter (device_watts===true &&
    // average_watts != null) -- B and E must contribute exactly 0.
    const expectedKcal = (150 * 3600 / 1000) + (180 * 14400 / 1000) + (160 * 3600 / 1000) + (200 * 7200 / 1000);
    close(B.totalKcal, expectedKcal);
    assert.equal(B.kcalRideCount, 4);
    close(B.kcalPctOfBasalYear, (expectedKcal / (2000 * 365)) * 100);
    close(B.pizzaCount, expectedKcal / 800);
  });

  await t.test('Ø Fahrtlänge picks the nearest commute reference (avg 35 km -> Köln – Bonn, 30 km)', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const recap = computeSeasonRecap(buildFixtureActivities(), 2026, {}, [], []);
    assert.deepEqual(plain(recap.basis.avgRideKmCommuteRef), { label: 'Köln – Bonn', km: 30 });
  });

  await t.test('Bestleistungen: longest ride, per-day elevation summing, >=20km speed filter, independent week vs month PRs', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const recap = computeSeasonRecap(buildFixtureActivities(), 2026, {}, [], []);
    const P = recap.prs;

    close(P.longestRideKm, 100); // ride C

    // Ride A (800Hm) + ride B (800Hm), same local calendar day -> 1600Hm,
    // which only comes out right if the two rides were actually SUMMED for
    // that day rather than one of them overwriting the other.
    assert.equal(P.maxElevationDay.dateIso, '2026-01-05');
    close(P.maxElevationDay.elevationM, 1600);

    // Ride E is faster (15 m/s = 54 km/h) than every ride >=20km, but is
    // itself only 5km -- it must be excluded, or this would wrongly read ~54.
    close(P.fastestAvgSpeedKmh, (30000 / 3600) * 3.6); // ride A, 30 km/h
    assert.ok(P.fastestAvgSpeedKmh < 54, 'the sub-20km ride must not win the speed PR');

    // Busiest single WEEK: ride C's own week (2026-03-09..) = 100km alone,
    // more than the Jan week (A+B=45km) or the June week (F=40km) --
    // crucially NOT the same as the busiest MONTH below (125km), proving
    // week- and month-bucketing are independently computed, not aliases.
    assert.equal(P.mostActiveWeek.weekStartIso, '2026-03-09');
    close(P.mostActiveWeek.km, 100);

    // Busiest calendar MONTH: March = C+D+E = 100+20+5 = 125km.
    assert.equal(P.mostActiveMonth.month, '2026-03');
    close(P.mostActiveMonth.km, 125);
  });

  await t.test('no rides in the given year -> PRs are all null/absent, not NaN or a crash', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const recap = computeSeasonRecap(buildFixtureActivities(), 2019, {}, [], []);
    assert.deepEqual(plain(recap.prs), {
      longestRideKm: null, maxElevationDay: null, fastestAvgSpeedKmh: null,
      mostActiveWeek: null, mostActiveMonth: null,
    });
    assert.equal(recap.basis.rideCount, 0);
    assert.equal(recap.basis.totalKm, 0);
    assert.equal(recap.basis.avgRideKm, 0); // explicit 0-ride guard, not 0/0 = NaN
    assert.equal(recap.basis.avgRideKmCommuteRef, null);
    assert.equal(recap.basis.kcalRideCount, 0);
    assert.deepEqual(plain(recap.gear), []);
  });

  await t.test('Höhenmeter can exceed 100% of Everest -- everestRatio is returned as a raw ratio > 1, not capped or pre-formatted', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const MOUNT_EVEREST_M = get('MOUNT_EVEREST_M');
    const bigClimbActivities = [
      { id: 1, sport_type: 'Ride', start_date_local: '2026-05-01T08:00:00Z',
        distance: 50000, total_elevation_gain: MOUNT_EVEREST_M * 2.3, moving_time: 7200 },
    ];
    const recap = computeSeasonRecap(bigClimbActivities, 2026, {}, [], []);
    close(recap.basis.everestRatio, 2.3, 1e-9);
    assert.ok(recap.basis.everestRatio > 1);
  });

  await t.test('leap year (2024) uses 366 days, non-leap (2025) uses 365', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    assert.equal(computeSeasonRecap([], 2024, {}, [], []).daysInYear, 366);
    assert.equal(computeSeasonRecap([], 2025, {}, [], []).daysInYear, 365);
    assert.equal(computeSeasonRecap([], 2000, {}, [], []).daysInYear, 366); // divisible by 400 -> leap
    assert.equal(computeSeasonRecap([], 1900, {}, [], []).daysInYear, 365); // divisible by 100 but not 400 -> not leap
  });

  await t.test('Trainingsfortschritt: fewer than 2 confirmed 20-min tests this year -> ftpProgress absent', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const oneTest = {
      '101:1200': { rideId: 101, durationSec: 1200, rideDateIso: '2026-02-01', rideName: 'Test Feb',
        targetWatts: 250, achievedWatts: 245, passed: true, confirmedAtIso: '2026-02-02T10:00:00Z' },
    };
    const recap = computeSeasonRecap([], 2026, oneTest, [], []);
    assert.ok(recap.progress.ftpProgress == null, 'a single test must not be shown as "progress"');

    const noTests = computeSeasonRecap([], 2026, {}, [], []);
    assert.ok(noTests.progress.ftpProgress == null);
  });

  await t.test('Trainingsfortschritt: 2+ confirmed 20-min tests -> first vs last by date, wrong duration/year ignored', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const recap = computeSeasonRecap([], 2026, buildFixtureConfirmedTests(), [], []);
    const fp = recap.progress.ftpProgress;
    assert.ok(fp, 'expected ftpProgress to be present with 2 qualifying tests');
    assert.equal(fp.firstWatts, 245); // Feb (earlier rideDateIso)
    assert.equal(fp.lastWatts, 265);  // Aug (later rideDateIso)
    assert.equal(fp.deltaWatts, 20);
    close(fp.deltaPct, (20 / 245) * 100);
    assert.equal(fp.testCount, 2);
  });

  await t.test('Trainingsfortschritt: year attribution and ordering follow rideDateIso, NOT confirmedAtIso', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    // Two tests whose rideDateIso and confirmedAtIso deliberately disagree:
    //  - "ride-in-2026" was actually RIDDEN in 2026 but not confirmed (batch-
    //    confirmed later) until 2027 -- must still count toward 2026.
    //  - "ride-in-2025" was ridden in 2025 but confirmed in 2026 -- must NOT
    //    count toward 2026, even though its confirmedAtIso falls inside it.
    //  - "ride-in-2026-later" is a second genuine 2026 ride (rideDateIso),
    //    confirmed even earlier (confirmedAtIso) than "ride-in-2026" above --
    //    if sorting used confirmedAtIso this pair's first/last would flip.
    const tests = {
      'a:1200': {
        rideId: 'a', durationSec: 1200, rideDateIso: '2026-02-01', rideName: 'Ride in 2026 (late confirm)',
        targetWatts: 250, achievedWatts: 240, passed: false, confirmedAtIso: '2027-01-15T10:00:00Z',
      },
      'b:1200': {
        rideId: 'b', durationSec: 1200, rideDateIso: '2025-12-20', rideName: 'Ride in 2025 (confirmed in 2026)',
        targetWatts: 230, achievedWatts: 999, passed: true, confirmedAtIso: '2026-01-05T10:00:00Z',
      },
      'c:1200': {
        rideId: 'c', durationSec: 1200, rideDateIso: '2026-09-01', rideName: 'Ride in 2026 (early confirm)',
        targetWatts: 260, achievedWatts: 270, passed: true, confirmedAtIso: '2026-02-01T10:00:00Z',
      },
    };
    const recap = computeSeasonRecap([], 2026, tests, [], []);
    const fp = recap.progress.ftpProgress;
    assert.ok(fp, 'expected exactly the two genuinely-2026-ridden tests (a, c) to qualify');
    assert.equal(fp.testCount, 2, 'the 2025-ridden test (b) must be excluded despite its 2026 confirmedAtIso');
    // By rideDateIso, "a" (2026-02-01) is first and "c" (2026-09-01) is last
    // -- if the code still sorted/filtered by confirmedAtIso instead, "c"
    // (confirmed 2026-02-01) would come first and "b" would wrongly qualify.
    assert.equal(fp.firstWatts, 240);
    assert.equal(fp.lastWatts, 270);
    assert.equal(fp.firstDateIso, '2026-02-01');
    assert.equal(fp.lastDateIso, '2026-09-01');
  });

  await t.test('Trainingsfortschritt: Anzahl Workouts counts only trainerHistory entries within the given year', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const recap = computeSeasonRecap([], 2026, {}, buildFixtureTrainerHistory(), []);
    assert.equal(recap.progress.workoutCount, 2); // the 2025 entry is excluded
  });

  await t.test('Ausrüstung: sums qualifying rides per gear, groups missing/unmatched gear_id under "Unbekannt"', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const recap = computeSeasonRecap(buildFixtureActivities(), 2026, {}, [], FIXTURE_GEAR_LIST);
    const byLabel = {};
    recap.gear.forEach(g => { byLabel[g.label] = g.km; });

    close(byLabel['Trek Domane'], 140); // C (100) + F (40)
    close(byLabel['Canyon Endurace'], 45); // A (30) + B (15)
    close(byLabel['Unbekannt'], 25); // D (no gear_id, 20) + E (unmatched gear_id, 5)

    // Sorted descending by km.
    assert.deepEqual(plain(recap.gear.map(g => g.label)), ['Trek Domane', 'Canyon Endurace', 'Unbekannt']);
  });

  await t.test('Ausrüstung: empty gearList -> every ride groups under "Unbekannt", never crashes', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const recap = computeSeasonRecap(buildFixtureActivities(), 2026, {}, [], []);
    assert.equal(recap.gear.length, 1);
    assert.equal(recap.gear[0].label, 'Unbekannt');
    close(recap.gear[0].km, 210); // every ride's distance
  });

  await t.test('full fixture end-to-end: every section computed together, nothing NaN/undefined that should be a number', () => {
    const { get } = loadApp();
    const computeSeasonRecap = get('computeSeasonRecap');
    const recap = computeSeasonRecap(
      buildFixtureActivities(), 2026, buildFixtureConfirmedTests(), buildFixtureTrainerHistory(), FIXTURE_GEAR_LIST
    );
    // Walk every numeric leaf and assert it's a finite number, never NaN.
    const numericLeaves = [
      recap.basis.totalKm, recap.basis.totalElevationM, recap.basis.avgRideKm, recap.basis.totalKcal,
      recap.basis.earthCircumferencePct, recap.basis.everestRatio, recap.basis.rideCountPctOfDays,
      recap.basis.timePctOfYear, recap.basis.movieCount, recap.basis.kcalPctOfBasalYear, recap.basis.pizzaCount,
      recap.prs.longestRideKm, recap.prs.fastestAvgSpeedKmh,
      recap.progress.ftpProgress.deltaWatts, recap.progress.ftpProgress.deltaPct, recap.progress.workoutCount,
    ];
    numericLeaves.forEach((v, i) => assert.ok(Number.isFinite(v), `leaf ${i} is not a finite number: ${v}`));
  });
});
