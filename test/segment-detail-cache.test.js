'use strict';
// Tests for segmentStatsChanged(prevStats, newStats) -- the pure comparison
// that decides whether a segment's cached PR/stats can still be trusted
// (SEGMENT_DETAIL_CACHE_KEY, see index.html's "---------- Segment-Detail-
// Cache ----------" section). This is the core of the "never show stale
// data" guarantee for loadSegmentExtras()'s skip-the-Strava-call path: it
// must return true on every genuine change (a new PR activity, a faster
// elapsed time) and false only when both sides are truly identical, since a
// false negative here means a stale PR silently survives in the UI.
//
// loadSegmentExtras()/fetchWeatherBatchForSegments()/ensureStravaRoutesLoaded()
// are orchestration with real fetch() calls, not covered by unit tests here
// -- same established project convention as recomputeRecommendedRoutes()
// (also not directly unit-tested); verified live in the browser instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

test('segmentStatsChanged', async (t) => {
  await t.test('unverändert (gleiche pr_activity_id + pr_elapsed_time) -> false', () => {
    const { get } = loadApp();
    const segmentStatsChanged = get('segmentStatsChanged');
    const prev = { pr_activity_id: 111, pr_elapsed_time: 245 };
    const next = { pr_activity_id: 111, pr_elapsed_time: 245 };
    assert.equal(segmentStatsChanged(prev, next), false);
  });

  await t.test('pr_elapsed_time geändert (gleiche Aktivität, neue Zeit) -> true', () => {
    const { get } = loadApp();
    const segmentStatsChanged = get('segmentStatsChanged');
    const prev = { pr_activity_id: 111, pr_elapsed_time: 245 };
    const next = { pr_activity_id: 111, pr_elapsed_time: 230 };
    assert.equal(segmentStatsChanged(prev, next), true);
  });

  await t.test('pr_activity_id geändert (neue PR-Fahrt) -> true', () => {
    const { get } = loadApp();
    const segmentStatsChanged = get('segmentStatsChanged');
    const prev = { pr_activity_id: 111, pr_elapsed_time: 245 };
    const next = { pr_activity_id: 222, pr_elapsed_time: 245 };
    assert.equal(segmentStatsChanged(prev, next), true);
  });

  await t.test('vorher kein PR (prevStats=null), jetzt einer -> true', () => {
    const { get } = loadApp();
    const segmentStatsChanged = get('segmentStatsChanged');
    const next = { pr_activity_id: 222, pr_elapsed_time: 245 };
    assert.equal(segmentStatsChanged(null, next), true);
  });

  await t.test('vorher kein PR (prevStats.pr_activity_id=null), jetzt einer -> true', () => {
    const { get } = loadApp();
    const segmentStatsChanged = get('segmentStatsChanged');
    const prev = { pr_activity_id: null, pr_elapsed_time: null };
    const next = { pr_activity_id: 222, pr_elapsed_time: 245 };
    assert.equal(segmentStatsChanged(prev, next), true);
  });

  await t.test('vorher ein PR, jetzt keiner mehr (newStats=null) -> true', () => {
    const { get } = loadApp();
    const segmentStatsChanged = get('segmentStatsChanged');
    const prev = { pr_activity_id: 111, pr_elapsed_time: 245 };
    assert.equal(segmentStatsChanged(prev, null), true);
  });

  await t.test('beide null/kein Effort -> false', () => {
    const { get } = loadApp();
    const segmentStatsChanged = get('segmentStatsChanged');
    assert.equal(segmentStatsChanged(null, null), false);
  });

  await t.test('beide vorhanden aber beide ohne pr_activity_id/pr_elapsed_time -> false', () => {
    const { get } = loadApp();
    const segmentStatsChanged = get('segmentStatsChanged');
    assert.equal(segmentStatsChanged({}, {}), false);
  });

  await t.test('nur eine Seite komplett undefined (prevStats fehlt, newStats vorhanden) -> true (defensiv)', () => {
    const { get } = loadApp();
    const segmentStatsChanged = get('segmentStatsChanged');
    const next = { pr_activity_id: 333, pr_elapsed_time: 100 };
    assert.equal(segmentStatsChanged(undefined, next), true);
  });

  await t.test('nur eine Seite komplett undefined (newStats fehlt, prevStats vorhanden) -> true (defensiv)', () => {
    const { get } = loadApp();
    const segmentStatsChanged = get('segmentStatsChanged');
    const prev = { pr_activity_id: 333, pr_elapsed_time: 100 };
    assert.equal(segmentStatsChanged(prev, undefined), true);
  });
});
