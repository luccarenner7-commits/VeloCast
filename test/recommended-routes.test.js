'use strict';
// "Empfohlen" tab (index.html, "---------- 'Empfohlen' tab: wind-based route
// recommendation ----------" section): up to 3 wind-favorable route/activity
// tiles, one per distance bucket (<50km, 50-75km, >=75km), ranked by wind
// favorability for state.startTime -- NOT literal "now". Two pure functions
// behind it, both covered here:
//   - scoreRouteWindForStartTime(legs, hourlyForecast, startDate, avgSpeedKmh):
//     given a candidate's coarse ~1km leg breakdown (bearing + own length,
//     in ride order) and that SAME candidate's own batched Open-Meteo hourly
//     forecast, walks cumulative distance leg by leg, picks the nearest
//     hourly slot to each leg's estimated arrival time (estimateArrival()),
//     classifies it via windRelative(), and distance-weights the result into
//     {tailPct, crossPct, headPct, windScore}. No network, no state --
//     legs/forecast/startDate/avgSpeedKmh are all parameters.
//   - pickRecommendedRoutes(scoredCandidates): buckets already-scored
//     candidates by distanceKm and keeps only the single highest-windScore
//     candidate per bucket, silently omitting an empty bucket rather than
//     padding it with a placeholder.
//
// Bearing convention used throughout: 0 = heading north. windRelative()'s
// own thresholds (55/125) are exercised indirectly here via
// scoreRouteWindForStartTime() -- three canonical wind directions relative
// to a bearing-0 leg are used everywhere below: windDir 180 (wind FROM the
// south, blowing north -> tailwind for a northbound leg), windDir 0 (wind
// FROM the north -> headwind), windDir 90 (wind FROM the east -> crosswind).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

// Single-hour synthetic forecast -- enough for tests that don't care about
// the nearest-slot-picking logic itself, only about the tail/cross/head
// classification and distance weighting.
function oneHourForecast(atIso, windDirDeg) {
  return { time: [atIso], wind_direction_10m: [windDirDeg] };
}

test('scoreRouteWindForStartTime', async (t) => {
  const { get } = loadApp();
  const scoreRouteWindForStartTime = get('scoreRouteWindForStartTime');

  await t.test('pure tailwind leg -> tailPct 100, windScore 100', () => {
    const legs = [{ bearing: 0, distanceKm: 10 }];
    const forecast = oneHourForecast('2026-01-01T10:00:00', 180);
    const out = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T10:00:00'), 20);
    assert.deepEqual(plain(out), { tailPct: 100, crossPct: 0, headPct: 0, windScore: 100 });
  });

  await t.test('pure headwind leg -> headPct 100, windScore -100', () => {
    const legs = [{ bearing: 0, distanceKm: 10 }];
    const forecast = oneHourForecast('2026-01-01T10:00:00', 0);
    const out = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T10:00:00'), 20);
    assert.deepEqual(plain(out), { tailPct: 0, crossPct: 0, headPct: 100, windScore: -100 });
  });

  await t.test('pure crosswind leg -> crossPct 100, windScore 0', () => {
    const legs = [{ bearing: 0, distanceKm: 10 }];
    const forecast = oneHourForecast('2026-01-01T10:00:00', 90);
    const out = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T10:00:00'), 20);
    assert.deepEqual(plain(out), { tailPct: 0, crossPct: 100, headPct: 0, windScore: 0 });
  });

  await t.test('distance-weighting: a long tailwind leg + a short headwind leg skews toward tailwind', () => {
    // Single forecast slot, so both legs see the same wind (180 = tailwind
    // for a bearing-0 leg, headwind for a bearing-180 leg) -- only the two
    // legs' relative lengths differ.
    const legs = [
      { bearing: 0, distanceKm: 90 },   // tailwind, long
      { bearing: 180, distanceKm: 10 }, // headwind, short
    ];
    const forecast = oneHourForecast('2026-01-01T10:00:00', 180);
    const out = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T10:00:00'), 100);
    assert.equal(out.tailPct, 90);
    assert.equal(out.headPct, 10);
    assert.equal(out.windScore, 80);
  });

  await t.test('distance-weighting: swapping the same two legs\' lengths flips which wind type dominates', () => {
    const legs = [
      { bearing: 0, distanceKm: 10 },   // tailwind, short
      { bearing: 180, distanceKm: 90 }, // headwind, long
    ];
    const forecast = oneHourForecast('2026-01-01T10:00:00', 180);
    const out = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T10:00:00'), 100);
    assert.equal(out.tailPct, 10);
    assert.equal(out.headPct, 90);
    assert.equal(out.windScore, -80);
  });

  await t.test('nearest-hourly-slot picking: each leg is scored against the slot nearest ITS OWN arrival time, not the route\'s start time', () => {
    // Two 30km legs at 30km/h -> leg 1 arrives 1h after start (cumulative
    // 30km), leg 2 arrives 2h after start (cumulative 60km). Both legs share
    // bearing 0. The synthetic forecast alternates head/tail/head across the
    // three hourly slots -- if the function wrongly used a single lookup
    // for the whole route (e.g. always the start-time slot), both legs would
    // score as headwind (slot 0). Scoring each leg at its own arrival
    // instead should split them: leg 1 -> slot "+1h" (tail), leg 2 -> slot
    // "+2h" (head).
    const legs = [
      { bearing: 0, distanceKm: 30 },
      { bearing: 0, distanceKm: 30 },
    ];
    const forecast = {
      time: ['2026-01-01T10:00:00', '2026-01-01T11:00:00', '2026-01-01T12:00:00'],
      wind_direction_10m: [0, 180, 0], // head, tail, head
    };
    const out = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T10:00:00'), 30);
    assert.equal(out.tailPct, 50);
    assert.equal(out.headPct, 50);
    assert.equal(out.windScore, 0);
  });

  await t.test('nearest-hourly-slot picking: a different startDate against the SAME forecast array shifts every leg\'s arrival and can flip the result', () => {
    const legs = [{ bearing: 0, distanceKm: 20 }];
    const forecast = {
      time: ['2026-01-01T09:00:00', '2026-01-01T10:00:00', '2026-01-01T11:00:00'],
      wind_direction_10m: [0, 180, 0], // head, tail, head
    };
    // avgSpeed 20 km/h -> 20km leg takes exactly 1h.
    const startingAt9 = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T09:00:00'), 20); // arrival 10:00 -> tail
    const startingAt8 = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T08:00:00'), 20); // arrival 09:00 -> head
    assert.equal(startingAt9.windScore, 100);
    assert.equal(startingAt8.windScore, -100);
  });

  await t.test('nearest-hourly-slot picking: an off-grid arrival time rounds to the closer of two candidate slots', () => {
    const legs = [{ bearing: 0, distanceKm: 10 }];
    const forecast = {
      time: ['2026-01-01T09:00:00', '2026-01-01T10:00:00'],
      wind_direction_10m: [0, 180], // head, tail
    };
    // avgSpeed 20 km/h -> 10km leg takes 30min. Starting at 09:40 -> arrival
    // 10:10, 10min from the 10:00 slot vs 70min from the 09:00 slot -> tail.
    const out = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T09:40:00'), 20);
    assert.equal(out.windScore, 100);
  });

  await t.test('zero-length legs are skipped from both distance and total, no NaN/division artifacts', () => {
    const legs = [
      { bearing: 0, distanceKm: 0 },
      { bearing: 0, distanceKm: 10 },
    ];
    const forecast = oneHourForecast('2026-01-01T10:00:00', 180);
    const out = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T10:00:00'), 20);
    assert.deepEqual(plain(out), { tailPct: 100, crossPct: 0, headPct: 0, windScore: 100 });
  });

  await t.test('empty legs array -> all-zero result, not a crash', () => {
    const out = scoreRouteWindForStartTime([], oneHourForecast('2026-01-01T10:00:00', 180), new Date('2026-01-01T10:00:00'), 20);
    assert.deepEqual(plain(out), { tailPct: 0, crossPct: 0, headPct: 0, windScore: 0 });
  });

  await t.test('missing/empty hourly forecast -> all-zero result, not a crash', () => {
    const legs = [{ bearing: 0, distanceKm: 10 }];
    assert.deepEqual(plain(scoreRouteWindForStartTime(legs, { time: [], wind_direction_10m: [] }, new Date('2026-01-01T10:00:00'), 20)),
      { tailPct: 0, crossPct: 0, headPct: 0, windScore: 0 });
    assert.deepEqual(plain(scoreRouteWindForStartTime(legs, null, new Date('2026-01-01T10:00:00'), 20)),
      { tailPct: 0, crossPct: 0, headPct: 0, windScore: 0 });
  });

  // REGRESSION: a forecast slot with a `time` entry but no matching
  // wind_direction_10m value (malformed API response -- e.g. arrays of
  // mismatched length) used to be silently misread as "100% crosswind":
  // windRelative(bearing, undefined) compares against NaN, which fails both
  // the tail (<=55) and head (>=125) angle checks and falls through to
  // "cross". A leg with no real wind data should contribute nothing to the
  // mix instead of masquerading as a confident crosswind reading.
  await t.test('a forecast slot with a missing wind_direction_10m value is skipped, not misread as crosswind', () => {
    const legs = [{ bearing: 0, distanceKm: 10 }];
    const forecast = { time: ['2026-01-01T10:00:00'], wind_direction_10m: [undefined] };
    assert.deepEqual(plain(scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T10:00:00'), 20)),
      { tailPct: 0, crossPct: 0, headPct: 0, windScore: 0 });
  });

  await t.test('a leg with a missing wind slot is excluded from the mix while other legs still score normally', () => {
    const legs = [
      { bearing: 0, distanceKm: 5 },  // cum 5km @10km/h -> arrives 10:30, nearest slot is 10:00 (missing wind) -> excluded
      { bearing: 0, distanceKm: 15 }, // cum 20km @10km/h -> arrives 12:00, nearest slot is 12:00 (tailwind) -> counted
    ];
    const forecast = {
      time: ['2026-01-01T10:00:00', '2026-01-01T12:00:00'],
      wind_direction_10m: [undefined, 180],
    };
    const out = scoreRouteWindForStartTime(legs, forecast, new Date('2026-01-01T10:00:00'), 10);
    assert.deepEqual(plain(out), { tailPct: 100, crossPct: 0, headPct: 0, windScore: 100 });
  });
});

test('pickRecommendedRoutes', async (t) => {
  const { get } = loadApp();
  const pickRecommendedRoutes = get('pickRecommendedRoutes');

  await t.test('one candidate per bucket -> all 3 returned, in ascending-distance bucket order', () => {
    const candidates = [
      { id: 'short', distanceKm: 30, windScore: 10 },
      { id: 'mid', distanceKm: 60, windScore: 5 },
      { id: 'long', distanceKm: 90, windScore: -5 },
    ];
    const out = pickRecommendedRoutes(candidates);
    assert.deepEqual(plain(out.map(c => c.id)), ['short', 'mid', 'long']);
  });

  await t.test('boundary: exactly 50km falls into the 50-75 bucket, not the <50 bucket', () => {
    const candidates = [{ id: 'boundary50', distanceKm: 50, windScore: 1 }];
    const out = pickRecommendedRoutes(candidates);
    assert.equal(out.length, 1);
    // Proven by bucket membership, not just presence: pair it with a
    // genuinely-<50 candidate with a HIGHER windScore in the same call --
    // if 50.0 wrongly landed in the <50 bucket, that higher-scoring
    // candidate would win the tile instead and boundary50 would disappear.
    const withCompetitor = pickRecommendedRoutes([
      { id: 'under50', distanceKm: 49.9, windScore: 100 },
      { id: 'boundary50', distanceKm: 50, windScore: 1 },
    ]);
    assert.deepEqual(plain(withCompetitor.map(c => c.id)).sort(), ['boundary50', 'under50']);
  });

  await t.test('boundary: exactly 75km falls into the >=75 bucket, not the 50-75 bucket', () => {
    const withCompetitor = pickRecommendedRoutes([
      { id: 'under75', distanceKm: 74.9, windScore: 100 },
      { id: 'boundary75', distanceKm: 75, windScore: 1 },
    ]);
    assert.deepEqual(plain(withCompetitor.map(c => c.id)).sort(), ['boundary75', 'under75']);
  });

  await t.test('an empty bucket is silently skipped -- fewer than 3 tiles, no placeholder', () => {
    const candidates = [
      { id: 'short', distanceKm: 20, windScore: 1 },
      { id: 'long', distanceKm: 100, windScore: 1 },
      // nothing in the 50-75 bucket
    ];
    const out = pickRecommendedRoutes(candidates);
    assert.equal(out.length, 2);
    assert.deepEqual(plain(out.map(c => c.id)), ['short', 'long']);
  });

  await t.test('all buckets empty (no candidates at all) -> empty array', () => {
    assert.deepEqual(plain(pickRecommendedRoutes([])), []);
  });

  await t.test('multiple candidates in the same bucket -> only the highest windScore wins', () => {
    const candidates = [
      { id: 'weak', distanceKm: 40, windScore: -10 },
      { id: 'best', distanceKm: 45, windScore: 50 },
      { id: 'middling', distanceKm: 35, windScore: 20 },
    ];
    const out = pickRecommendedRoutes(candidates);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'best');
  });

  await t.test('one strong candidate per bucket among several weaker ones in each -> exactly the 3 winners, in order', () => {
    const candidates = [
      { id: 's-weak', distanceKm: 10, windScore: -20 },
      { id: 's-best', distanceKm: 45, windScore: 30 },
      { id: 'm-weak', distanceKm: 55, windScore: 0 },
      { id: 'm-best', distanceKm: 70, windScore: 40 },
      { id: 'l-weak', distanceKm: 80, windScore: -5 },
      { id: 'l-best', distanceKm: 120, windScore: 15 },
    ];
    const out = pickRecommendedRoutes(candidates);
    assert.deepEqual(plain(out.map(c => c.id)), ['s-best', 'm-best', 'l-best']);
  });

  await t.test('non-distance/windScore fields on a candidate pass through untouched (caller metadata like name/raw/source)', () => {
    const candidates = [
      { id: 'x', distanceKm: 30, windScore: 5, name: 'Feierabendrunde', source: 'route', raw: { foo: 'bar' } },
    ];
    const out = pickRecommendedRoutes(candidates);
    assert.equal(out[0].name, 'Feierabendrunde');
    assert.equal(out[0].source, 'route');
    assert.deepEqual(plain(out[0].raw), { foo: 'bar' });
  });
});

// buildRecommendedCandidatePool(): not a pure function (reads state.stravaRoutes/
// state.activities/state.recommendedOnlySavedRoutes directly), so tests here
// go through get('state') to set up fixtures rather than passing parameters.
// Only the state.recommendedOnlySavedRoutes toggle's filtering behavior is
// covered -- the route/activity-shape mapping itself (selectionId/source/...)
// is straightforward field copying with no branching worth a dedicated test.
test('buildRecommendedCandidatePool', async (t) => {
  function sampleRoute(id) {
    return { id, name: 'Route ' + id, distance: 40000, elevation_gain: 300, map: { polyline: 'abc' } };
  }
  function sampleActivity(id) {
    return { id, name: 'Ride ' + id, type: 'Ride', distance: 30000, total_elevation_gain: 200, map: { summary_polyline: 'xyz' } };
  }

  await t.test('recommendedOnlySavedRoutes off (default): both saved routes and activities are pooled', () => {
    const { get } = loadApp();
    const state = get('state');
    state.stravaRoutes = [sampleRoute(1)];
    state.activities = [sampleActivity(2)];
    const pool = get('buildRecommendedCandidatePool')();
    assert.deepEqual(plain(pool.map(c => c.source)), ['route', 'activity']);
  });

  await t.test('recommendedOnlySavedRoutes on: activities are excluded entirely, only saved routes remain', () => {
    const { get } = loadApp();
    const state = get('state');
    state.stravaRoutes = [sampleRoute(1)];
    state.activities = [sampleActivity(2)];
    state.recommendedOnlySavedRoutes = true;
    const pool = get('buildRecommendedCandidatePool')();
    assert.deepEqual(plain(pool.map(c => c.source)), ['route']);
  });

  await t.test('recommendedOnlySavedRoutes on with no saved routes at all: pool is empty, not falling back to activities', () => {
    const { get } = loadApp();
    const state = get('state');
    state.stravaRoutes = [];
    state.activities = [sampleActivity(2)];
    state.recommendedOnlySavedRoutes = true;
    const pool = get('buildRecommendedCandidatePool')();
    assert.deepEqual(plain(pool), []);
  });
});
