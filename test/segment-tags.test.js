'use strict';
// Tests for the Segment-Tags ("Segment-Sammlungen") pure helpers:
// getAllUsedTags/toggleSegmentTag/renameTagEverywhere/deleteTagEverywhere.
// See index.html's "---------- Segment-Tags (Sammlungen) ----------" section
// for why tags live directly on the existing local-favorites map (no new
// localStorage key, no separate tag registry) -- these tests only cover the
// pure map-in/map-out logic, not the UI wiring in renderSegmentsPage()/
// renderSegmentsCard() (nothing pure/isolatable to unit-test there).
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
// in this suite (see e.g. test/local-favorites.test.js's plain()).
function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

function seg(id, extra) {
  return Object.assign({ id, name: `Segment ${id}`, distance: 1000, average_grade: 3 }, extra || {});
}

// ---------------------------------------------------------------------
// getAllUsedTags(map)
// ---------------------------------------------------------------------
test('getAllUsedTags', async (t) => {
  await t.test('empty map -> []', () => {
    const { get } = loadApp();
    const getAllUsedTags = get('getAllUsedTags');
    assert.deepEqual(plain(getAllUsedTags({})), []);
  });

  await t.test('segments with no tags field at all -> []', () => {
    const { get } = loadApp();
    const getAllUsedTags = get('getAllUsedTags');
    const map = { 1: seg(1), 2: seg(2) };
    assert.deepEqual(plain(getAllUsedTags(map)), []);
  });

  await t.test('dedupes across segments and sorts the result', () => {
    const { get } = loadApp();
    const getAllUsedTags = get('getAllUsedTags');
    const map = {
      1: seg(1, { tags: ['Bergtraining', 'Wochenende'] }),
      2: seg(2, { tags: ['Feierabendrunde', 'Bergtraining'] }),
      3: seg(3, { tags: [] }),
    };
    assert.deepEqual(plain(getAllUsedTags(map)), ['Bergtraining', 'Feierabendrunde', 'Wochenende']);
  });
});

// ---------------------------------------------------------------------
// toggleSegmentTag(map, segId, tagName)
// ---------------------------------------------------------------------
test('toggleSegmentTag', async (t) => {
  await t.test('adding a tag to a segment with none yet', () => {
    const { get } = loadApp();
    const toggleSegmentTag = get('toggleSegmentTag');
    const map = { 1: seg(1) };
    const result = toggleSegmentTag(map, 1, 'Bergtraining');
    assert.deepEqual(plain(result[1].tags), ['Bergtraining']);
  });

  await t.test('toggling the same tag again removes it', () => {
    const { get } = loadApp();
    const toggleSegmentTag = get('toggleSegmentTag');
    const map = { 1: seg(1, { tags: ['Bergtraining'] }) };
    const result = toggleSegmentTag(map, 1, 'Bergtraining');
    assert.deepEqual(plain(result[1].tags), []);
  });

  await t.test('adding one tag leaves a segment\'s other tags untouched', () => {
    const { get } = loadApp();
    const toggleSegmentTag = get('toggleSegmentTag');
    const map = { 1: seg(1, { tags: ['Wochenende'] }) };
    const result = toggleSegmentTag(map, 1, 'Bergtraining');
    assert.deepEqual(plain(result[1].tags).sort(), ['Bergtraining', 'Wochenende']);
  });

  await t.test('case-insensitive reuse: typing an existing tag in different casing reuses its stored casing', () => {
    const { get } = loadApp();
    const toggleSegmentTag = get('toggleSegmentTag');
    // "Bergtraining" already exists (on segment 2) -- adding "bergtraining"
    // (lowercase) to segment 1 should reuse the existing casing, not create
    // a second near-duplicate tag.
    const map = { 1: seg(1), 2: seg(2, { tags: ['Bergtraining'] }) };
    const result = toggleSegmentTag(map, 1, 'bergtraining');
    assert.deepEqual(plain(result[1].tags), ['Bergtraining']);
  });

  await t.test('case-insensitive match also governs toggle-off, not just casing on add', () => {
    const { get } = loadApp();
    const toggleSegmentTag = get('toggleSegmentTag');
    // Segment 1 already has "Bergtraining" stored; toggling "bergtraining"
    // (different casing) must be recognized as "already present" and REMOVE
    // it, not add a second, differently-cased entry.
    const map = { 1: seg(1, { tags: ['Bergtraining'] }) };
    const result = toggleSegmentTag(map, 1, 'bergtraining');
    assert.deepEqual(plain(result[1].tags), []);
  });

  await t.test('toggling a nonexistent segment id is a no-op', () => {
    const { get } = loadApp();
    const toggleSegmentTag = get('toggleSegmentTag');
    const map = { 1: seg(1) };
    const result = toggleSegmentTag(map, 999, 'Bergtraining');
    assert.deepEqual(plain(result), plain(map));
  });

  await t.test('empty tag name is a no-op', () => {
    const { get } = loadApp();
    const toggleSegmentTag = get('toggleSegmentTag');
    const map = { 1: seg(1) };
    const result = toggleSegmentTag(map, 1, '');
    assert.deepEqual(plain(result), plain(map));
  });

  await t.test('whitespace-only tag name is a no-op', () => {
    const { get } = loadApp();
    const toggleSegmentTag = get('toggleSegmentTag');
    const map = { 1: seg(1) };
    const result = toggleSegmentTag(map, 1, '   ');
    assert.deepEqual(plain(result), plain(map));
  });

  await t.test('a tag name with surrounding whitespace is trimmed before storing', () => {
    const { get } = loadApp();
    const toggleSegmentTag = get('toggleSegmentTag');
    const map = { 1: seg(1) };
    const result = toggleSegmentTag(map, 1, '  Bergtraining  ');
    assert.deepEqual(plain(result[1].tags), ['Bergtraining']);
  });

  await t.test('does not mutate the input map', () => {
    const { get } = loadApp();
    const toggleSegmentTag = get('toggleSegmentTag');
    const map = { 1: seg(1) };
    toggleSegmentTag(map, 1, 'Bergtraining');
    assert.equal(map[1].tags, undefined, 'the original segment object must not have gained a tags field');
  });
});

// ---------------------------------------------------------------------
// renameTagEverywhere(map, oldName, newName)
// ---------------------------------------------------------------------
test('renameTagEverywhere', async (t) => {
  await t.test('renames a tag across multiple segments at once', () => {
    const { get } = loadApp();
    const renameTagEverywhere = get('renameTagEverywhere');
    const map = {
      1: seg(1, { tags: ['Bergtraining', 'Wochenende'] }),
      2: seg(2, { tags: ['Bergtraining'] }),
      3: seg(3, { tags: ['Wochenende'] }),
    };
    const result = renameTagEverywhere(map, 'Bergtraining', 'Hügeltraining');
    assert.deepEqual(plain(result[1].tags).sort(), ['Hügeltraining', 'Wochenende']);
    assert.deepEqual(plain(result[2].tags), ['Hügeltraining']);
    assert.deepEqual(plain(result[3].tags), ['Wochenende'], 'unrelated tag untouched');
  });

  await t.test('renaming to blank is a no-op', () => {
    const { get } = loadApp();
    const renameTagEverywhere = get('renameTagEverywhere');
    const map = { 1: seg(1, { tags: ['Bergtraining'] }) };
    const result = renameTagEverywhere(map, 'Bergtraining', '   ');
    assert.deepEqual(plain(result), plain(map));
  });

  await t.test('renaming to a name that case-insensitively collides with a different existing tag merges into it', () => {
    const { get } = loadApp();
    const renameTagEverywhere = get('renameTagEverywhere');
    const map = {
      1: seg(1, { tags: ['Bergtraining'] }),
      2: seg(2, { tags: ['Wochenende'] }),
    };
    // "wochenende" (lowercase) collides case-insensitively with the existing
    // "Wochenende" tag -- should merge into that exact stored casing rather
    // than creating a second "wochenende" tag.
    const result = renameTagEverywhere(map, 'Bergtraining', 'wochenende');
    assert.deepEqual(plain(result[1].tags), ['Wochenende']);
  });

  await t.test('collision merge dedupes when a segment already had both the old and target tag', () => {
    const { get } = loadApp();
    const renameTagEverywhere = get('renameTagEverywhere');
    const map = { 1: seg(1, { tags: ['Bergtraining', 'Wochenende'] }) };
    const result = renameTagEverywhere(map, 'Bergtraining', 'Wochenende');
    assert.deepEqual(plain(result[1].tags), ['Wochenende'], 'should end up with just one occurrence, not a duplicate');
  });

  await t.test('renaming a tag that does not exist anywhere leaves the map unchanged', () => {
    const { get } = loadApp();
    const renameTagEverywhere = get('renameTagEverywhere');
    const map = { 1: seg(1, { tags: ['Bergtraining'] }) };
    const result = renameTagEverywhere(map, 'Nichtvorhanden', 'Neu');
    assert.deepEqual(plain(result), plain(map));
  });

  await t.test('trims the new name before storing', () => {
    const { get } = loadApp();
    const renameTagEverywhere = get('renameTagEverywhere');
    const map = { 1: seg(1, { tags: ['Bergtraining'] }) };
    const result = renameTagEverywhere(map, 'Bergtraining', '  Hügeltraining  ');
    assert.deepEqual(plain(result[1].tags), ['Hügeltraining']);
  });

  await t.test('does not mutate the input map', () => {
    const { get } = loadApp();
    const renameTagEverywhere = get('renameTagEverywhere');
    const map = { 1: seg(1, { tags: ['Bergtraining'] }) };
    renameTagEverywhere(map, 'Bergtraining', 'Hügeltraining');
    assert.deepEqual(plain(map[1].tags), ['Bergtraining']);
  });
});

// ---------------------------------------------------------------------
// deleteTagEverywhere(map, tagName)
// ---------------------------------------------------------------------
test('deleteTagEverywhere', async (t) => {
  await t.test('removes a tag from multiple segments at once', () => {
    const { get } = loadApp();
    const deleteTagEverywhere = get('deleteTagEverywhere');
    const map = {
      1: seg(1, { tags: ['Bergtraining', 'Wochenende'] }),
      2: seg(2, { tags: ['Bergtraining'] }),
      3: seg(3, { tags: ['Wochenende'] }),
    };
    const result = deleteTagEverywhere(map, 'Bergtraining');
    assert.deepEqual(plain(result[1].tags), ['Wochenende']);
    assert.deepEqual(plain(result[2].tags), []);
    assert.deepEqual(plain(result[3].tags), ['Wochenende'], 'unrelated tag untouched');
  });

  await t.test('deleting a tag that does not exist anywhere is a no-op, no crash', () => {
    const { get } = loadApp();
    const deleteTagEverywhere = get('deleteTagEverywhere');
    const map = { 1: seg(1, { tags: ['Bergtraining'] }), 2: seg(2) };
    const result = deleteTagEverywhere(map, 'Nichtvorhanden');
    assert.deepEqual(plain(result), plain(map));
  });

  await t.test('does not mutate the input map', () => {
    const { get } = loadApp();
    const deleteTagEverywhere = get('deleteTagEverywhere');
    const map = { 1: seg(1, { tags: ['Bergtraining'] }) };
    deleteTagEverywhere(map, 'Bergtraining');
    assert.deepEqual(plain(map[1].tags), ['Bergtraining']);
  });
});
