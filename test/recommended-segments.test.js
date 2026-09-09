'use strict';
// "Heute empfohlen" block (index.html, "'Heute empfohlen' segments block
// (Meine Segmente)" section): up to 5 wind-favorable STARRED FAVORITES
// (state.segments only -- never any other segment source), ranked by wind
// favorability for state.startTime. Only one new pure/testable function
// behind it:
//   - pickTopSegments(scoredCandidates, max=5): sorts already wind-scored
//     candidates (each needing at least `windScore`) descending by
//     windScore and slices the top `max`. Deliberately simpler than the
//     route page's pickRecommendedRoutes() -- no distance-bucket grouping,
//     no per-bucket minimum -- since the user asked for "3 to 5" as a rough
//     headline count, not a fixed rule: fewer candidates than `max` just
//     means fewer tiles, never padded.
//
// scoreRouteWindForStartTime() itself is already fully covered in
// test/recommended-routes.test.js and is NOT duplicated here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

test('pickTopSegments', async (t) => {
  const { get } = loadApp();
  const pickTopSegments = get('pickTopSegments');

  await t.test('more candidates than max -> exactly the top `max` by windScore, descending', () => {
    const candidates = [
      { id: 'a', windScore: 10 },
      { id: 'b', windScore: 90 },
      { id: 'c', windScore: 50 },
      { id: 'd', windScore: -20 },
      { id: 'e', windScore: 30 },
      { id: 'f', windScore: 70 },
    ];
    const out = pickTopSegments(candidates, 3);
    assert.deepEqual(plain(out.map(c => c.id)), ['b', 'f', 'c']);
  });

  await t.test('fewer candidates than max -> all of them are returned, no padding', () => {
    const candidates = [
      { id: 'x', windScore: 5 },
      { id: 'y', windScore: 40 },
    ];
    const out = pickTopSegments(candidates, 5);
    assert.equal(out.length, 2);
    assert.deepEqual(plain(out.map(c => c.id)), ['y', 'x']);
  });

  await t.test('empty array -> empty array, not a crash', () => {
    assert.deepEqual(plain(pickTopSegments([], 5)), []);
  });

  await t.test('max omitted -> defaults to 5', () => {
    const candidates = [
      { id: '1', windScore: 1 },
      { id: '2', windScore: 2 },
      { id: '3', windScore: 3 },
      { id: '4', windScore: 4 },
      { id: '5', windScore: 5 },
      { id: '6', windScore: 6 },
    ];
    const out = pickTopSegments(candidates);
    assert.equal(out.length, 5);
    assert.deepEqual(plain(out.map(c => c.id)), ['6', '5', '4', '3', '2']);
  });

  // Node's Array#sort has been spec-guaranteed stable since ES2019 (and V8
  // has implemented it that way for years before that too), so candidates
  // tied on windScore keep their original relative order rather than being
  // reshuffled. This documents that actual, observed behavior -- it isn't a
  // requirement the feature depends on, just what happens today.
  await t.test('equal windScores keep their original relative order (stable sort)', () => {
    const candidates = [
      { id: 'first', windScore: 10 },
      { id: 'second', windScore: 10 },
      { id: 'third', windScore: 10 },
    ];
    const out = pickTopSegments(candidates, 5);
    assert.deepEqual(plain(out.map(c => c.id)), ['first', 'second', 'third']);
  });

  await t.test('other fields on a candidate pass through untouched (name/raw/distanceKm)', () => {
    const candidates = [
      { id: 'x', windScore: 5, name: 'Bergprämie', distanceKm: 3.2, raw: { foo: 'bar' } },
    ];
    const out = pickTopSegments(candidates, 5);
    assert.equal(out[0].name, 'Bergprämie');
    assert.equal(out[0].distanceKm, 3.2);
    assert.deepEqual(plain(out[0].raw), { foo: 'bar' });
  });

  await t.test('input array is not mutated in place (defensive copy before sort)', () => {
    const candidates = [
      { id: 'a', windScore: 1 },
      { id: 'b', windScore: 9 },
    ];
    const original = candidates.map(c => c.id);
    pickTopSegments(candidates, 5);
    assert.deepEqual(candidates.map(c => c.id), original);
  });
});

// buildRecommendedSegmentCandidatePool(): not a pure function (reads
// state.segments and segmentBucket("starred").details directly), so tests
// here go through get('state') to set up fixtures, same convention as
// test/recommended-routes.test.js's buildRecommendedCandidatePool() block.
// A function declaration in index.html, so it's reachable via loadApp()'s
// get() ctx[name] fallback without any __exposed change (same as
// buildRecommendedCandidatePool() itself).
test('buildRecommendedSegmentCandidatePool', async (t) => {
  function sampleSegment(id, overrides) {
    return Object.assign({
      id, name: 'Segment ' + id, distance: 5000, average_grade: 4.2,
    }, overrides);
  }

  await t.test('only state.segments feeds the pool -- no other segment source is consulted', () => {
    const { get } = loadApp();
    const state = get('state');
    state.segments = [sampleSegment('a')];
    // A segment sitting in some other bucket (route-explore segments) must
    // never leak into this pool -- buildRecommendedSegmentCandidatePool()'s
    // own comment is explicit that state.segments is the ONLY source.
    state.routeSegments = [sampleSegment('b')];
    state.segmentDetails = { a: { map: { polyline: 'poly-a' } } };
    state.routeSegmentDetails = { b: { map: { polyline: 'poly-b' } } };
    const pool = get('buildRecommendedSegmentCandidatePool')();
    assert.deepEqual(plain(pool.map(c => c.raw.id)), ['a']);
  });

  await t.test('a favorite whose geometry has not loaded yet is skipped, not a crash', () => {
    const { get } = loadApp();
    const state = get('state');
    state.segments = [sampleSegment('loaded'), sampleSegment('pending'), sampleSegment('emptyMap')];
    state.segmentDetails = {
      loaded: { map: { polyline: 'poly-loaded' } },
      // 'pending': no entry at all in segmentDetails.
      emptyMap: { map: {} }, // detail loaded, but no polyline/summary_polyline yet.
    };
    const pool = get('buildRecommendedSegmentCandidatePool')();
    assert.deepEqual(plain(pool.map(c => c.raw.id)), ['loaded']);
  });

  await t.test('falls back to summary_polyline when the full polyline is absent', () => {
    const { get } = loadApp();
    const state = get('state');
    state.segments = [sampleSegment('s')];
    state.segmentDetails = { s: { map: { summary_polyline: 'summary-poly' } } };
    const pool = get('buildRecommendedSegmentCandidatePool')();
    assert.equal(pool[0].polyline, 'summary-poly');
  });

  await t.test('mapped fields match the source segment (distanceKm/averageGrade/name/raw)', () => {
    const { get } = loadApp();
    const state = get('state');
    const seg = sampleSegment('s', { name: 'Bergprämie', distance: 8400, average_grade: 6.7 });
    state.segments = [seg];
    state.segmentDetails = { s: { map: { polyline: 'poly' } } };
    const pool = get('buildRecommendedSegmentCandidatePool')();
    assert.equal(pool.length, 1);
    assert.equal(pool[0].name, 'Bergprämie');
    assert.equal(pool[0].distanceKm, 8.4); // distance (m) / 1000
    assert.equal(pool[0].averageGrade, 6.7);
    assert.deepEqual(plain(pool[0].raw), plain(seg));
  });

  await t.test('no favorites at all -> empty pool, not a crash', () => {
    const { get } = loadApp();
    const state = get('state');
    state.segments = [];
    const pool = get('buildRecommendedSegmentCandidatePool')();
    assert.deepEqual(plain(pool), []);
  });
});

// computeSegmentPoolKey(): the fix for a real bug a supervisor review found
// in recomputeRecommendedSegmentsIfNeeded()'s original poolKey, which was
// state.segments.length -- copied from recomputeRecommendedRoutesIfNeeded(),
// where a length fingerprint is safe because stravaRoutes/activities only
// ever grow. state.segments is different: toggleLocalFavorite() (the heart
// button) both adds AND removes favorites, so swapping one favorite for
// another leaves the length unchanged while the pool's actual membership
// changes completely. Extracted as its own pure function (rather than only
// testing recomputeRecommendedSegmentsIfNeeded()'s end-to-end behavior,
// which would need a mocked fetch/network round trip) so this regression is
// covered directly and cheaply -- same idea as this file's other small pure
// helpers.
test('computeSegmentPoolKey', async (t) => {
  await t.test('two different segment lists of the SAME length produce different keys -- the exact bug scenario a supervisor review found (favorite A removed, favorite B added, length unchanged)', () => {
    const { get } = loadApp();
    const computeSegmentPoolKey = get('computeSegmentPoolKey');
    const before = [{ id: 'a' }, { id: 'c' }];
    const after = [{ id: 'b' }, { id: 'c' }]; // 'a' removed, 'b' added -- same length as before.
    assert.equal(before.length, after.length);
    assert.notEqual(computeSegmentPoolKey(before), computeSegmentPoolKey(after));
  });

  await t.test('same ids in the same order -> same key (no spurious recompute)', () => {
    const { get } = loadApp();
    const computeSegmentPoolKey = get('computeSegmentPoolKey');
    const a = [{ id: 'x' }, { id: 'y' }];
    const b = [{ id: 'x' }, { id: 'y' }];
    assert.equal(computeSegmentPoolKey(a), computeSegmentPoolKey(b));
  });

  await t.test('same ids in a different order -> different key', () => {
    const { get } = loadApp();
    const computeSegmentPoolKey = get('computeSegmentPoolKey');
    const a = [{ id: 'x' }, { id: 'y' }];
    const b = [{ id: 'y' }, { id: 'x' }];
    assert.notEqual(computeSegmentPoolKey(a), computeSegmentPoolKey(b));
  });

  await t.test('empty list -> empty string, not a crash', () => {
    const { get } = loadApp();
    const computeSegmentPoolKey = get('computeSegmentPoolKey');
    assert.equal(computeSegmentPoolKey([]), '');
  });

  // End-to-end regression for the actual bug report: simulates the scenario
  // directly through state.segments (as recomputeRecommendedSegmentsIfNeeded()
  // reads it), confirming the fixed cache key computation -- not just the
  // isolated helper above -- actually distinguishes the before/after pools.
  await t.test('regression: recomputeRecommendedSegmentsIfNeeded()\'s cache key changes across the exact reported scenario', () => {
    const { get } = loadApp();
    const state = get('state');
    const computeSegmentPoolKey = get('computeSegmentPoolKey');
    state.segments = [{ id: 'a' }, { id: 'c' }];
    const cachedPoolKey = computeSegmentPoolKey(state.segments);
    // Simulate toggleLocalFavorite() removing 'a' and adding 'b' -- length
    // stays at 2, exactly the case the old `state.segments.length` fingerprint
    // could not tell apart.
    state.segments = [{ id: 'b' }, { id: 'c' }];
    const newPoolKey = computeSegmentPoolKey(state.segments);
    assert.equal(state.segments.length, 2);
    assert.notEqual(cachedPoolKey, newPoolKey);
  });
});
