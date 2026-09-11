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

// Testfälle nutzen echte SYNC_KEYS-Werte (statt frei erfundener Namen wie
// "a"/"b"/"c") seit computeSyncMergePlan() unbekannte Key-Namen filtert --
// ein synthetischer Name würde sonst schon am Allowlist-Filter scheitern,
// bevor die eigentlich zu testende Zeitstempel-Logik überhaupt greift.
test('computeSyncMergePlan', async (t) => {
  await t.test('remote key newer than local -> applied, local meta updated', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({ velocast_settings: 100 }, { velocast_settings: { value: 'remote-value', updatedAt: 200 } });
    assert.deepEqual(plain(result.toApplyLocally), { velocast_settings: 'remote-value' });
    assert.deepEqual(plain(result.newLocalMeta), { velocast_settings: 200 });
  });

  await t.test('remote key older than local -> ignored, local meta unchanged', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({ velocast_settings: 500 }, { velocast_settings: { value: 'stale-remote', updatedAt: 200 } });
    assert.deepEqual(plain(result.toApplyLocally), {});
    assert.deepEqual(plain(result.newLocalMeta), { velocast_settings: 500 });
  });

  await t.test('remote key exactly equal to local -> ignored (strictly newer required, not >=)', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({ velocast_settings: 200 }, { velocast_settings: { value: 'remote-value', updatedAt: 200 } });
    assert.deepEqual(plain(result.toApplyLocally), {});
    assert.deepEqual(plain(result.newLocalMeta), { velocast_settings: 200 });
  });

  await t.test('key missing locally (never synced on this device before) -> treated as 0, remote applies', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({}, { velocast_settings: { value: 'first-time', updatedAt: 1 } });
    assert.deepEqual(plain(result.toApplyLocally), { velocast_settings: 'first-time' });
    assert.deepEqual(plain(result.newLocalMeta), { velocast_settings: 1 });
  });

  await t.test('empty remote keys -> no-op, local meta passed through unchanged', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({ velocast_settings: 100, velocast_chain_wear: 50 }, {});
    assert.deepEqual(plain(result.toApplyLocally), {});
    assert.deepEqual(plain(result.newLocalMeta), { velocast_settings: 100, velocast_chain_wear: 50 });
  });

  await t.test('mixed keys: some newer, some older, some untouched -- each resolved independently', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan(
      { velocast_settings: 100, velocast_chain_wear: 300, velocast_tire_pressure: 50 },
      {
        velocast_settings: { value: 'a-wins-remote', updatedAt: 150 },
        velocast_chain_wear: { value: 'b-stale-remote', updatedAt: 250 },
      }
    );
    assert.deepEqual(plain(result.toApplyLocally), { velocast_settings: 'a-wins-remote' });
    assert.deepEqual(plain(result.newLocalMeta), { velocast_settings: 150, velocast_chain_wear: 300, velocast_tire_pressure: 50 });
  });

  await t.test('malformed remote entry (no updatedAt, or not a number) -> skipped defensively, no crash', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan(
      { velocast_settings: 10 },
      {
        velocast_settings: { value: 'no-timestamp' },
        velocast_chain_wear: { value: 'bad-timestamp', updatedAt: 'not-a-number' },
        velocast_tire_pressure: null,
      }
    );
    assert.deepEqual(plain(result.toApplyLocally), {});
    assert.deepEqual(plain(result.newLocalMeta), { velocast_settings: 10 });
  });

  await t.test('null/undefined localMeta (first-ever sync on a fresh device) -> treated as empty, no crash', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan(null, { velocast_settings: { value: 'v', updatedAt: 5 } });
    assert.deepEqual(plain(result.toApplyLocally), { velocast_settings: 'v' });
    assert.deepEqual(plain(result.newLocalMeta), { velocast_settings: 5 });
  });

  await t.test('remote key not in SYNC_KEYS -> ignored entirely, even with a newer timestamp (client-side counterpart to the worker\'s SYNC_ALLOWED_KEYS check)', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan(
      {},
      { not_a_real_sync_key: { value: 'should-never-apply', updatedAt: 999999999999 } }
    );
    assert.deepEqual(plain(result.toApplyLocally), {});
    assert.deepEqual(plain(result.newLocalMeta), {});
  });

  await t.test('one unknown key mixed with one real key -- only the real key is applied', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan(
      {},
      {
        velocast_settings: { value: 'real-value', updatedAt: 100 },
        strava_refresh_token: { value: 'must-never-sync', updatedAt: 999999999999 },
      }
    );
    assert.deepEqual(plain(result.toApplyLocally), { velocast_settings: 'real-value' });
    assert.deepEqual(plain(result.newLocalMeta), { velocast_settings: 100 });
  });

  // toPushRemotely: Nachschärfung gegen einen verlorenen Push, wenn
  // syncDirtyKeys (reine Laufzeit-Variable) durch einen geschlossenen Tab
  // oder eine Offline-Änderung verloren geht, bevor der Push je ankam --
  // localMeta (persistiert) bleibt die verlässliche Quelle, ob ein Key noch
  // "aussteht".
  await t.test('toPushRemotely: local key newer than what the server has -> re-queued for push', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan(
      { velocast_settings: 500 },
      { velocast_settings: { value: 'server-stale', updatedAt: 200 } }
    );
    assert.deepEqual(plain(result.toPushRemotely), ['velocast_settings']);
  });

  await t.test('toPushRemotely: local key the server has never seen at all (missing from remote) -> re-queued', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({ velocast_chain_wear: 42 }, {});
    assert.deepEqual(plain(result.toPushRemotely), ['velocast_chain_wear']);
  });

  await t.test('toPushRemotely: remote is newer or equal -> NOT re-queued (that key goes to toApplyLocally / is already in sync instead)', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const newer = plan({ velocast_settings: 100 }, { velocast_settings: { value: 'v', updatedAt: 200 } });
    assert.deepEqual(plain(newer.toPushRemotely), []);
    const equal = plan({ velocast_settings: 200 }, { velocast_settings: { value: 'v', updatedAt: 200 } });
    assert.deepEqual(plain(equal.toPushRemotely), []);
  });

  await t.test('toPushRemotely: only genuinely pending keys are listed, mixed with up-to-date ones', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan(
      { velocast_settings: 500, velocast_chain_wear: 100, velocast_tire_pressure: 50 },
      {
        velocast_settings: { value: 'server-stale', updatedAt: 200 }, // local newer -> pending
        velocast_chain_wear: { value: 'v', updatedAt: 100 },          // equal -> not pending
        // velocast_tire_pressure absent from remote entirely -> pending
      }
    );
    assert.deepEqual(plain(result.toPushRemotely).sort(), ['velocast_settings', 'velocast_tire_pressure']);
  });

  await t.test('toPushRemotely: a key outside SYNC_KEYS in localMeta is never queued (defensive, matches the same allowlist as everywhere else)', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({ not_a_real_sync_key: 999999999999 }, {});
    assert.deepEqual(plain(result.toPushRemotely), []);
  });

  await t.test('toPushRemotely: empty localMeta -> nothing pending, no crash', () => {
    const { get } = loadApp();
    const plan = get('computeSyncMergePlan');
    const result = plan({}, { velocast_settings: { value: 'v', updatedAt: 5 } });
    assert.deepEqual(plain(result.toPushRemotely), []);
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
