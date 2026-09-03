'use strict';
// Byte/string-level helpers underlying the .ZWO/.FIT workout export
// (xmlEscape, fitCrc, fitString, slugify). Flagged as high-value/low-effort
// in the 2026-09-03 test-coverage audit: a silent encoding bug here produces
// a workout file that fails to load on the rider's head unit with no error
// surfaced anywhere in the app.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

// Arrays returned from the vm-sandboxed app come from a DIFFERENT realm than
// this test file, so assert.deepEqual's strict prototype check treats them
// as "not equal" even when every element matches (a cross-realm gotcha, not
// a real bug -- see test/pure-functions.test.js for the same helper).
function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

test('xmlEscape', async (t) => {
  const { get } = loadApp();
  const xmlEscape = get('xmlEscape');

  await t.test('escapes all five XML special characters', () => {
    assert.equal(xmlEscape(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  await t.test('null/undefined -> empty string, not "null"/"undefined"', () => {
    assert.equal(xmlEscape(null), '');
    assert.equal(xmlEscape(undefined), '');
  });

  await t.test('plain text with no special characters passes through unchanged', () => {
    assert.equal(xmlEscape('Sweet Spot Intervalle'), 'Sweet Spot Intervalle');
  });

  await t.test('non-string input is coerced to string first', () => {
    assert.equal(xmlEscape(42), '42');
  });
});

test('fitString', async (t) => {
  const { get } = loadApp();
  const fitString = get('fitString');

  await t.test('short ASCII string is placed at the start, rest zero-padded', () => {
    const out = fitString('abc', 8);
    assert.deepEqual(plain(out), [97, 98, 99, 0, 0, 0, 0, 0]);
  });

  await t.test('every German umlaut/eszett is transliterated to its ASCII digraph', () => {
    const out = fitString('äöüÄÖÜß', 20);
    const str = String.fromCharCode(...out.filter((b) => b !== 0));
    assert.equal(str, 'aeoeueAeOeUess');
  });

  await t.test('a non-ASCII, non-umlaut character becomes "?" (0x3F)', () => {
    const out = fitString('a€b', 8);
    assert.equal(out[0], 97); // 'a'
    assert.equal(out[1], 0x3f); // '€' -> '?'
    assert.equal(out[2], 98); // 'b'
  });

  await t.test('output is always exactly `len` long, zero-filled by default', () => {
    assert.equal(fitString('x', 5).length, 5);
    assert.equal(fitString('', 5).length, 5);
    assert.deepEqual(plain(fitString('', 5)), [0, 0, 0, 0, 0]);
  });

  await t.test('truncates content that would overflow the buffer, always leaving the last byte 0 (null terminator)', () => {
    // len-1 content bytes max, per the `Math.min(bytes.length, len-1)` cap.
    const out = fitString('abcdefgh', 5);
    assert.deepEqual(plain(out), [97, 98, 99, 100, 0]);
  });

  await t.test('null/undefined input -> all-zero buffer, not a thrown error', () => {
    assert.deepEqual(plain(fitString(null, 4)), [0, 0, 0, 0]);
    assert.deepEqual(plain(fitString(undefined, 4)), [0, 0, 0, 0]);
  });
});

test('slugify', async (t) => {
  const { get } = loadApp();
  const slugify = get('slugify');

  await t.test('lowercases and hyphenates spaces', () => {
    assert.equal(slugify('Sweet Spot Intervalle'), 'sweet-spot-intervalle');
  });

  await t.test('transliterates German umlauts/eszett before slugifying', () => {
    assert.equal(slugify('Schwellentraining üöä ß'), 'schwellentraining-ueoeae-ss');
  });

  await t.test('collapses runs of non-alphanumeric characters into a single hyphen', () => {
    assert.equal(slugify('a!!!b   c___d'), 'a-b-c-d');
  });

  await t.test('strips leading/trailing hyphens produced by leading/trailing punctuation', () => {
    assert.equal(slugify('  !!Workout!!  '), 'workout');
  });

  await t.test('empty result (e.g. only punctuation) falls back to "workout"', () => {
    assert.equal(slugify('!!!'), 'workout');
    assert.equal(slugify(''), 'workout');
  });

  await t.test('truncates to a max of 60 characters', () => {
    const long = 'a'.repeat(100);
    assert.equal(slugify(long).length, 60);
  });
});

test('fitCrc', async (t) => {
  const { get } = loadApp();
  const fitCrc = get('fitCrc');

  // Independent reference implementation of CRC-16/ARC (polynomial 0xA001,
  // init 0, reflected in/out, no final XOR) -- the standard algorithm the
  // FIT protocol's nibble-table CRC is a faithful table-driven variant of.
  // Deliberately bit-by-bit rather than table-driven, and NOT copied from
  // index.html's own FIT_CRC_TABLE, so this actually cross-checks the app's
  // implementation instead of restating it.
  function crc16ArcReference(bytes) {
    let crc = 0;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) {
        crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
      }
    }
    return crc & 0xffff;
  }

  await t.test('empty range -> 0 (matches an empty CRC-16/ARC computation)', () => {
    assert.equal(fitCrc([], 0, 0, 0), 0);
  });

  await t.test('matches the independent CRC-16/ARC reference for a single byte', () => {
    const bytes = [0x42];
    assert.equal(fitCrc(bytes, 0, bytes.length, 0), crc16ArcReference(bytes));
  });

  await t.test('matches the independent CRC-16/ARC reference for a realistic FIT header byte sequence', () => {
    const bytes = [12, 0x10, 0, 0, 100, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54]; // 12-byte FIT header shape
    assert.equal(fitCrc(bytes, 0, bytes.length, 0), crc16ArcReference(bytes));
  });

  await t.test('matches the reference over a `from`/`to` sub-range, not just the whole array', () => {
    const bytes = [1, 2, 3, 4, 5, 6, 7, 8];
    assert.equal(fitCrc(bytes, 2, 6, 0), crc16ArcReference(bytes.slice(2, 6)));
  });

  await t.test('is order-sensitive: two different byte sequences of the same bytes produce different CRCs', () => {
    const a = fitCrc([1, 2, 3], 0, 3, 0);
    const b = fitCrc([3, 2, 1], 0, 3, 0);
    assert.notEqual(a, b);
  });

  await t.test('running the CRC incrementally (chunk by chunk, carrying crc forward) matches running it in one call', () => {
    const bytes = [10, 20, 30, 40, 50, 60];
    const oneShot = fitCrc(bytes, 0, bytes.length, 0);
    const half = fitCrc(bytes, 0, 3, 0);
    const incremental = fitCrc(bytes, 3, bytes.length, half);
    assert.equal(incremental, oneShot);
  });
});
