'use strict';
// Tests for the local segment-favorites ("Herz") tool: loadLocalFavoriteSegments/
// saveLocalFavoriteSegments, isLocalFavorite/toggleLocalFavorite, and the
// one-time migration from Strava's starred-segments list
// (mergeFavoritesFromStarred/migrateStarredSegmentsToLocalFavorites). See
// index.html's "---------- Lokale Segment-Favoriten (Herz) ----------"
// section for why this exists independently from the real Strava star
// (toggleSegmentStar()/starSegment(), untouched by this feature and not
// re-tested here).
//
// migrateStarredSegmentsToLocalFavorites() itself calls fetch() via
// fetchStarredSegments() -- the test sandbox's fetch stub always rejects
// (see test/support/loadApp.js), so only its no-op/failure branches are
// exercised directly here; the actual "add-only" merge rule is covered via
// the pure mergeFavoritesFromStarred() helper it delegates to instead.
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
// in this suite (see e.g. test/segmentjaeger.test.js's plain()).
function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

function seg(id, extra) {
  return Object.assign({ id, name: `Segment ${id}`, distance: 1000, average_grade: 3 }, extra || {});
}

// ---------------------------------------------------------------------
// loadLocalFavoriteSegments / saveLocalFavoriteSegments
// ---------------------------------------------------------------------
test('loadLocalFavoriteSegments / saveLocalFavoriteSegments', async (t) => {
  await t.test('no stored value -> empty object, not an error', () => {
    const { get } = loadApp();
    const loadLocalFavoriteSegments = get('loadLocalFavoriteSegments');
    assert.deepEqual(plain(loadLocalFavoriteSegments()), {});
  });

  await t.test('round-trips a saved map', () => {
    const { get } = loadApp();
    const loadLocalFavoriteSegments = get('loadLocalFavoriteSegments');
    const saveLocalFavoriteSegments = get('saveLocalFavoriteSegments');
    saveLocalFavoriteSegments({ 1: seg(1), 2: seg(2) });
    const loaded = loadLocalFavoriteSegments();
    assert.equal(Object.keys(loaded).length, 2);
    assert.equal(loaded[1].name, 'Segment 1');
  });

  await t.test('corrupt JSON falls back to empty object', () => {
    const { get } = loadApp({ initialLocalStorage: { velocast_local_favorite_segments: '{not json' } });
    const loadLocalFavoriteSegments = get('loadLocalFavoriteSegments');
    assert.deepEqual(plain(loadLocalFavoriteSegments()), {});
  });

  await t.test('non-object top-level (e.g. an array) falls back to empty object', () => {
    const { get } = loadApp({ initialLocalStorage: { velocast_local_favorite_segments: '[1,2,3]' } });
    const loadLocalFavoriteSegments = get('loadLocalFavoriteSegments');
    assert.deepEqual(plain(loadLocalFavoriteSegments()), {});
  });
});

// ---------------------------------------------------------------------
// isLocalFavorite / toggleLocalFavorite
// ---------------------------------------------------------------------
test('isLocalFavorite / toggleLocalFavorite', async (t) => {
  await t.test('a never-favorited segment is not a favorite', () => {
    const { get } = loadApp();
    const isLocalFavorite = get('isLocalFavorite');
    assert.equal(isLocalFavorite(seg(1)), false);
  });

  await t.test('toggling adds a segment, toggling again removes it', () => {
    const { get } = loadApp();
    const isLocalFavorite = get('isLocalFavorite');
    const toggleLocalFavorite = get('toggleLocalFavorite');
    const s = seg(1);
    toggleLocalFavorite(s);
    assert.equal(isLocalFavorite(s), true);
    toggleLocalFavorite(s);
    assert.equal(isLocalFavorite(s), false);
  });

  await t.test('persists across a fresh load', () => {
    const { get, ctx } = loadApp();
    const toggleLocalFavorite = get('toggleLocalFavorite');
    toggleLocalFavorite(seg(5));
    const stored = ctx.localStorage.getItem('velocast_local_favorite_segments');
    const { get: get2 } = loadApp({ initialLocalStorage: { velocast_local_favorite_segments: stored } });
    const isLocalFavorite2 = get2('isLocalFavorite');
    assert.equal(isLocalFavorite2(seg(5)), true);
  });

  await t.test('toggling one segment has no effect on another', () => {
    const { get } = loadApp();
    const isLocalFavorite = get('isLocalFavorite');
    const toggleLocalFavorite = get('toggleLocalFavorite');
    toggleLocalFavorite(seg(1));
    assert.equal(isLocalFavorite(seg(1)), true);
    assert.equal(isLocalFavorite(seg(2)), false);
  });

  await t.test('keeps state.segments (the Favoriten page list) in sync immediately, both ways', () => {
    // Regression: without this, un-hearting a segment while looking at the
    // Favoriten page left a stale row behind until the next reload, since
    // that page's list is a state.segments snapshot, not re-read from
    // localStorage on every render(). See toggleLocalFavorite()'s comment.
    const { get } = loadApp();
    const state = get('state');
    const toggleLocalFavorite = get('toggleLocalFavorite');
    const s = seg(9);
    toggleLocalFavorite(s);
    assert.equal(state.segments.length, 1, 'favoriting should add it to state.segments right away');
    assert.equal(state.segments[0].id, 9);
    toggleLocalFavorite(s);
    assert.equal(state.segments.length, 0, 'un-favoriting should remove it from state.segments right away');
  });

  await t.test('stores the full segment object, not just the id', () => {
    const { get } = loadApp();
    const toggleLocalFavorite = get('toggleLocalFavorite');
    const loadLocalFavoriteSegments = get('loadLocalFavoriteSegments');
    toggleLocalFavorite(seg(7, { name: 'Alpe Steil', distance: 4200, average_grade: 8.1 }));
    const stored = loadLocalFavoriteSegments()[7];
    assert.equal(stored.name, 'Alpe Steil');
    assert.equal(stored.distance, 4200);
  });
});

// ---------------------------------------------------------------------
// mergeFavoritesFromStarred(existingMap, starredList) -- pure "add-only"
// merge rule used by migrateStarredSegmentsToLocalFavorites().
// ---------------------------------------------------------------------
test('mergeFavoritesFromStarred', async (t) => {
  await t.test('adds every starred segment to an empty map', () => {
    const { get } = loadApp();
    const mergeFavoritesFromStarred = get('mergeFavoritesFromStarred');
    const merged = mergeFavoritesFromStarred({}, [seg(1), seg(2)]);
    assert.deepEqual(Object.keys(merged).sort(), ['1', '2']);
  });

  await t.test('does not overwrite a segment already present locally', () => {
    const { get } = loadApp();
    const mergeFavoritesFromStarred = get('mergeFavoritesFromStarred');
    const existing = { 1: seg(1, { name: 'Local Version' }) };
    const merged = mergeFavoritesFromStarred(existing, [seg(1, { name: 'Strava Version' })]);
    assert.equal(merged[1].name, 'Local Version');
  });

  await t.test('does not mutate the input map', () => {
    const { get } = loadApp();
    const mergeFavoritesFromStarred = get('mergeFavoritesFromStarred');
    const existing = { 1: seg(1) };
    mergeFavoritesFromStarred(existing, [seg(2)]);
    assert.deepEqual(Object.keys(existing), ['1']);
  });

  await t.test('empty/missing starred list -> existing map unchanged (new object, same contents)', () => {
    const { get } = loadApp();
    const mergeFavoritesFromStarred = get('mergeFavoritesFromStarred');
    const existing = { 1: seg(1) };
    assert.deepEqual(plain(mergeFavoritesFromStarred(existing, [])), plain(existing));
    assert.deepEqual(plain(mergeFavoritesFromStarred(existing, null)), plain(existing));
    assert.deepEqual(plain(mergeFavoritesFromStarred(existing, undefined)), plain(existing));
  });
});

// ---------------------------------------------------------------------
// migrateStarredSegmentsToLocalFavorites(token) -- orchestrator. Fetch
// always fails in this sandbox, so only the no-op/graceful-failure branches
// are directly exercised here.
// ---------------------------------------------------------------------
test('migrateStarredSegmentsToLocalFavorites', async (t) => {
  await t.test('no token -> no-op, does not touch localStorage', async () => {
    const { get } = loadApp();
    const migrate = get('migrateStarredSegmentsToLocalFavorites');
    const loadLocalFavoriteSegments = get('loadLocalFavoriteSegments');
    await migrate(undefined);
    assert.deepEqual(plain(loadLocalFavoriteSegments()), {});
  });

  await t.test('marker already set -> no-op even with a token (no fetch attempted)', async () => {
    let fetchCalls = 0;
    const { get } = loadApp({
      onFetchCall: () => { fetchCalls++; },
      initialLocalStorage: { velocast_local_favorites_migrated: '1' }
    });
    const migrate = get('migrateStarredSegmentsToLocalFavorites');
    await migrate('fake-token');
    assert.equal(fetchCalls, 0, 'should not attempt a fetch once already migrated');
  });

  await t.test('fetch failure (sandbox default) -> silently no-ops, marker stays unset for a future retry', async () => {
    const { get } = loadApp();
    const migrate = get('migrateStarredSegmentsToLocalFavorites');
    const loadLocalFavoriteSegments = get('loadLocalFavoriteSegments');
    await assert.doesNotReject(() => migrate('fake-token'));
    assert.deepEqual(plain(loadLocalFavoriteSegments()), {}, 'a failed fetch must not have written anything');
  });

  await t.test('does attempt a fetch when a token is present and not yet migrated', async () => {
    let fetchCalls = 0;
    const { get } = loadApp({ onFetchCall: () => { fetchCalls++; } });
    const migrate = get('migrateStarredSegmentsToLocalFavorites');
    await migrate('fake-token');
    assert.equal(fetchCalls, 1);
  });
});
