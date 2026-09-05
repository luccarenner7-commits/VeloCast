'use strict';
// Geräte-Sync (Reifendruck, Kette, Einstellungen, ...): computeSyncMergePlan()
// ist die einzige reine, isoliert testbare Entscheidungslogik -- pro Key
// gewinnt der neuere `updatedAt`-Zeitstempel, statt ein Zeitstempel fürs
// ganze Bündel (siehe die Begründung im Plan-Kommentar in index.html direkt
// über computeSyncMergePlan()). pushSyncSoon()/pushSyncNow()/pullSyncOnLoad()
// selbst sind reine fetch()-Orchestrierung ohne eigene Verzweigungslogik --
// nicht separat getestet, gleiches Prinzip wie bei
// syncSegmentjaegerStars()/applySegmentStar() (siehe test/segmentjaeger.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

test('computeSyncMergePlan', async (t) => {
  await t.test('remote key newer than local -> applied, local meta updated', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({ a: 100 }, { a: { value: 'remote-value', updatedAt: 200 } });
    assert.deepEqual(plain(result.toApplyLocally), { a: 'remote-value' });
    assert.deepEqual(plain(result.newLocalMeta), { a: 200 });
  });

  await t.test('remote key older than local -> ignored, local meta unchanged', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({ a: 500 }, { a: { value: 'stale-remote', updatedAt: 200 } });
    assert.deepEqual(plain(result.toApplyLocally), {});
    assert.deepEqual(plain(result.newLocalMeta), { a: 500 });
  });

  await t.test('remote key exactly equal to local -> ignored (strictly newer required, not >=)', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({ a: 200 }, { a: { value: 'remote-value', updatedAt: 200 } });
    assert.deepEqual(plain(result.toApplyLocally), {});
    assert.deepEqual(plain(result.newLocalMeta), { a: 200 });
  });

  await t.test('key missing locally (never synced on this device before) -> treated as 0, remote applies', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({}, { a: { value: 'first-time', updatedAt: 1 } });
    assert.deepEqual(plain(result.toApplyLocally), { a: 'first-time' });
    assert.deepEqual(plain(result.newLocalMeta), { a: 1 });
  });

  await t.test('empty remote keys -> no-op, local meta passed through unchanged', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({ a: 100, b: 50 }, {});
    assert.deepEqual(plain(result.toApplyLocally), {});
    assert.deepEqual(plain(result.newLocalMeta), { a: 100, b: 50 });
  });

  await t.test('mixed keys: some newer, some older, some untouched -- each resolved independently', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan(
      { a: 100, b: 300, c: 50 },
      {
        a: { value: 'a-wins-remote', updatedAt: 150 },
        b: { value: 'b-stale-remote', updatedAt: 250 },
      }
    );
    assert.deepEqual(plain(result.toApplyLocally), { a: 'a-wins-remote' });
    assert.deepEqual(plain(result.newLocalMeta), { a: 150, b: 300, c: 50 });
  });

  await t.test('malformed remote entry (no updatedAt, or not a number) -> skipped defensively, no crash', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan(
      { a: 10 },
      { a: { value: 'no-timestamp' }, b: { value: 'bad-timestamp', updatedAt: 'not-a-number' }, c: null }
    );
    assert.deepEqual(plain(result.toApplyLocally), {});
    assert.deepEqual(plain(result.newLocalMeta), { a: 10 });
  });

  await t.test('null/undefined localMeta (first-ever sync on a fresh device) -> treated as empty, no crash', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan(null, { a: { value: 'v', updatedAt: 5 } });
    assert.deepEqual(plain(result.toApplyLocally), { a: 'v' });
    assert.deepEqual(plain(result.newLocalMeta), { a: 5 });
  });
});

test('SYNC_KEYS', async (t) => {
  await t.test('every synced key is a genuine user-data key, none of the known cache/token keys are included', () => {
    const { get } = loadApp();
    const keys = get('SYNC_KEYS');
    assert.equal(keys.length, 11);
    // Regression guard: these are explicitly-excluded pure Strava caches or
    // OAuth credentials (see the scoping rationale in index.html's "device
    // sync" comment) -- if one of these ever ends up in SYNC_KEYS, either
    // the exclusion list here is stale or someone accidentally widened the
    // sync scope to a key that shouldn't leave the device.
    ['strava_refresh_token', 'hammerhead_refresh_token', 'velocast_activity_cache',
      'velocast_activity_skip_cache', 'velocast_local_favorites_migrated',
      'velocast_activity_list_cache', 'velocast_hr_profile_cache',
      'velocast_hr_profile_skip_cache', 'velocast_blended_load_cache',
      'velocast_blended_load_fetched_at', 'velocast_top_routes_cache'
    ].forEach(excluded => assert.ok(!keys.includes(excluded), `${excluded} must not be synced`));
  });
});
