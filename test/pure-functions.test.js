'use strict';
// First automated test suite for VeloCast (index.html). Scope: the six
// pure, DOM/network-free calculation functions listed in the task brief.
// Broader coverage (render/state layer) is intentionally out of scope for
// this pass.
//
// Each test gets a FRESH app instance via loadApp() (see
// test/support/loadApp.js) so state mutations (e.g. buildPotentialChip()
// tests writing state.profilPage.riderProfile) can never leak between
// tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

// Local re-implementation of the haversine great-circle distance formula,
// used only to build synthetic route geometry for smoothedBearingAt() test
// fixtures below. Deliberately independent of the app's own haversineKm()
// (which isn't exposed / under test here) so the fixture-construction math
// doesn't accidentally depend on the code under test.
function haversineKmLocal(p1, p2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const phi1 = toRad(p1[0]), phi2 = toRad(p2[0]);
  const dphi = toRad(p2[0] - p1[0]);
  const dlambda = toRad(p2[1] - p1[1]);
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildCumDist(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKmLocal(coords[i - 1], coords[i]));
  return cum;
}

// Objects returned from the vm-sandboxed app come from a DIFFERENT realm
// than this test file, so they have a different Object.prototype than a
// plain `{...}` literal written here -- assert.deepEqual/deepStrictEqual
// treats that as "not equal" even when every field matches (a cross-realm
// gotcha, not a real bug). Round-tripping through JSON strips the
// realm-specific prototype so structural comparisons work as expected;
// safe here since every value being compared this way (numbers, strings,
// plain nested objects) survives a JSON round-trip unchanged.
function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

// ---------------------------------------------------------------------
// windRelative(routeBearing, windFromDeg)
// ---------------------------------------------------------------------
test('windRelative', async (t) => {
  const { get } = loadApp();
  const windRelative = get('windRelative');

  await t.test('pure tailwind (wind blowing the same way you travel) -> tail, diff 0', () => {
    // Traveling bearing 90 (east); wind FROM 270 (west) blows TOWARD east.
    assert.deepEqual(plain(windRelative(90, 270)), { type: 'tail', diff: 0 });
  });

  await t.test('pure headwind -> head, diff 180', () => {
    assert.deepEqual(plain(windRelative(90, 90)), { type: 'head', diff: 180 });
  });

  await t.test('diff = 55 degrees exactly -> tail (boundary is inclusive)', () => {
    const result = windRelative(0, 235); // windToward = (235+180)%360 = 55
    assert.equal(result.type, 'tail');
    assert.equal(result.diff, 55);
  });

  await t.test('diff = 56 degrees -> cross (just past the tail boundary)', () => {
    const result = windRelative(0, 236); // windToward = 56
    assert.equal(result.type, 'cross');
    assert.equal(result.diff, 56);
  });

  await t.test('diff = 125 degrees exactly -> head (boundary is inclusive)', () => {
    const result = windRelative(0, 305); // windToward = (305+180)%360 = 125
    assert.equal(result.type, 'head');
    assert.equal(result.diff, 125);
  });

  await t.test('diff = 124 degrees -> cross (just below the head boundary)', () => {
    const result = windRelative(0, 304); // windToward = 124
    assert.equal(result.type, 'cross');
    assert.equal(result.diff, 124);
  });

  await t.test('wrap-around: diff computed via the short way round the compass', () => {
    // routeBearing=10, windFromDeg=170 -> windToward=350 -> raw diff |10-350|=340 -> wraps to 20
    const result = windRelative(10, 170);
    assert.equal(result.type, 'tail');
    assert.equal(result.diff, 20);
  });
});

// ---------------------------------------------------------------------
// bearingBetween(p1, p2)
// ---------------------------------------------------------------------
test('bearingBetween', async (t) => {
  const { get } = loadApp();
  const bearingBetween = get('bearingBetween');

  await t.test('cardinal directions', () => {
    assert.equal(bearingBetween([0, 0], [1, 0]), 0);   // due north
    assert.equal(bearingBetween([0, 0], [0, 1]), 90);  // due east
    assert.equal(bearingBetween([0, 0], [-1, 0]), 180); // due south
    assert.equal(bearingBetween([0, 0], [0, -1]), 270); // due west
  });

  await t.test('known great-circle initial bearing (NYC -> London ~= 51.2 degrees)', () => {
    const bearing = bearingBetween([40.7128, -74.0060], [51.5074, -0.1278]);
    assert.ok(Math.abs(bearing - 51.21) < 0.05, `expected ~51.21, got ${bearing}`);
  });

  await t.test('always returns a value in [0, 360), and the direction is actually correct (not sign-flipped)', () => {
    // [10,10] -> [10,9.9999]: same latitude, longitude decreasing slightly ->
    // travel is due west, i.e. ~270 degrees. Hand-verified independently via
    // the same spherical-bearing formula as bearingBetween: atan2(y,x) with
    // y = sin(dLon)*cos(phi2), x = cos(phi1)*sin(phi2) - sin(phi1)*cos(phi2)*cos(dLon)
    // gives 270.00000868224515 for these coordinates. A loose range-only
    // check (>=0 && <360) would also pass for a sign-flipped/wrong bearing
    // like 90 -- exactly the class of bug (wind-bearing direction mixup)
    // this project has shipped before, so assert the actual value too.
    const bearing = bearingBetween([10, 10], [10, 9.9999]);
    assert.ok(Math.abs(bearing - 270) < 0.01, `expected ~270 (due west), got ${bearing}`);
    assert.ok(bearing >= 0 && bearing < 360);
  });
});

// ---------------------------------------------------------------------
// smoothedBearingAt(coords, cumDist, idx)
// ---------------------------------------------------------------------
test('smoothedBearingAt', async (t) => {
  const { get } = loadApp();
  const smoothedBearingAt = get('smoothedBearingAt');
  const bearingBetween = get('bearingBetween');

  await t.test('gentle corner: smooths across the turn instead of just the next vertex', () => {
    // Route heads due east for ~600m then turns to head due north for ~700m,
    // in ~100m steps. At the corner vertex, the raw next-vertex bearing is a
    // sharp 0 (north); the window-smoothed bearing should blend the
    // approach (east, 90) and departure (north, 0) legs into something in
    // between -- 45 degrees exactly, for this symmetric fixture.
    const stepDeg = 0.0009; // ~100m per step
    const coords = [];
    for (let i = 0; i <= 6; i++) coords.push([0, i * stepDeg]);           // idx 0..6, heading east
    for (let i = 1; i <= 7; i++) coords.push([i * stepDeg, 6 * stepDeg]); // idx 7..13, heading north
    const cornerIdx = 6;
    const cumDist = buildCumDist(coords);

    const rawAdjacent = bearingBetween(coords[cornerIdx], coords[cornerIdx + 1]);
    assert.equal(rawAdjacent, 0); // sanity check: naive adjacent-vertex bearing would just say "north"

    const smoothed = smoothedBearingAt(coords, cumDist, cornerIdx);
    assert.ok(Math.abs(smoothed - 45) < 0.01, `expected ~45, got ${smoothed}`);
  });

  await t.test('hairpin/U-turn guard: falls back to raw adjacent bearing instead of a bogus long chord', () => {
    // Route heads due north in ~50m steps, does a tight U-turn, then heads
    // back south along a track offset by ~3m of longitude (simulates real
    // GPS jitter on a turnaround: distinct points, near-identical position).
    // Without the guard, smoothedBearingAt would average the "before" point
    // (still on the outbound leg) and the "after" point (already on the
    // inbound leg) into a bogus near-90-degree (east) bearing, even though
    // the route is actually turning around (~180, south) at that point.
    const stepDeg = 0.00045; // ~50m per step
    const N = 12;
    const coords = [];
    for (let i = 0; i <= N; i++) coords.push([i * stepDeg, 0]);            // idx 0..N, heading north, apex at N
    for (let i = 1; i <= N; i++) coords.push([(N - i) * stepDeg, 0.00003]); // idx N+1..2N, heading back south
    const apexIdx = N;
    const cumDist = buildCumDist(coords);

    const beforeIdx = 8, afterIdx = 16; // window bounds around the apex (verified by hand for this fixture)
    const alongRouteKm = cumDist[afterIdx] - cumDist[beforeIdx];
    const straightKm = haversineKmLocal(coords[beforeIdx], coords[afterIdx]);
    assert.ok(straightKm < alongRouteKm * 0.5, 'fixture must actually trigger the hairpin guard');

    const unguardedBearing = bearingBetween(coords[beforeIdx], coords[afterIdx]);
    assert.ok(Math.abs(unguardedBearing - 90) < 0.01, 'sanity check: the naive before/after chord points ~east');

    const rawAdjacent = bearingBetween(coords[apexIdx], coords[apexIdx + 1]);
    const result = smoothedBearingAt(coords, cumDist, apexIdx);

    // The guard should have fired: result matches the raw-adjacent fallback,
    // not the bogus unguarded before/after chord.
    assert.ok(Math.abs(result - rawAdjacent) < 0.01, `expected fallback ~${rawAdjacent}, got ${result}`);
    assert.ok(Math.abs(result - unguardedBearing) > 30, 'guard should have avoided the bogus ~90 degree chord');
  });

  await t.test('very short route (2 points): degenerates to the single available adjacent bearing', () => {
    const coords = [[0, 0], [0, 0.001]]; // due east, ~111m
    const cumDist = buildCumDist(coords);
    const result = smoothedBearingAt(coords, cumDist, 0);
    assert.ok(Math.abs(result - 90) < 0.01, `expected ~90 (east), got ${result}`);
  });
});

// ---------------------------------------------------------------------
// estimatePowerCurveAt(durationSec, mmpCurve)
// ---------------------------------------------------------------------
test('estimatePowerCurveAt', async (t) => {
  const { get } = loadApp();
  const estimatePowerCurveAt = get('estimatePowerCurveAt');

  await t.test('null/undefined mmpCurve -> null', () => {
    assert.equal(estimatePowerCurveAt(60, null), null);
    assert.equal(estimatePowerCurveAt(60, undefined), null);
  });

  await t.test('fewer than 2 usable points -> null', () => {
    assert.equal(estimatePowerCurveAt(60, { 60: 300 }), null);
    assert.equal(estimatePowerCurveAt(60, {}), null);
  });

  await t.test('below range clamps to the shortest available duration (flat extrapolation)', () => {
    assert.equal(estimatePowerCurveAt(5, { 60: 300, 300: 200 }), 300);
  });

  await t.test('above range clamps to the longest available duration', () => {
    assert.equal(estimatePowerCurveAt(3600, { 60: 300, 300: 200 }), 200);
  });

  await t.test('exact match on a curve point returns that point unmodified', () => {
    const curve = { 60: 300, 300: 200 };
    assert.equal(estimatePowerCurveAt(60, curve), 300);
    assert.equal(estimatePowerCurveAt(300, curve), 200);
  });

  await t.test('log-log interpolation between two points matches hand-computed value', () => {
    const d0 = 60, p0 = 300, d1 = 300, p1 = 200, durationSec = 120;
    const t2 = (Math.log(durationSec) - Math.log(d0)) / (Math.log(d1) - Math.log(d0));
    const expected = Math.exp(Math.log(p0) + t2 * (Math.log(p1) - Math.log(p0)));
    const actual = estimatePowerCurveAt(durationSec, { [d0]: p0, [d1]: p1 });
    assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
    // Concretely: ~251.93W at 120s between 300W@60s and 200W@300s.
    assert.ok(Math.abs(actual - 251.9317) < 0.001);
  });

  await t.test('3-point curve: bracket-selection loop picks the correct surrounding pair, not just point 0/1', () => {
    // With only 2-point curves (as in the tests above), the bracket loop's
    // `for(let i=0;...)` body only ever runs its i=0 iteration -- it never
    // actually has to skip past a non-matching bracket to find the right
    // one. A 3-point curve queried in the SECOND segment (300s-600s, not
    // 60s-300s) exercises that skip. Hand-verified independently via the
    // same log-log interpolation formula: interpolating 400s between
    // 280W@300s and 250W@600s gives ~267.13494668701674W.
    const curve = { 60: 400, 300: 280, 600: 250 };
    const actual = estimatePowerCurveAt(400, curve);
    assert.ok(Math.abs(actual - 267.135) < 0.001, `expected ~267.135, got ${actual}`);
  });
});

// ---------------------------------------------------------------------
// buildPotentialChip(watts, durationSec)
// ---------------------------------------------------------------------
test('buildPotentialChip', async (t) => {
  await t.test('null watts or durationSec -> null', () => {
    const { get } = loadApp();
    const buildPotentialChip = get('buildPotentialChip');
    assert.equal(buildPotentialChip(null, 60), null);
    assert.equal(buildPotentialChip(300, null), null);
  });

  await t.test('no rider profile loaded yet -> null (state.profilPage.riderProfile is null)', () => {
    const { get } = loadApp();
    const buildPotentialChip = get('buildPotentialChip');
    const state = get('state');
    assert.equal(state.profilPage.riderProfile, null);
    assert.equal(buildPotentialChip(300, 60), null);
  });

  await t.test('rider profile present but MMP curve not interpolatable (single point) -> null', () => {
    const { get } = loadApp();
    const buildPotentialChip = get('buildPotentialChip');
    const state = get('state');
    state.profilPage.riderProfile = { mmpCurve: { 60: 300 } };
    assert.equal(buildPotentialChip(300, 60), null);
  });

  await t.test('style thresholds: >=95% tail, >=85% and <95% cross, <85% no style override', () => {
    const { get } = loadApp();
    const buildPotentialChip = get('buildPotentialChip');
    const state = get('state');
    state.profilPage.riderProfile = { mmpCurve: { 60: 300, 300: 200 } };
    // best@60s = 300 exactly (curve point, no interpolation needed)

    const at100 = buildPotentialChip(300, 60); // pct = 100
    assert.equal(at100.value, '100%');
    assert.equal(at100.label, 'Potential');
    assert.equal(at100.style, 'color:var(--tail); background:var(--tail-bg);');

    const at95 = buildPotentialChip(285, 60); // pct = 95, tail boundary inclusive
    assert.equal(at95.value, '95%');
    assert.equal(at95.style, 'color:var(--tail); background:var(--tail-bg);');

    const at94 = buildPotentialChip(282, 60); // pct = 94, just below tail boundary
    assert.equal(at94.value, '94%');
    assert.equal(at94.style, 'color:var(--cross); background:var(--cross-bg);');

    const at85 = buildPotentialChip(255, 60); // pct = 85, cross boundary inclusive
    assert.equal(at85.value, '85%');
    assert.equal(at85.style, 'color:var(--cross); background:var(--cross-bg);');

    const at84 = buildPotentialChip(253, 60); // pct = 84, just below cross boundary
    assert.equal(at84.value, '84%');
    assert.equal(at84.style, null);
  });

  await t.test('>100% is valid and NOT capped (an older PR can exceed a recent MMP window)', () => {
    const { get } = loadApp();
    const buildPotentialChip = get('buildPotentialChip');
    const state = get('state');
    state.profilPage.riderProfile = { mmpCurve: { 60: 300, 300: 200 } };
    const result = buildPotentialChip(450, 60); // pct = 150
    assert.equal(result.value, '150%');
    assert.equal(result.style, 'color:var(--tail); background:var(--tail-bg);');
  });

  await t.test('fresh loadApp() instances do not leak state.profilPage.riderProfile between tests', () => {
    const { get } = loadApp();
    const state = get('state');
    assert.equal(state.profilPage.riderProfile, null);
  });
});

// ---------------------------------------------------------------------
// segmentPotentialValue(seg, bucket) / sortSegmentsBy(list, bucket, "potential")
// (Task 1: "Meine Segmente" Potential sort)
// ---------------------------------------------------------------------
test('segmentPotentialValue', async (t) => {
  await t.test('starred bucket (efforts == null): no detail for this segment -> null', () => {
    const { get } = loadApp();
    const segmentPotentialValue = get('segmentPotentialValue');
    const bucket = { efforts: null, details: {}, prWatts: { 1: { watts: 300 } } };
    assert.equal(segmentPotentialValue({ id: 1 }, bucket), null);
  });

  await t.test('starred bucket: no prWatts entry for this segment -> null', () => {
    const { get } = loadApp();
    const segmentPotentialValue = get('segmentPotentialValue');
    const bucket = { efforts: null, details: { 1: { athlete_segment_stats: { pr_elapsed_time: 60 } } }, prWatts: {} };
    assert.equal(segmentPotentialValue({ id: 1 }, bucket), null);
  });

  await t.test('starred bucket: detail present but pr_elapsed_time missing -> null', () => {
    const { get } = loadApp();
    const segmentPotentialValue = get('segmentPotentialValue');
    const bucket = { efforts: null, details: { 1: { athlete_segment_stats: {} } }, prWatts: { 1: { watts: 300 } } };
    assert.equal(segmentPotentialValue({ id: 1 }, bucket), null);
  });

  await t.test('starred bucket: no rider profile loaded yet -> null (matches buildPotentialChip\'s own convention)', () => {
    const { get } = loadApp();
    const segmentPotentialValue = get('segmentPotentialValue');
    const bucket = { efforts: null, details: { 1: { athlete_segment_stats: { pr_elapsed_time: 60 } } }, prWatts: { 1: { watts: 300 } } };
    assert.equal(segmentPotentialValue({ id: 1 }, bucket), null);
  });

  await t.test('starred bucket: full data -> same numeric % as buildPotentialChip(watts, pr) would show', () => {
    const { get } = loadApp();
    const segmentPotentialValue = get('segmentPotentialValue');
    const buildPotentialChip = get('buildPotentialChip');
    const state = get('state');
    state.profilPage.riderProfile = { mmpCurve: { 60: 300, 300: 200 } };
    const bucket = { efforts: null, details: { 1: { athlete_segment_stats: { pr_elapsed_time: 60 } } }, prWatts: { 1: { watts: 285 } } };
    assert.equal(segmentPotentialValue({ id: 1 }, bucket), 95);
    assert.equal(buildPotentialChip(285, 60).value, '95%');
  });

  await t.test('ride-completed bucket (efforts set): uses this ride\'s own effort duration, not a PR', () => {
    const { get } = loadApp();
    const segmentPotentialValue = get('segmentPotentialValue');
    const state = get('state');
    state.profilPage.riderProfile = { mmpCurve: { 60: 300, 300: 200 } };
    const bucket = { efforts: { 1: { elapsed_time: 60 } }, details: {}, prWatts: { 1: { watts: 300 } } };
    assert.equal(segmentPotentialValue({ id: 1 }, bucket), 100);
  });

  await t.test('ride-completed bucket: no effort recorded for this segment -> null', () => {
    const { get } = loadApp();
    const segmentPotentialValue = get('segmentPotentialValue');
    const bucket = { efforts: {}, details: {}, prWatts: { 1: { watts: 300 } } };
    assert.equal(segmentPotentialValue({ id: 1 }, bucket), null);
  });
});

test('sortSegmentsBy "potential" case', async (t) => {
  await t.test('descending by potential %, no-data segments sink to the end regardless of how low a real value is', () => {
    const { get } = loadApp();
    const sortSegmentsBy = get('sortSegmentsBy');
    const state = get('state');
    // Needs >=2 points for estimatePowerCurveAt()'s interpolation to return
    // anything at all (a single-point curve returns null, same as the
    // 'rider profile present but MMP curve not interpolatable' case in
    // buildPotentialChip's own tests above) -- both points equal so
    // best@60s resolves to exactly 1000 regardless of interpolation.
    state.profilPage.riderProfile = { mmpCurve: { 60: 1000, 300: 1000 } };
    const bucket = {
      efforts: null,
      details: {
        low: { athlete_segment_stats: { pr_elapsed_time: 60 } },
        high: { athlete_segment_stats: { pr_elapsed_time: 60 } },
        // 'noData' segment deliberately has no detail entry at all.
      },
      prWatts: { low: { watts: 100 }, high: { watts: 900 } }, // 10% vs 90%
    };
    const list = [{ id: 'noData' }, { id: 'low' }, { id: 'high' }];
    const sorted = sortSegmentsBy(list, bucket, 'potential').map(s => s.id);
    assert.deepEqual(sorted, ['high', 'low', 'noData']);
  });

  await t.test('a genuine 0% potential is a real, valid, low value -- it sorts BEFORE (ahead of) a no-data segment, not after', () => {
    const { get } = loadApp();
    const sortSegmentsBy = get('sortSegmentsBy');
    const state = get('state');
    state.profilPage.riderProfile = { mmpCurve: { 60: 1000, 300: 1000 } };
    const bucket = {
      efforts: null,
      details: {
        zero: { athlete_segment_stats: { pr_elapsed_time: 60 } },
        // 'noData' segment deliberately has no detail entry at all.
      },
      prWatts: { zero: { watts: 0 } }, // 0% -- computed, not missing
    };
    const list = [{ id: 'noData' }, { id: 'zero' }];
    const sorted = sortSegmentsBy(list, bucket, 'potential').map(s => s.id);
    assert.deepEqual(sorted, ['zero', 'noData']);
  });
});

// ---------------------------------------------------------------------
// syncSegmentSortXomOptions() / syncXomSortOptions() (Task 1: both sort
// dropdowns' kom/qom sync, generalized via syncXomSortOptionsFor())
// ---------------------------------------------------------------------
test('syncSegmentSortXomOptions() and syncXomSortOptions() independence', async (t) => {
  await t.test('turning off showKomChip and calling only segmentSortSelect\'s own sync ("Meine Segmente") falls back state.segmentSortBy, but leaves state.routeSegmentSortBy ("Abgeschlossene Segmente"\'s own field) completely untouched', () => {
    const { get } = loadApp();
    const syncSegmentSortXomOptions = get('syncSegmentSortXomOptions');
    const state = get('state');
    state.showKomChip = false;
    state.segmentSortBy = 'kom';
    state.routeSegmentSortBy = 'kom';
    syncSegmentSortXomOptions();
    assert.equal(state.segmentSortBy, 'default');
    assert.equal(state.routeSegmentSortBy, 'kom');
  });
});

// ---------------------------------------------------------------------
// computeFtpAnalysis(results)
// ---------------------------------------------------------------------
test('computeFtpAnalysis', async (t) => {
  await t.test('empty array -> null', () => {
    const { get } = loadApp();
    const computeFtpAnalysis = get('computeFtpAnalysis');
    assert.equal(computeFtpAnalysis([]), null);
  });

  await t.test('single result: ceiling series has one point, no regression (n < 2)', () => {
    const { get } = loadApp();
    const computeFtpAnalysis = get('computeFtpAnalysis');
    const d0 = new Date('2026-01-01T00:00:00Z');
    const out = computeFtpAnalysis([{ date: d0, estFtp: 250, confidence: 'hoch' }]);
    assert.deepEqual(plain(out.ceilingSeries), [{ x: 0, y: 250, w: 1 }]);
    assert.equal(out.reg, null);
    assert.equal(out.weeklySlope, null);
    assert.equal(out.forecast4, null);
    assert.equal(out.forecast8, null);
    assert.equal(out.forecast12, null);
    assert.equal(out.modelToday, null);
    assert.equal(out.currentCeiling, 250);
  });

  await t.test("'unbestätigt' rows are filtered out of the ceiling/regression entirely", () => {
    const { get } = loadApp();
    const computeFtpAnalysis = get('computeFtpAnalysis');
    const day = 86400000;
    const d0 = new Date('2026-01-01T00:00:00Z');
    const r1 = { date: new Date(d0.getTime() + 0 * day), estFtp: 200, confidence: 'hoch' };
    const r2 = { date: new Date(d0.getTime() + 7 * day), estFtp: 210, confidence: 'hoch' };
    const r3 = { date: new Date(d0.getTime() + 14 * day), estFtp: 220, confidence: 'hoch' };
    // Deliberately implausible value + placed between real rows: if this
    // leaked into the ceiling series it would dominate every ceiling point
    // from here on (999 >> 220).
    const rBad = { date: new Date(d0.getTime() + 10 * day), estFtp: 999, confidence: 'unbestätigt' };

    const out = computeFtpAnalysis([r1, rBad, r2, r3]);

    assert.deepEqual(plain(out.ceilingSeries), [
      { x: 0, y: 200, w: 1 },
      { x: 7, y: 210, w: 1 },
      { x: 14, y: 220, w: 1 },
    ]);
    assert.equal(out.currentCeiling, 220);

    // Exactly-linear fixture (200 -> 220 over 14 days) gives an exact
    // regression: slope = 20/14 W/day, intercept = 200 at x=0.
    assert.ok(Math.abs(out.reg.slope - 20 / 14) < 1e-9);
    assert.ok(Math.abs(out.reg.intercept - 200) < 1e-9);
    assert.equal(out.weeklySlope, 10); // slope*7 = (20/14)*7 = 10 exactly

    // Forecasts depend on wall-clock "today" (daysSinceFirst). Recompute
    // daysSinceFirst INDEPENDENTLY from Date.now() and the fixture's own
    // first date (not from out.reg/out.daysSinceFirst) -- reusing the
    // function's own returned daysSinceFirst here would make a bug in how
    // daysSinceFirst itself is computed invisible (the test would just
    // consistently agree with whatever the function claims). A small
    // tolerance absorbs the few ms of real time that pass during the test
    // run itself.
    const independentDaysSinceFirst = (Date.now() - d0.getTime()) / 86400000;
    assert.ok(Math.abs(out.daysSinceFirst - independentDaysSinceFirst) < 0.01,
      `expected daysSinceFirst ~${independentDaysSinceFirst}, got ${out.daysSinceFirst}`);

    const expectedModelToday = Math.round(out.reg.slope * independentDaysSinceFirst + out.reg.intercept);
    const expectedForecast4 = Math.round(out.reg.slope * (independentDaysSinceFirst + 28) + out.reg.intercept);
    const expectedForecast8 = Math.round(out.reg.slope * (independentDaysSinceFirst + 56) + out.reg.intercept);
    const expectedForecast12 = Math.round(out.reg.slope * (independentDaysSinceFirst + 84) + out.reg.intercept);
    assert.equal(out.modelToday, expectedModelToday);
    assert.equal(out.forecast4, expectedForecast4);
    assert.equal(out.forecast8, expectedForecast8);
    assert.equal(out.forecast12, expectedForecast12);
    // Sanity bound: daysSinceFirst must be positive and in a plausible range
    // for a fixture dated 2026-01-01 (not, say, negative or zero).
    assert.ok(out.daysSinceFirst > 14, 'today must be after the fixture dates');
  });

  await t.test('rolling ceiling holds at an earlier peak when a later point is lower (does not just track the latest value)', () => {
    // Rider peaks at 250W on day 0, then their computed estFtp DROPS to 200W
    // by day 7 -- still well within CEILING_WINDOW_DAYS (365), so the day-0
    // peak must still count toward day 7's ceiling. This is the case the
    // existing suite's strictly-increasing fixture (200->210->220) never
    // exercised: with monotonically increasing input, maxY always trivially
    // equals the current point's own y, so the backward max-loop was
    // effectively dead code from the test's point of view.
    // Hand-verified (matches index.html's ceilingSeries construction
    // exactly, computed independently via a throwaway node -e script):
    //   idx0: x=0,  start=-365, window={x:0,y:250}          -> maxY=250
    //   idx1: x=7,  start=-358, window={x:0,y:250},{x:7,y:200} -> maxY=250
    const { get } = loadApp();
    const computeFtpAnalysis = get('computeFtpAnalysis');
    const day = 86400000;
    const d0 = new Date('2026-01-01T00:00:00Z');
    const r1 = { date: new Date(d0.getTime() + 0 * day), estFtp: 250, confidence: 'hoch' };
    const r2 = { date: new Date(d0.getTime() + 7 * day), estFtp: 200, confidence: 'hoch' };

    const out = computeFtpAnalysis([r1, r2]);

    assert.deepEqual(plain(out.ceilingSeries), [
      { x: 0, y: 250, w: 1 },
      { x: 7, y: 250, w: 1 },
    ]);
    assert.equal(out.currentCeiling, 250, 'ceiling should hold at the earlier 250W peak, not drop to 200');
  });

  await t.test('rolling ceiling window expiry: an old peak older than CEILING_WINDOW_DAYS no longer counts', () => {
    // Old peak of 300W on day 0, followed by a lower point (220W) on day 400
    // -- more than CEILING_WINDOW_DAYS (365) later, so day 0 has aged out of
    // day 400's own [400-365, 400] = [35, 400] window. Day 400's ceiling
    // must reflect only itself (220), not the stale day-0 peak (300).
    // Hand-verified independently (matches index.html's construction):
    //   idx0: x=0,   start=-365, window={x:0,y:300}                -> maxY=300
    //   idx1: x=400, start=35,   plausible[0].x=0 < 35 -> excluded -> maxY=220
    const { get } = loadApp();
    const computeFtpAnalysis = get('computeFtpAnalysis');
    const day = 86400000;
    const d0 = new Date('2026-01-01T00:00:00Z');
    const r1 = { date: new Date(d0.getTime() + 0 * day), estFtp: 300, confidence: 'hoch' };
    const r2 = { date: new Date(d0.getTime() + 400 * day), estFtp: 220, confidence: 'hoch' };

    const out = computeFtpAnalysis([r1, r2]);

    assert.deepEqual(plain(out.ceilingSeries), [
      { x: 0, y: 300, w: 1 },
      { x: 400, y: 220, w: 1 },
    ]);
    assert.equal(out.currentCeiling, 220, 'the day-0 peak must have aged out of the day-400 point\'s window');
  });

  await t.test('all-unbestätigt input: non-null result, but no ceiling data at all', () => {
    const { get } = loadApp();
    const computeFtpAnalysis = get('computeFtpAnalysis');
    const d0 = new Date('2026-01-01T00:00:00Z');
    const out = computeFtpAnalysis([{ date: d0, estFtp: 250, confidence: 'unbestätigt' }]);
    assert.deepEqual(plain(out.ceilingSeries), []);
    assert.equal(out.reg, null);
    assert.equal(out.currentCeiling, null);
  });
});

// ---------------------------------------------------------------------
// rideZoneBreakdown(zoneTimes) / computeStreamMetrics(...) zoneTimes wiring
// (Task 2: "Zeit je Zone" in the Aktivitäten single-activity detail view)
// ---------------------------------------------------------------------
test('rideZoneBreakdown', async (t) => {
  await t.test('all-zero input -> totalMin 0, every zone pct 0 (not NaN from a 0/0 division)', () => {
    const { get } = loadApp();
    const rideZoneBreakdown = get('rideZoneBreakdown');
    const zoneTimes = new Array(7).fill(0);
    const out = rideZoneBreakdown(zoneTimes);
    assert.equal(out.totalMin, 0);
    assert.equal(out.zones.length, 7);
    out.zones.forEach(z => assert.equal(z.pct, 0));
  });

  await t.test('converts seconds -> minutes and each zone\'s share of total time as a percentage', () => {
    const { get } = loadApp();
    const rideZoneBreakdown = get('rideZoneBreakdown');
    const POWER_ZONE_META = get('POWER_ZONE_META');
    // 600s in zone 0 (10 min), 1800s in zone 3 (30 min), 0 elsewhere -- total 2400s (40 min).
    const zoneTimes = new Array(7).fill(0);
    zoneTimes[0] = 600;
    zoneTimes[3] = 1800;
    const out = rideZoneBreakdown(zoneTimes);
    assert.equal(out.totalMin, 40);
    assert.equal(out.zones[0].minutes, 10);
    assert.equal(out.zones[0].pct, 25); // 600/2400
    assert.equal(out.zones[3].minutes, 30);
    assert.equal(out.zones[3].pct, 75); // 1800/2400
    assert.equal(out.zones[1].minutes, 0);
    assert.equal(out.zones[1].pct, 0);
    // name/color carried straight from POWER_ZONE_META, same as
    // actualWeekZoneBreakdown()'s equivalent mapping.
    assert.equal(out.zones[0].name, plain(POWER_ZONE_META)[0].name);
    assert.equal(out.zones[0].color, plain(POWER_ZONE_META)[0].color);
  });
});

test('computeStreamMetrics zoneTimes (Task 2 wiring: null powerZones -> all-zero, real zones -> populated)', async (t) => {
  await t.test('powerZones == null -> zoneTimes is all-zero (the pre-fix Aktivitäten-detail behavior)', () => {
    const { get } = loadApp();
    const computeStreamMetrics = get('computeStreamMetrics');
    const stream = { time: [0, 1, 2, 3, 4], watts: [100, 200, 300, 400, 500] };
    const metrics = computeStreamMetrics(stream, null, 70);
    assert.deepEqual(plain(metrics.zoneTimes), [0, 0, 0, 0, 0, 0, 0]);
  });

  await t.test('real zone boundaries -> zoneTimes reflects actual time-in-zone (the post-fix behavior)', () => {
    const { get } = loadApp();
    const computeStreamMetrics = get('computeStreamMetrics');
    const stream = { time: [0, 1, 2, 3, 4], watts: [50, 50, 300, 300, 300] };
    // Two zones: [0,100] and [100,null] (open-ended top zone) -- same
    // powerZonesNorm shape processProfilRide() builds (z.max===-1 -> null).
    const powerZones = [{ max: 100 }, { max: null }];
    const metrics = computeStreamMetrics(stream, powerZones, 70);
    // dt = 1s here; 2 samples at 50W fall in zone 0, 3 samples at 300W in zone 1.
    assert.equal(metrics.zoneTimes[0], 2);
    assert.equal(metrics.zoneTimes[1], 3);
    assert.equal(metrics.zoneTimes.slice(2).every(t => t === 0), true);
  });
});

// ---------------------------------------------------------------------
// loadApp() safety: loading the app and running its trailing init() call
// must perform ZERO real network I/O. This is the suite's core safety
// invariant (it's what makes it safe to run this suite at all, repeatedly,
// offline, in CI) -- it was previously only checked manually/informally.
// The loader's fresh-localStorage-per-context stub means init() has no
// stored refresh token, so it must take the early-exit path in index.html's
// init() (search `if(!justConnected)` -> `const stored = await
// loadStoredToken()` -> `if(stored){...}` -- the else branch does nothing
// further and never calls fetch()).
// ---------------------------------------------------------------------
test('loadApp() safety', async (t) => {
  await t.test('init() with no stored token performs zero fetch() calls and never enters the connect-loading state', async () => {
    let fetchCalls = 0;
    const { get } = loadApp({ onFetchCall: () => { fetchCalls++; } });

    // index.html's top-level `init()` call is fired-and-forgotten (not
    // awaited) by the script itself, so it's still mid-flight right when
    // loadApp() returns. Its no-token path only awaits two trivial
    // localStorage-backed async functions (loadStoredHammerheadToken(),
    // loadStoredToken() -- see index.html) with no real timers/I/O
    // involved, so a couple of macrotask turns is more than enough to let
    // that promise chain fully settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(fetchCalls, 0, 'init() must not perform any real network I/O when there is no stored token');
    const state = get('state');
    assert.ok(!state.loading.connect, 'state.loading.connect must stay falsy, confirming init() took the no-token early-exit path');
  });
});
