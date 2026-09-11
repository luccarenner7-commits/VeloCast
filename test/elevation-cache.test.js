'use strict';
// Tests for slimElevationProfile(distances, elevations) -- the downsampling/
// rounding step ensureElevationProfile() runs on a stream BEFORE persisting
// it into ACTIVITY_ELEVATION_CACHE_KEY (never on the just-fetched
// state.elevationProfile used for the current render, only on the copy that
// gets written to localStorage). Added as part of the 11.09.2026 Vollaudit
// Nachschärfung: a multi-hour ride's raw 1Hz stream could produce a
// ~230KB cache entry, and ACTIVITY_ELEVATION_CACHE_MAX (100) of those risked
// exhausting the shared per-origin localStorage quota -- which cascades into
// every OTHER localStorage write on the origin failing too, not just this
// cache. See index.html's slimElevationProfile() comment for the full
// reasoning.
//
// loadActivityElevationCache()/saveActivityElevationCache()/
// ensureElevationProfile() themselves are storage/fetch orchestration, not
// covered here -- same established convention as the rest of this project's
// cache read/write pairs (e.g. segmentStatsChanged() vs. loadSegmentExtras()).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

test('slimElevationProfile', async (t) => {
  await t.test('fewer points than the cap -> all kept, just rounded (3 decimals distance, 1 decimal elevation)', () => {
    const { get } = loadApp();
    const slimElevationProfile = get('slimElevationProfile');
    const distances = [0, 1.234567, 2.9999999];
    const elevations = [100, 105.789, 98.01];
    const result = slimElevationProfile(distances, elevations);
    assert.deepEqual(plain(result.distances), [0, 1.235, 3]);
    assert.deepEqual(plain(result.elevations), [100, 105.8, 98]);
  });

  await t.test('more points than the cap -> downsampled by stride, last point always kept', () => {
    const { get } = loadApp();
    const slimElevationProfile = get('slimElevationProfile');
    // 2500 points, well above the 1000-point cap -- stride should be ceil(2500/1000) = 3.
    const distances = Array.from({ length: 2500 }, (_, i) => i / 1000);
    const elevations = Array.from({ length: 2500 }, (_, i) => i);
    const result = slimElevationProfile(distances, elevations);
    assert.ok(result.distances.length <= 1000 + 1, 'stays close to the cap (plus at most one extra point for the forced-last-point rule)');
    assert.ok(result.distances.length < distances.length, 'is genuinely smaller than the input');
    // First point is always the real first point (stride starts at index 0).
    assert.equal(result.distances[0], 0);
    assert.equal(result.elevations[0], 0);
    // Last point is always the real last point, even though the stride
    // wouldn't naturally land exactly on index 2499.
    assert.equal(result.distances[result.distances.length - 1], distances[2499]);
    assert.equal(result.elevations[result.elevations.length - 1], 2499);
  });

  await t.test('exactly at the cap -> every point kept (no downsampling needed), still rounded', () => {
    const { get } = loadApp();
    const slimElevationProfile = get('slimElevationProfile');
    const distances = Array.from({ length: 1000 }, (_, i) => i / 1000);
    const elevations = Array.from({ length: 1000 }, (_, i) => i);
    const result = slimElevationProfile(distances, elevations);
    assert.equal(result.distances.length, 1000);
    assert.equal(result.elevations.length, 1000);
  });

  await t.test('null elevation values survive downsampling as null, never coerced to 0 or dropped', () => {
    const { get } = loadApp();
    const slimElevationProfile = get('slimElevationProfile');
    const distances = [0, 1, 2];
    const elevations = [100, null, 105];
    const result = slimElevationProfile(distances, elevations);
    assert.deepEqual(plain(result.elevations), [100, null, 105]);
  });

  await t.test('empty input -> empty output, no crash', () => {
    const { get } = loadApp();
    const slimElevationProfile = get('slimElevationProfile');
    const result = slimElevationProfile([], []);
    assert.deepEqual(plain(result.distances), []);
    assert.deepEqual(plain(result.elevations), []);
  });

  await t.test('a realistic long ride (18000 points, ~5h at 1Hz) shrinks to well under the 1000-point cap', () => {
    const { get } = loadApp();
    const slimElevationProfile = get('slimElevationProfile');
    const distances = Array.from({ length: 18000 }, (_, i) => i * 0.01); // ~180km
    const elevations = Array.from({ length: 18000 }, (_, i) => 500 + Math.sin(i / 500) * 200);
    const result = slimElevationProfile(distances, elevations);
    assert.ok(result.distances.length <= 1000 + 1);
    // Rough size sanity check: the whole point of this function is keeping
    // a cached entry small -- confirm the JSON size actually dropped a lot,
    // not just the point count (rounding also matters for real byte size).
    const rawSize = JSON.stringify({ distances, elevations }).length;
    const slimSize = JSON.stringify(result).length;
    assert.ok(slimSize < rawSize / 10, `expected at least a 10x size reduction, got raw=${rawSize} slim=${slimSize}`);
  });
});
