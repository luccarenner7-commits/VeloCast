'use strict';
// UTC-based date-string helpers underlying the Training Decision Engine's
// weekly-budget window / "trained on date" checks (parseIsoDateUTC,
// toIsoDate, addDaysUTC, mondayOfUTC). Flagged as high-value/low-effort in
// the 2026-09-03 test-coverage audit: an off-by-one here (e.g. mondayOfUTC
// around a Sunday) would silently corrupt weekly progress tracking.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

test('parseIsoDateUTC', async (t) => {
  const { get } = loadApp();
  const parseIsoDateUTC = get('parseIsoDateUTC');

  await t.test('parses "YYYY-MM-DD" as UTC midnight, not local midnight', () => {
    const d = parseIsoDateUTC('2026-03-15');
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 2); // 0-indexed: March = 2
    assert.equal(d.getUTCDate(), 15);
    assert.equal(d.getUTCHours(), 0);
  });

  await t.test('January 1st (month index 0) round-trips correctly', () => {
    const d = parseIsoDateUTC('2026-01-01');
    assert.equal(d.getUTCMonth(), 0);
    assert.equal(d.getUTCDate(), 1);
  });

  await t.test('December 31st (month index 11) round-trips correctly', () => {
    const d = parseIsoDateUTC('2026-12-31');
    assert.equal(d.getUTCMonth(), 11);
    assert.equal(d.getUTCDate(), 31);
  });
});

test('toIsoDate', async (t) => {
  const { get } = loadApp();
  const toIsoDate = get('toIsoDate');

  await t.test('formats a UTC date back to "YYYY-MM-DD"', () => {
    assert.equal(toIsoDate(new Date(Date.UTC(2026, 2, 15))), '2026-03-15');
  });

  await t.test('is the exact inverse of parseIsoDateUTC for a UTC-midnight date', () => {
    const parseIsoDateUTC = get('parseIsoDateUTC');
    const iso = '2026-06-01';
    assert.equal(toIsoDate(parseIsoDateUTC(iso)), iso);
  });

  await t.test('pads single-digit month/day with a leading zero', () => {
    assert.equal(toIsoDate(new Date(Date.UTC(2026, 0, 5))), '2026-01-05');
  });
});

test('addDaysUTC', async (t) => {
  const { get } = loadApp();
  const addDaysUTC = get('addDaysUTC');
  const toIsoDate = get('toIsoDate');

  await t.test('adds days within the same month', () => {
    const d = addDaysUTC(new Date(Date.UTC(2026, 0, 1)), 5);
    assert.equal(toIsoDate(d), '2026-01-06');
  });

  await t.test('correctly rolls over a month boundary', () => {
    const d = addDaysUTC(new Date(Date.UTC(2026, 0, 30)), 3);
    assert.equal(toIsoDate(d), '2026-02-02');
  });

  await t.test('correctly rolls over a year boundary', () => {
    const d = addDaysUTC(new Date(Date.UTC(2026, 11, 30)), 3);
    assert.equal(toIsoDate(d), '2027-01-02');
  });

  await t.test('negative n subtracts days and rolls backward over a month boundary', () => {
    const d = addDaysUTC(new Date(Date.UTC(2026, 2, 1)), -2);
    assert.equal(toIsoDate(d), '2026-02-27');
  });

  await t.test('correctly handles a leap-year February 29th (2028 is a leap year)', () => {
    const d = addDaysUTC(new Date(Date.UTC(2028, 1, 28)), 1);
    assert.equal(toIsoDate(d), '2028-02-29');
  });

  await t.test('does not mutate the input date', () => {
    const original = new Date(Date.UTC(2026, 0, 1));
    const originalTime = original.getTime();
    addDaysUTC(original, 10);
    assert.equal(original.getTime(), originalTime);
  });
});

test('mondayOfUTC', async (t) => {
  const { get } = loadApp();
  const mondayOfUTC = get('mondayOfUTC');
  const parseIsoDateUTC = get('parseIsoDateUTC');
  const toIsoDate = get('toIsoDate');

  // 2026-03-16 is a Monday (verified against a real calendar).
  const knownMonday = '2026-03-16';

  await t.test('a Monday maps to itself', () => {
    assert.equal(toIsoDate(mondayOfUTC(parseIsoDateUTC(knownMonday))), knownMonday);
  });

  await t.test('a Tuesday maps back to the same week\'s Monday', () => {
    assert.equal(toIsoDate(mondayOfUTC(parseIsoDateUTC('2026-03-17'))), knownMonday);
  });

  await t.test('a Sunday maps back to the PRECEDING Monday (Mon-Sun week, not Sun-Sat)', () => {
    // 2026-03-22 is the Sunday closing out the same week as 2026-03-16.
    assert.equal(toIsoDate(mondayOfUTC(parseIsoDateUTC('2026-03-22'))), knownMonday);
  });

  await t.test('the following Monday maps to itself, not the previous week (no off-by-one at the week boundary)', () => {
    assert.equal(toIsoDate(mondayOfUTC(parseIsoDateUTC('2026-03-23'))), '2026-03-23');
  });

  await t.test('every day across a full week maps to the same Monday', () => {
    const days = ['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20', '2026-03-21', '2026-03-22'];
    days.forEach((iso) => {
      assert.equal(toIsoDate(mondayOfUTC(parseIsoDateUTC(iso))), knownMonday, `${iso} should map to ${knownMonday}`);
    });
  });

  await t.test('correctly crosses a month boundary (e.g. first Monday of a month whose 1st is mid-week)', () => {
    // 2026-04-01 is a Wednesday; its week's Monday is 2026-03-30.
    assert.equal(toIsoDate(mondayOfUTC(parseIsoDateUTC('2026-04-01'))), '2026-03-30');
  });
});
