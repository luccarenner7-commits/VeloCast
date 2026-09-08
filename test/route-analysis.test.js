'use strict';
// Route-geometry primitives behind route-adaptive workouts (index.html,
// "---------- Trainer: route-based training ----------" section): the
// climb/flat/descent segmentation feeding the Trainer tab's route
// suitability scoring and interval placement. Two of the hardest-remaining
// gaps in the 2026-09 test-coverage audit -- previously untested because
// building a realistic elevation/coordinate fixture takes real effort, not
// because the functions are simple.
//   - smoothElevation/computeCurvature/detectIntersectionCandidates: the
//     low-level per-point signals analyzeRoute() is built on.
//   - analyzeRoute(): composite climb/flat/descent segmentation, including
//     the short-segment merge and the climb-gap-climb bridging pass (see its
//     long in-code comment in index.html for why that bridge exists).
//   - placeIntervalsOnRoute(): covered further down in THIS file (see the
//     'placeIntervalsOnRoute' test below, ~line 446), since it also leans on
//     the Training Decision Engine's class-constraint config.
//
// All fixtures use `pts: Array<{lat, lon, dist, ele}>` with `dist` in
// METERS (cumulative, monotonically non-decreasing) -- NOT km. This is
// deliberately different from test/pure-functions.test.js's buildCumDist()
// helper (which returns km, for a different set of bearing-only functions)
// and from test/export-builders.test.js's buildCourseFit() point fixtures
// (same {lat,lon,dist,ele} shape, reused here as the skeleton).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

// Converts a physical meter offset to a lat/lon degree offset for building
// synthetic straight-line coordinate walks -- same technique as
// test/pure-functions.test.js's smoothedBearingAt() fixtures (fixed-heading
// steps), just parameterized by real-world meters instead of an eyeballed
// degree-per-step constant, since detectIntersectionCandidates()'s gap
// thresholds are meter-based.
function metersToLonDeg(m, atLat) { return m / (111320 * Math.cos((atLat * Math.PI) / 180)); }
function metersToLatDeg(m) { return m / 110540; }

test('smoothElevation', async (t) => {
  const { get } = loadApp();
  const smoothElevation = get('smoothElevation');

  await t.test('a step function gets averaged into a ramp inside the transition window, flat outside it', () => {
    // 11 points 10m apart; ele jumps from 100 to 200 at dist=60. With a 40m
    // window (+-20m), only points within 20m of the jump ever see both
    // values in their averaging window.
    const pts = [];
    for (let i = 0; i <= 10; i++) pts.push({ dist: i * 10, ele: i * 10 <= 50 ? 100 : 200 });
    const out = smoothElevation(pts, 40);
    assert.equal(out.length, pts.length);
    assert.equal(out[0], 100); // dist 0: window [-20,20] all pre-jump
    assert.equal(out[1], 100); // dist 10
    assert.equal(out[2], 100); // dist 20
    assert.equal(out[3], 100); // dist 30
    assert.equal(out[4], 120); // dist 40: window [20,60] sees 100 (x4) + 200 (x1) = 120
    assert.equal(out[5], 140); // dist 50: window [30,70] sees 100 (x3) + 200 (x2) = 140
    assert.equal(out[10], 200); // dist 100: window fully past the jump
  });

  await t.test('null ele values are skipped from both the sum and the count, not treated as 0', () => {
    const pts = [
      { dist: 0, ele: 100 }, { dist: 10, ele: null }, { dist: 20, ele: 120 },
      { dist: 30, ele: null }, { dist: 40, ele: 140 },
    ];
    const out = smoothElevation(pts, 30); // +-15m window
    // idx1 (dist 10, itself null): window [-5,25] sees dist0(100) and dist20(120) -> avg 110, NOT (100+0+120)/3.
    assert.equal(out[1], 110);
    // idx3 (dist 30, itself null): window [15,45] sees dist20(120) and dist40(140) -> avg 130.
    assert.equal(out[3], 130);
  });

  await t.test('a window with zero valid points anywhere in range falls back to the point\'s own ele (?? 0 if that\'s also null)', () => {
    const pts = [{ dist: 0, ele: null }];
    assert.deepEqual(plain(smoothElevation(pts, 100)), [0]);
  });

  await t.test('single point -> single-element array unchanged', () => {
    assert.deepEqual(plain(smoothElevation([{ dist: 0, ele: 55 }], 100)), [55]);
  });
});

test('computeCurvature', async (t) => {
  const { get } = loadApp();
  const computeCurvature = get('computeCurvature');

  await t.test('a perfectly straight route has ~0 curviness at every point', () => {
    const pts = [];
    for (let i = 0; i <= 20; i++) pts.push({ lat: 45, lon: 9 + metersToLonDeg(i * 50, 45), dist: i * 50 });
    const curv = computeCurvature(pts, 300);
    assert.equal(curv.length, pts.length);
    curv.forEach((c) => assert.ok(Math.abs(c) < 1e-6, `expected ~0, got ${c}`));
  });

  await t.test('a sharp turn produces a local curviness spike that decays away outside the window', () => {
    // Heads east for 450m, then turns 90 degrees to head north for another
    // 450m (see buildTightTurn() below for the exact point layout). With a
    // 300m window, points well inside either straight leg (>150m from the
    // turn) should see curviness fall back near 0, while points close to
    // the turn should not.
    const pts = buildTightTurn();
    const curv = computeCurvature(pts, 300);
    const turnIdx = 10; // the vertex where the 90-degree turn actually happens (see helper)
    assert.ok(curv[turnIdx] > 100, `expected a real curviness spike at the turn, got ${curv[turnIdx]}`);
    assert.ok(Math.abs(curv[0]) < 1, 'far from the turn on the east leg should read ~0');
    assert.ok(Math.abs(curv[curv.length - 1]) < 1, 'far from the turn on the north leg should read ~0');
  });

  await t.test('windowM defaults to 300 when omitted', () => {
    const pts = buildTightTurn();
    assert.deepEqual(plain(computeCurvature(pts)), plain(computeCurvature(pts, 300)));
  });

  await t.test('single point -> single-element zero array (loop bodies never execute)', () => {
    assert.deepEqual(plain(computeCurvature([{ lat: 0, lon: 0, dist: 0 }], 300)), [0]);
  });
});

test('detectIntersectionCandidates', async (t) => {
  const { get } = loadApp();
  const detectIntersectionCandidates = get('detectIntersectionCandidates');

  await t.test('fewer than 3 points -> [] unconditionally (documented guard)', () => {
    assert.deepEqual(plain(detectIntersectionCandidates([], 55, 25)), []);
    assert.deepEqual(plain(detectIntersectionCandidates([{ lat: 0, lon: 0, dist: 0 }], 55, 25)), []);
    assert.deepEqual(
      plain(detectIntersectionCandidates([{ lat: 0, lon: 0, dist: 0 }, { lat: 0, lon: 0.001, dist: 100 }], 55, 25)),
      []
    );
  });

  await t.test('a sharp (90deg) turn compressed into a short physical gap is flagged', () => {
    const pts = buildTightTurn();
    const found = detectIntersectionCandidates(pts, 55, 25);
    assert.equal(found.length, 1);
    assert.equal(found[0].idx, 10);
    assert.equal(found[0].dist, 458);
    assert.equal(found[0].turnDeg, 90);
  });

  await t.test('defaults (thresholdDeg=55, minGapM=25) match explicit values', () => {
    const pts = buildTightTurn();
    assert.deepEqual(plain(detectIntersectionCandidates(pts)), plain(detectIntersectionCandidates(pts, 55, 25)));
  });

  await t.test('a gentle turn (well under thresholdDeg) in the same short gap is NOT flagged', () => {
    const pts = buildGentleTurn();
    assert.deepEqual(plain(detectIntersectionCandidates(pts, 55, 25)), []);
  });

  await t.test('the same sharp turn spread over a gap LARGER than minGapM is not flagged (real terrain feature, not a compressed junction)', () => {
    // Same 90-degree direction change as buildTightTurn(), but the points
    // straddling it are the route's normal 50m-spaced points rather than an
    // artificially close-together cluster -- i.e. a plain right-angle bend
    // in the road, not a "sharp turn squeezed into a few meters" signal.
    const lat0 = 45;
    const pts = [];
    for (let i = 0; i <= 9; i++) pts.push({ lat: lat0, lon: 9 + metersToLonDeg(i * 50, lat0), dist: i * 50 });
    const cornerLon = pts[9].lon;
    for (let i = 1; i <= 9; i++) pts.push({ lat: lat0 + metersToLatDeg(i * 50), lon: cornerLon, dist: 450 + i * 50 });
    const found = detectIntersectionCandidates(pts, 55, 25);
    assert.deepEqual(plain(found), []);
  });

  await t.test('a higher thresholdDeg suppresses a turn that would otherwise qualify', () => {
    // The fixture's turn reports as a rounded 90deg, but the underlying raw
    // spherical-bearing computation lands fractionally under 90 (checked:
    // ~89.99996) -- so 91 is used as the "clearly above" side rather than
    // asserting exact-90 boundary inclusivity, which would be sensitive to
    // that float noise rather than to thresholdDeg's actual behavior.
    const pts = buildTightTurn();
    assert.deepEqual(plain(detectIntersectionCandidates(pts, 91, 25)), []);
    assert.equal(detectIntersectionCandidates(pts, 89, 25).length, 1);
  });

  await t.test('a smaller minGapM excludes a turn whose physical gap is now too large', () => {
    const pts = buildTightTurn(); // the fixture's turn gap is 16m (dist 466 - dist 450)
    assert.deepEqual(plain(detectIntersectionCandidates(pts, 55, 10)), []);
    assert.equal(detectIntersectionCandidates(pts, 55, 16).length, 1); // boundary is inclusive (<=)
  });
});

// Shared fixture for computeCurvature()/detectIntersectionCandidates(): a
// route heading due east in normal 50m steps, then a genuinely sharp
// (90-degree) turn squeezed into a ~16m physical gap (mimicking a real
// junction/switchback rather than a gradual bend), then continuing due
// north in normal 50m steps. Indices 0-9 are the east leg (dist 0..450),
// index 10 is the turn vertex itself (dist 458, still 8m further east),
// index 11 is the first north-leg point (dist 466, 8m north of index 10),
// indices 12-20 continue north in 50m steps.
function buildTightTurn() {
  const lat0 = 45, lon0 = 9;
  const pts = [];
  for (let i = 0; i <= 9; i++) pts.push({ lat: lat0, lon: lon0 + metersToLonDeg(i * 50, lat0), dist: i * 50, ele: 0 });
  pts.push({ lat: lat0, lon: lon0 + metersToLonDeg(458, lat0), dist: 458, ele: 0 }); // idx 10: turn vertex
  const turnLon = pts[10].lon;
  pts.push({ lat: lat0 + metersToLatDeg(8), lon: turnLon, dist: 466, ele: 0 }); // idx 11: first north-leg point
  for (let i = 1; i <= 9; i++) {
    pts.push({ lat: lat0 + metersToLatDeg(8 + i * 50), lon: turnLon, dist: 466 + i * 50, ele: 0 });
  }
  return pts;
}

// Same physical layout as buildTightTurn() (same distances/gap), but the
// post-turn heading is only ~20 degrees off the east leg instead of a full
// 90 -- a gentle bend compressed into the same short gap, which
// detectIntersectionCandidates() should NOT flag at the default 55-degree
// threshold even though the gap-compression signal alone is identical.
function buildGentleTurn() {
  const lat0 = 45, lon0 = 9;
  const headingRad = (20 * Math.PI) / 180;
  const pts = [];
  for (let i = 0; i <= 9; i++) pts.push({ lat: lat0, lon: lon0 + metersToLonDeg(i * 50, lat0), dist: i * 50, ele: 0 });
  pts.push({ lat: lat0, lon: lon0 + metersToLonDeg(458, lat0), dist: 458, ele: 0 }); // idx 10: still heading east
  let prev = pts[10];
  pts.push({
    lat: prev.lat + metersToLatDeg(8 * Math.sin(headingRad)),
    lon: prev.lon + metersToLonDeg(8 * Math.cos(headingRad), lat0),
    dist: 466, ele: 0,
  }); // idx 11: heading rotated only 20deg off east
  for (let i = 1; i <= 9; i++) {
    prev = pts[pts.length - 1];
    pts.push({
      lat: prev.lat + metersToLatDeg(50 * Math.sin(headingRad)),
      lon: prev.lon + metersToLonDeg(50 * Math.cos(headingRad), lat0),
      dist: 466 + i * 50, ele: 0,
    });
  }
  return pts;
}

// Synthetic elevation profile: flat run-in, a ~1000m climb at a steady 6%
// gradient, a short (250m, breakpoint-to-breakpoint) 1%-grade "false-flat"
// dip that dips below climbGradientThresholdPct (2.5%) but never actually
// descends, a second ~1000m climb at 6%, then a descent -- long enough
// (3350m total, 10m point spacing) to exceed elevationSmoothingM (120m),
// curvinessWindowM (300m), and minSegmentM (150m) several times over. The
// raw 250m dip is NOT what analyzeRoute() actually classifies, though: after
// 120m smoothing and the 25m gradient lookahead reshape its boundaries, the
// dip surfaces as its own ~190m classified segment (independently confirmed
// below by re-running analyzeRoute() with the climb-bridging pass disabled)
// -- long enough to clear minSegmentM (150m, so it isn't force-merged into a
// neighbour before the bridge ever runs) but short enough to stay under
// maxInterruptionM (300m, so the climb-bridging pass in analyzeRoute() is
// eligible to re-merge it into one continuous climb) -- see analyzeRoute()'s
// own long in-code comment for why that bridge exists. Elevation is defined
// as piecewise-linear between named breakpoints so the expected gradient of
// every stretch is known exactly by construction.
const CLIMB_FIXTURE_BREAKPOINTS = [
  [0, 100],      // flat run-in start
  [300, 100],    // flat run-in end / climb 1 start
  [1300, 160],   // climb 1 end (+60m over 1000m = 6%)
  [1550, 162.5], // false-flat dip end (+2.5m over 250m = 1%)
  [2550, 222.5], // climb 2 end (+60m over 1000m = 6%)
  [3350, 182.5], // descent end (-40m over 800m = -5%)
];
function eleAtDist(d, breakpoints) {
  breakpoints = breakpoints || CLIMB_FIXTURE_BREAKPOINTS;
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const [d0, e0] = breakpoints[i];
    const [d1, e1] = breakpoints[i + 1];
    if (d >= d0 && d <= d1) {
      const t = d1 === d0 ? 0 : (d - d0) / (d1 - d0);
      return e0 + t * (e1 - e0);
    }
  }
  return breakpoints[breakpoints.length - 1][1];
}
// breakpoints defaults to CLIMB_FIXTURE_BREAKPOINTS; the too-long-gap
// negative test below passes its own breakpoint set (same shape, longer
// dip) through the same builder rather than duplicating this loop.
function buildClimbRoute(breakpoints) {
  breakpoints = breakpoints || CLIMB_FIXTURE_BREAKPOINTS;
  const totalM = breakpoints[breakpoints.length - 1][0];
  const pts = [];
  for (let d = 0; d <= totalM; d += 10) {
    // A straight-line coordinate walk (no turns) so curviness never gates any
    // segment here -- analyzeRoute()'s climb/flat/descent classification is
    // what's under test, not the curvy-segment path (covered above).
    pts.push({ lat: 45 + d * 0.000001, lon: 9, dist: d, ele: eleAtDist(d, breakpoints) });
  }
  return pts;
}

test('analyzeRoute', async (t) => {
  const { get } = loadApp();
  const analyzeRoute = get('analyzeRoute');
  const TRAINING_CONFIG = get('TRAINING_CONFIG');

  await t.test('fewer than 2 points -> null', () => {
    assert.equal(analyzeRoute([], TRAINING_CONFIG), null);
    assert.equal(analyzeRoute([{ lat: 0, lon: 0, dist: 0, ele: 0 }], TRAINING_CONFIG), null);
  });

  await t.test('classifies flat run-in / bridged climb / descent, and totalDistanceM matches the last point\'s dist', () => {
    const pts = buildClimbRoute();
    const result = analyzeRoute(pts, TRAINING_CONFIG);
    assert.equal(result.totalDistanceM, 3350);
    assert.equal(result.points, pts); // passed through unchanged
    assert.equal(result.smoothed.length, pts.length);

    // Exactly 3 segments: the false-flat dip must have been bridged BACK
    // into one continuous climb, not left as its own middle segment and not
    // silently absorbed without a trace -- see the bridging comment above.
    assert.equal(result.segments.length, 3);
    const [first, second, third] = result.segments;
    assert.equal(first.type, 'flat');
    assert.equal(first.startDist, 0);
    assert.equal(second.type, 'climb');
    assert.equal(third.type, 'descent');
    assert.equal(third.endDist, 3350);
    // The bridged climb segment must span across the dip (past dist 1550),
    // not stop at the dip's start (1300).
    assert.ok(second.startDist < 400, `climb should start near the run-in's end, got ${second.startDist}`);
    assert.ok(second.endDist > 2400, `bridged climb should extend well past the dip, got ${second.endDist}`);
    // The bridged segment's own recomputed average gradient must still read
    // as a real climb (well above climbGradientThresholdPct), confirming the
    // dip's shallow +1% didn't get discarded/misweighted in the merge.
    assert.ok(second.avgGradient > 4, `expected a strong average climb gradient, got ${second.avgGradient}`);
  });

  await t.test('the climb-bridging pass genuinely fires: disabling it (maxInterruptionM=0) leaves the dip as its own segment', () => {
    // The test above shows a single bridged climb, but that alone doesn't
    // prove the bridge did anything -- it would look identical if the dip
    // simply never got its own segment in the first place (e.g. if it fell
    // under minSegmentM and got force-merged before the bridge ever runs).
    // This is the actual proof: re-run the SAME fixture with the bridge
    // gated off (maxInterruptionM=0, i.e. `maxGapM > 0` at the top of the
    // bridging block in analyzeRoute() is false) and confirm the dip now
    // survives as its own separate 'flat' segment between two shorter
    // climbs -- a genuine before/after comparison, not a single static
    // assertion that happens to pass.
    const pts = buildClimbRoute();
    const cfgBridgeOff = plain(TRAINING_CONFIG);
    cfgBridgeOff.constraints.common.maxInterruptionM = 0;

    const bridged = analyzeRoute(pts, TRAINING_CONFIG);
    const unbridged = analyzeRoute(pts, cfgBridgeOff);

    assert.equal(bridged.segments.length, 3, 'bridge ON: dip merged away, 3 segments');
    assert.equal(unbridged.segments.length, 5, 'bridge OFF: dip survives as its own segment, 5 segments');
    const [uFlat, uClimb1, uDip, uClimb2, uDescent] = unbridged.segments;
    assert.equal(uFlat.type, 'flat');
    assert.equal(uClimb1.type, 'climb');
    assert.equal(uDip.type, 'flat');
    assert.equal(uDip.startDist, 1320);
    assert.equal(uDip.endDist, 1510);
    assert.equal(uDip.distanceM, 190); // above minSegmentM (150), below maxInterruptionM (300)
    assert.equal(uClimb2.type, 'climb');
    assert.equal(uDescent.type, 'descent');
    // Same start/end distances either way (the bridge only merges segments,
    // it never changes classification of the route's endpoints).
    assert.equal(unbridged.totalDistanceM, bridged.totalDistanceM);
  });

  await t.test('climbs list contains exactly the bridged climb segment (>=150m)', () => {
    const pts = buildClimbRoute();
    const result = analyzeRoute(pts, TRAINING_CONFIG);
    assert.equal(result.climbs.length, 1);
    assert.equal(result.climbs[0].type, 'climb');
    assert.ok(result.climbs[0].distanceM >= 150);
  });

  await t.test('climbs list is sorted by distance descending when more than one climb survives', () => {
    // A longer dip (raw 400m breakpoint-to-breakpoint here) reshapes into a
    // ~340m classified gap after smoothing/lookahead -- ABOVE
    // maxInterruptionM (300m), so even with the bridge enabled (default
    // TRAINING_CONFIG) it correctly refuses to merge: two separate climbs of
    // different lengths survive, which is what actually exercises the
    // "sorted by distance descending" behaviour (a single-climb fixture
    // can't, since there's nothing to sort).
    const longGapBreakpoints = [
      [0, 100], [300, 100], [1300, 160], [1700, 164], [2700, 224], [3500, 184],
    ];
    const pts = buildClimbRoute(longGapBreakpoints);
    const result = analyzeRoute(pts, TRAINING_CONFIG);
    assert.equal(result.segments.length, 5, 'gap too long for the bridge, stays its own segment');
    assert.equal(result.segments[2].type, 'flat');
    assert.ok(
      result.segments[2].distanceM > TRAINING_CONFIG.constraints.common.maxInterruptionM,
      `gap should exceed maxInterruptionM, got ${result.segments[2].distanceM}`
    );
    assert.equal(result.climbs.length, 2);
    assert.ok(result.climbs[0].distanceM >= result.climbs[1].distanceM, 'descending by distanceM');
    assert.equal(result.climbs[0].startDist, 1660);
    assert.equal(result.climbs[1].startDist, 280);
  });

  await t.test('totalElevGainM sums only the positive smoothed-elevation deltas (close to the fixture\'s ~122.5m built-in gain)', () => {
    const pts = buildClimbRoute();
    const result = analyzeRoute(pts, TRAINING_CONFIG);
    // Built-in gain: 60m (climb 1) + 2.5m (dip) + 60m (climb 2) = 122.5m.
    // Smoothing can shave a little off the sharp corners at each breakpoint,
    // so allow a small tolerance rather than asserting exact equality.
    assert.ok(Math.abs(result.totalElevGainM - 122.5) < 10, `expected ~122.5m total gain, got ${result.totalElevGainM}`);
  });

  await t.test('config defaults to TRAINING_CONFIG when omitted', () => {
    const pts = buildClimbRoute();
    assert.deepEqual(plain(analyzeRoute(pts, undefined)), plain(analyzeRoute(pts, TRAINING_CONFIG)));
  });

  await t.test('a route entirely below minSegmentM in every direction-change collapses to a single segment, not a crash', () => {
    // 5 points, dead flat, well under any interesting threshold -- exercises
    // the n>=2 path without a climb/descent ever appearing.
    const pts = [0, 50, 100, 150, 200].map((d) => ({ lat: 45, lon: 9, dist: d, ele: 50 }));
    const result = analyzeRoute(pts, TRAINING_CONFIG);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].type, 'flat');
    assert.equal(result.climbs.length, 0);
  });
});

// ---------------------------------------------------------------------
// placeIntervalsOnRoute(route, spec, adj, classKey, config, options, rp)
// ---------------------------------------------------------------------
// Unlike analyzeRoute() above, these tests build `route` objects directly
// (a plain { points, totalDistanceM, segments } literal) rather than piping
// a point fixture through analyzeRoute() first -- that gives full,
// deterministic control over segment type/gradient/curviness, which
// packPass()'s capacity math (see index.html's own long comments on
// packPass/extendCompressedIntervalsBackward) needs to be pinned down
// exactly. `route.points` is still a real straight-line point fixture
// (rather than []) since placeIntervalsOnRoute() feeds it to
// detectIntersectionCandidates() whenever classKey+config are both given
// and no explicit options.intersectionCandidates is supplied -- a straight
// line deterministically yields zero intersections without needing to fake
// that list.
//
// rp={} throughout -- no rp.speedModel means estimateDistanceForMinutes()
// falls back to the fixed GRADIENT_BUCKETS table, which only depends on
// gradient (not on `pct`), so warmup/cooldown/interval distances below are
// computed by hand from that fixed table:
//   flat (-1..1%): 27 km/h  |  gentle climb (3..<6%): 16 km/h
function straightPts(totalM, stepM) {
  const pts = [];
  for (let d = 0; d <= totalM; d += stepM) pts.push({ lat: 45 + d * 0.000001, lon: 9, dist: d, ele: 100 });
  return pts;
}
function routeSeg(type, startDist, endDist, avgGradient, curvy) {
  return { type, startDist, endDist, distanceM: endDist - startDist, avgGradient, avgCurviness: curvy ? 400 : 0, curvy: !!curvy };
}

test('placeIntervalsOnRoute', async (t) => {
  const { get } = loadApp();
  const placeIntervalsOnRoute = get('placeIntervalsOnRoute');
  const TRAINING_CONFIG = get('TRAINING_CONFIG');
  const rp = {};

  await t.test('abundant ideal-climb capacity: every prescribed interval+rest gets placed in ride order', () => {
    // 1min warmup (flat, 27km/h -> 450m) + 3x(8min interval, 3min rest except
    // after the last) + 1min cooldown (450m), on a route with a single huge
    // ideal-gradient (4%) climb segment (2000-15000m, 13km of capacity) --
    // far more than the 3*8min of interval time (each interval's fallback
    // distance at the climb's 16km/h bucket is 2.13km) could ever need.
    const route = {
      points: straightPts(20000, 20),
      totalDistanceM: 20000,
      segments: [routeSeg('flat', 0, 2000, 0, false), routeSeg('climb', 2000, 15000, 4, false), routeSeg('flat', 15000, 20000, 0, false)],
    };
    const spec = {
      warmup: { label: 'Einrollen', minutes: 1, pct: 0.55, note: null },
      activation: null,
      reps: [
        { label: 'Intervall', minutes: 8, pct: 0.97, note: null, restAfter: [{ label: 'Pause', minutes: 3, pct: 0.5, note: null }] },
        { label: 'Intervall', minutes: 8, pct: 0.97, note: null, restAfter: [{ label: 'Pause', minutes: 3, pct: 0.5, note: null }] },
        { label: 'Intervall', minutes: 8, pct: 0.97, note: null, restAfter: [] },
      ],
      cooldown: { label: 'Ausrollen', minutes: 1, pct: 0.5, note: null },
    };
    const result = placeIntervalsOnRoute(route, spec, 1, 'threshold', TRAINING_CONFIG, {}, rp);
    assert.equal(result.targetIntervalMin, 24);
    assert.equal(result.placedIntervalMin, 24); // everything fit
    assert.equal(result.intervalCount, 3);
    assert.equal(result.targetCount, 3);
    assert.deepEqual(plain(result.rejectedSegments), []);
    const intervalSteps = result.steps.filter((s) => s.kind === 'interval');
    assert.equal(intervalSteps.length, 3);
    intervalSteps.forEach((s) => assert.equal(s.type, 'climb'));
    // Ride order is preserved: each interval starts after the previous
    // interval/rest ends, all within the climb's [2000,15000) span.
    for (let i = 1; i < intervalSteps.length; i++) {
      assert.ok(intervalSteps[i].startDist >= intervalSteps[i - 1].endDist);
    }
    assert.ok(intervalSteps[intervalSteps.length - 1].endDist <= 15000);
  });

  await t.test('a curvy segment is excluded from placement and reported in rejectedSegments; a descent never hosts intervals or appears in rejectedSegments', () => {
    // Same 3-interval spec as above, but the route only has 8km total and a
    // tight, curvy climb sub-segment splitting the terrain -- exercises
    // capacity-limited placement (only the first interval fits) alongside
    // the curvy-exclusion and descent-exclusion rules in the same fixture.
    const route = {
      points: straightPts(8000, 20),
      totalDistanceM: 8000,
      segments: [
        routeSeg('flat', 0, 1000, 0, false),
        routeSeg('climb', 1000, 5000, 4, false),
        routeSeg('climb', 5000, 5500, 4, true), // curvy -> unsuitable despite an ideal gradient
        routeSeg('descent', 5500, 6500, -5, false),
        routeSeg('flat', 6500, 8000, 0, false),
      ],
    };
    const spec = {
      warmup: { label: 'Einrollen', minutes: 1, pct: 0.55, note: null },
      activation: null,
      reps: [
        { label: 'Intervall', minutes: 8, pct: 0.97, note: null, restAfter: [{ label: 'Pause', minutes: 3, pct: 0.5, note: null }] },
        { label: 'Intervall', minutes: 8, pct: 0.97, note: null, restAfter: [{ label: 'Pause', minutes: 3, pct: 0.5, note: null }] },
        { label: 'Intervall', minutes: 8, pct: 0.97, note: null, restAfter: [] },
      ],
      cooldown: { label: 'Ausrollen', minutes: 1, pct: 0.5, note: null },
    };
    const result = placeIntervalsOnRoute(route, spec, 1, 'threshold', TRAINING_CONFIG, {}, rp);
    assert.equal(result.intervalCount, 1); // only the first interval had room before capacity ran out
    assert.equal(result.placedIntervalMin, 8);
    assert.deepEqual(plain(result.rejectedSegments), [{ startDist: 5000, endDist: 5500, reasons: ['Abschnitt zu kurvig.'] }]);
    // The descent segment shows up as an unplaced 'cruise' step (never an
    // interval/rest), and per the documented rejectedSegments contract it
    // does NOT appear in rejectedSegments even though it's also unsuitable.
    const descentStep = result.steps.find((s) => s.startDist === 5500 && s.endDist === 6500);
    assert.equal(descentStep.kind, 'cruise');
    assert.ok(!result.rejectedSegments.some((r) => r.startDist === 5500));
  });

  await t.test('climb-stretch compression: a capacity between 0.5x and 1.8x an interval\'s nominal distance clamps it to fill the segment exactly', () => {
    // Climb segment capacity is exactly 1500m; the interval's uncompressed
    // fallback distance at 4% gradient (16km/h bucket) is 2133m -- within
    // [0.5x, 1.8x] of 1500m, so packPass() clamps it down to exactly fill
    // the segment instead of leaving a gap or spilling past it. Warmup/
    // cooldown lengths (450m each, 1min flat @ 27km/h) are chosen to land
    // exactly on the climb's own boundaries so no leftover cruise sliver
    // exists for extendCompressedIntervalsBackward() to borrow from --
    // isolating the compression itself from that separate backward-borrow
    // mechanism (index.html's own comment above that function).
    const route = {
      points: straightPts(4000, 20),
      totalDistanceM: 4000,
      segments: [routeSeg('flat', 0, 450, 0, false), routeSeg('climb', 450, 1950, 4, false), routeSeg('flat', 1950, 3550, 0, false)],
    };
    const spec = {
      warmup: { label: 'Einrollen', minutes: 1, pct: 0.55, note: null },
      activation: null,
      reps: [{ label: 'Intervall', minutes: 8, pct: 0.97, note: null, restAfter: [] }],
      cooldown: { label: 'Ausrollen', minutes: 1, pct: 0.5, note: null },
    };
    const result = placeIntervalsOnRoute(route, spec, 1, 'threshold', TRAINING_CONFIG, {}, rp);
    assert.equal(result.intervalCount, 1);
    assert.equal(result.placedIntervalMin, 8);
    const interval = result.steps.find((s) => s.kind === 'interval');
    assert.equal(interval.startDist, 450);
    assert.equal(interval.endDist, 1950);
    assert.equal(interval.distanceM, 1500); // clamped exactly to capacity, not the uncompressed 2133m
    assert.equal(interval.gradient, 4);
    // No leftover nominalDistM/baseLabel/counter bookkeeping should survive
    // into the final step once extendCompressedIntervalsBackward() has run.
    assert.equal(interval.nominalDistM, undefined);
  });

  await t.test('warmup+activation+cooldown reserving over 90% of total distance all get scaled down by the same factor', () => {
    // 10min warmup + 5min activation + 10min cooldown, all flat (27km/h),
    // reserve 4500+2250+4500=11250m on a route only 2000m long -- far over
    // the 90% cap, so every reserved leg is scaled down by the same factor
    // (0.9*2000 / 11250) rather than one leg starving the others.
    const route = { points: straightPts(2000, 20), totalDistanceM: 2000, segments: [routeSeg('flat', 0, 2000, 0, false)] };
    const spec = {
      warmup: { label: 'Einrollen', minutes: 10, pct: 0.55, note: null },
      activation: { label: 'Aktivierung', minutes: 5, pct: 0.8, note: null },
      reps: [],
      cooldown: { label: 'Ausrollen', minutes: 10, pct: 0.5, note: null },
    };
    const result = placeIntervalsOnRoute(route, spec, 1, null, TRAINING_CONFIG, {}, rp);
    const scale = (2000 * 0.9) / 11250;
    const warmupStep = result.steps.find((s) => s.kind === 'warmup');
    const activationStep = result.steps.find((s) => s.kind === 'activation');
    const cooldownStep = result.steps.find((s) => s.kind === 'cooldown');
    assert.ok(Math.abs(warmupStep.endDist - 4500 * scale) < 1e-6);
    assert.ok(Math.abs(activationStep.distanceM - 2250 * scale) < 1e-6);
    assert.ok(Math.abs(cooldownStep.distanceM - 4500 * scale) < 1e-6);
    // The three reserved legs must never together exceed 90% of the route.
    assert.ok(warmupStep.distanceM + activationStep.distanceM + cooldownStep.distanceM <= 2000 * 0.9 + 1e-6);
  });

  await t.test('classKey=null / config=null: no suitability gating at all, every segment is treated as plain acceptable/unsuitable by type alone', () => {
    // Same abundant-capacity route/spec as the first test, but with
    // classKey=null AND config=null -- placeIntervalsOnRoute()'s own
    // fallback tier logic (`s.type==='descent' || s.curvy ? 'unsuitable' :
    // 'acceptable'`) applies instead of evaluateSegmentForClass(), and the
    // interval-length clamp (clampInterval/clampRest, which needs `cc`) is
    // a no-op since `cc` is null. All 3 intervals should still place.
    const route = {
      points: straightPts(20000, 20),
      totalDistanceM: 20000,
      segments: [routeSeg('flat', 0, 2000, 0, false), routeSeg('climb', 2000, 15000, 4, false), routeSeg('flat', 15000, 20000, 0, false)],
    };
    const spec = {
      warmup: { label: 'Einrollen', minutes: 1, pct: 0.55, note: null },
      activation: null,
      reps: [
        { label: 'Intervall', minutes: 8, pct: 0.97, note: null, restAfter: [{ label: 'Pause', minutes: 3, pct: 0.5, note: null }] },
        { label: 'Intervall', minutes: 8, pct: 0.97, note: null, restAfter: [{ label: 'Pause', minutes: 3, pct: 0.5, note: null }] },
        { label: 'Intervall', minutes: 8, pct: 0.97, note: null, restAfter: [] },
      ],
      cooldown: { label: 'Ausrollen', minutes: 1, pct: 0.5, note: null },
    };
    const result = placeIntervalsOnRoute(route, spec, 1, null, null, {}, rp);
    assert.equal(result.intervalCount, 3);
    assert.equal(result.placedIntervalMin, 24);
  });
});
