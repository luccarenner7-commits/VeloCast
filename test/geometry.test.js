'use strict';
// Route-geometry primitives underlying nearly every downstream feature
// (segments, wind, weather sampling, arrival-time prediction, workout
// placement): decodePolyline, haversineKm, buildCumulativeDistances,
// estimateArrival, indexAtDistance. Flagged as high-value/low-effort in the
// 2026-09-03 test-coverage audit -- foundational, previously untested.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

// Objects/arrays returned from the vm-sandboxed app come from a DIFFERENT
// realm than this test file, so assert.deepEqual's strict prototype check
// treats them as "not equal" even when every element matches (a cross-realm
// gotcha, not a real bug -- see test/pure-functions.test.js for the same
// helper/explanation). Round-tripping through JSON strips the realm-specific
// prototype.
function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

// Independent reference implementation of Google's encoded polyline format,
// used only to build test fixtures -- deliberately NOT calling the app's own
// decodePolyline() so the fixture-construction math doesn't depend on the
// code under test.
function encodePolylineLocal(coords) {
  let out = '', prevLat = 0, prevLng = 0;
  const encodeValue = (v) => {
    let value = v < 0 ? ~(v << 1) : (v << 1);
    let s = '';
    while (value >= 0x20) {
      s += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    s += String.fromCharCode(value + 63);
    return s;
  };
  for (const [lat, lng] of coords) {
    const latE5 = Math.round(lat * 1e5), lngE5 = Math.round(lng * 1e5);
    out += encodeValue(latE5 - prevLat) + encodeValue(lngE5 - prevLng);
    prevLat = latE5; prevLng = lngE5;
  }
  return out;
}

test('decodePolyline', async (t) => {
  const { get } = loadApp();
  const decodePolyline = get('decodePolyline');

  await t.test('round-trips a multi-point route through an independent encoder', () => {
    const original = [[52.5200, 13.4050], [52.5300, 13.4100], [52.5100, 13.3900], [52.5000, 13.4200]];
    const encoded = encodePolylineLocal(original);
    const decoded = decodePolyline(encoded);
    assert.equal(decoded.length, original.length);
    decoded.forEach((p, i) => {
      assert.ok(Math.abs(p[0] - original[i][0]) < 1e-5, `lat[${i}] mismatch`);
      assert.ok(Math.abs(p[1] - original[i][1]) < 1e-5, `lng[${i}] mismatch`);
    });
  });

  await t.test('known reference vector: Google Maps API docs example', () => {
    // "_p~iF~ps|U_ulLnnqC_mqNvxq`@" decodes to
    // [[38.5,-120.2],[40.7,-120.95],[43.252,-126.453]] per Google's own
    // published example for this algorithm.
    const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    assert.deepEqual(plain(decoded), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  });

  await t.test('empty string -> empty array', () => {
    assert.deepEqual(plain(decodePolyline('')), []);
  });

  await t.test('single point round-trips correctly (no delta from a previous point)', () => {
    const decoded = decodePolyline(encodePolylineLocal([[10.12345, -20.54321]]));
    assert.equal(decoded.length, 1);
    assert.ok(Math.abs(decoded[0][0] - 10.12345) < 1e-5);
    assert.ok(Math.abs(decoded[0][1] - (-20.54321)) < 1e-5);
  });

  await t.test('handles negative deltas between consecutive points (route doubling back)', () => {
    const original = [[10, 10], [10.001, 10.001], [9.999, 9.998]];
    const decoded = decodePolyline(encodePolylineLocal(original));
    decoded.forEach((p, i) => {
      assert.ok(Math.abs(p[0] - original[i][0]) < 1e-5);
      assert.ok(Math.abs(p[1] - original[i][1]) < 1e-5);
    });
  });
});

test('haversineKm', async (t) => {
  const { get } = loadApp();
  const haversineKm = get('haversineKm');

  await t.test('same point -> 0', () => {
    assert.equal(haversineKm([52.5, 13.4], [52.5, 13.4]), 0);
  });

  await t.test('known reference: Berlin to Paris is roughly 878km great-circle', () => {
    const km = haversineKm([52.5200, 13.4050], [48.8566, 2.3522]);
    assert.ok(km > 870 && km < 890, `expected ~878km, got ${km}`);
  });

  await t.test('1 degree of latitude at the equator is ~111km', () => {
    const km = haversineKm([0, 0], [1, 0]);
    assert.ok(Math.abs(km - 111.19) < 0.5, `expected ~111.19km, got ${km}`);
  });

  await t.test('symmetric: distance(A,B) === distance(B,A)', () => {
    const a = [51.0, 7.0], b = [51.5, 7.8];
    assert.equal(haversineKm(a, b), haversineKm(b, a));
  });
});

test('buildCumulativeDistances', async (t) => {
  const { get } = loadApp();
  const buildCumulativeDistances = get('buildCumulativeDistances');
  const haversineKm = get('haversineKm');

  await t.test('starts at 0 and is monotonically non-decreasing', () => {
    const coords = [[52.5, 13.4], [52.51, 13.41], [52.49, 13.39], [52.52, 13.43]];
    const cum = buildCumulativeDistances(coords);
    assert.equal(cum[0], 0);
    assert.equal(cum.length, coords.length);
    for (let i = 1; i < cum.length; i++) assert.ok(cum[i] >= cum[i - 1]);
  });

  await t.test('matches summing haversineKm over each consecutive pair', () => {
    const coords = [[52.5, 13.4], [52.51, 13.41], [52.49, 13.39]];
    const cum = buildCumulativeDistances(coords);
    const expectedTotal = haversineKm(coords[0], coords[1]) + haversineKm(coords[1], coords[2]);
    assert.ok(Math.abs(cum[cum.length - 1] - expectedTotal) < 1e-9);
  });

  await t.test('single point -> [0]', () => {
    assert.deepEqual(plain(buildCumulativeDistances([[52.5, 13.4]])), [0]);
  });

  await t.test('empty array -> [0] (loop never runs, initial [0] survives)', () => {
    assert.deepEqual(plain(buildCumulativeDistances([])), [0]);
  });
});

test('estimateArrival', async (t) => {
  const { get } = loadApp();
  const estimateArrival = get('estimateArrival');

  await t.test('normal case: 50km at 25km/h -> 2 hours later', () => {
    const start = new Date('2026-01-01T10:00:00Z');
    const arrival = estimateArrival(start, 50, 25);
    assert.equal(arrival.getTime(), start.getTime() + 2 * 3600 * 1000);
  });

  await t.test('zero distance -> arrival equals start time', () => {
    const start = new Date('2026-01-01T10:00:00Z');
    assert.equal(estimateArrival(start, 0, 25).getTime(), start.getTime());
  });

  await t.test('avgSpeedKmh below the 1 km/h floor is clamped, not divided-by-near-zero', () => {
    // Math.max(1, avgSpeedKmh) guards against an absurd/zero speed producing
    // a runaway or infinite arrival time.
    const start = new Date('2026-01-01T10:00:00Z');
    const arrivalAtZero = estimateArrival(start, 10, 0);
    const arrivalAtOne = estimateArrival(start, 10, 1);
    assert.equal(arrivalAtZero.getTime(), arrivalAtOne.getTime());
    assert.equal(arrivalAtZero.getTime(), start.getTime() + 10 * 3600 * 1000);
  });

  await t.test('negative avgSpeedKmh is also clamped to the 1 km/h floor (not a negative-time result)', () => {
    const start = new Date('2026-01-01T10:00:00Z');
    const arrival = estimateArrival(start, 10, -5);
    assert.equal(arrival.getTime(), start.getTime() + 10 * 3600 * 1000);
  });
});

test('indexAtDistance', async (t) => {
  const { get } = loadApp();
  const indexAtDistance = get('indexAtDistance');
  const cumDist = [0, 1, 2, 3, 4, 5]; // 6 evenly-spaced km markers

  await t.test('forward direction walks until it reaches or would overshoot targetKm', () => {
    assert.equal(indexAtDistance(cumDist, 3.5, 0, 1), 4); // stops once cumDist[idx] >= 3.5
  });

  await t.test('backward direction walks until it reaches or would undershoot targetKm', () => {
    assert.equal(indexAtDistance(cumDist, 1.5, 5, -1), 1); // stops once cumDist[idx] <= 1.5
  });

  await t.test('forward direction clamps at the array end instead of running off it', () => {
    assert.equal(indexAtDistance(cumDist, 100, 2, 1), cumDist.length - 1);
  });

  await t.test('backward direction clamps at index 0 instead of going negative', () => {
    assert.equal(indexAtDistance(cumDist, -100, 3, -1), 0);
  });

  await t.test('fromIdx already past targetKm in the requested direction -> returns fromIdx unchanged', () => {
    assert.equal(indexAtDistance(cumDist, 1, 4, 1), 4);
    assert.equal(indexAtDistance(cumDist, 4, 1, -1), 1);
  });
});
