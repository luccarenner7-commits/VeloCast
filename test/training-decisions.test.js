'use strict';
// Two pieces of the Training Decision Engine flagged as high-value/
// low-effort in the 2026-09-03 test-coverage audit:
//   - weightedLinearRegression: feeds both the FTP-ceiling trend/forecast
//     and the HR-only LTHR estimation regression.
//   - computeTestDueSignal: decides which deliberate-test duration (1/5/10/
//     20-min all-out) is "due" and which one the duration picker defaults to
//     -- a regression here silently misleads a rider about which test to run
//     next.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

test('weightedLinearRegression', async (t) => {
  const { get } = loadApp();
  const weightedLinearRegression = get('weightedLinearRegression');

  await t.test('fewer than 2 points -> null (regression is undefined)', () => {
    assert.equal(weightedLinearRegression([]), null);
    assert.equal(weightedLinearRegression([{ x: 0, y: 1, w: 1 }]), null);
  });

  await t.test('equal weights on a perfect line recovers the exact slope/intercept', () => {
    // y = 2x + 3, unweighted (all w=1)
    const points = [0, 1, 2, 3, 4].map((x) => ({ x, y: 2 * x + 3, w: 1 }));
    const reg = weightedLinearRegression(points);
    assert.ok(Math.abs(reg.slope - 2) < 1e-9);
    assert.ok(Math.abs(reg.intercept - 3) < 1e-9);
  });

  await t.test('a heavily-weighted outlier pulls the fit noticeably toward it vs. an unweighted fit', () => {
    // Points near y=x, but one point far off the line with a huge weight.
    const base = [{ x: 0, y: 0, w: 1 }, { x: 1, y: 1, w: 1 }, { x: 2, y: 2, w: 1 }];
    const withHeavyOutlier = [...base, { x: 10, y: 0, w: 1000 }];
    const unweightedFit = weightedLinearRegression(base);
    const skewedFit = weightedLinearRegression(withHeavyOutlier);
    // The heavy outlier at (10,0) has slope ~0 pull -- it should drag the
    // fitted slope down substantially from the base fit's slope of ~1.
    assert.ok(skewedFit.slope < unweightedFit.slope - 0.3, `expected a heavy-weight pull, got base=${unweightedFit.slope} skewed=${skewedFit.slope}`);
  });

  await t.test('zero-weight points are effectively ignored', () => {
    const points = [{ x: 0, y: 0, w: 1 }, { x: 1, y: 1, w: 1 }, { x: 100, y: -500, w: 0 }];
    const reg = weightedLinearRegression(points);
    assert.ok(Math.abs(reg.slope - 1) < 1e-9);
    assert.ok(Math.abs(reg.intercept - 0) < 1e-9);
  });

  await t.test('degenerate input (all points at the same x) -> null, not NaN/Infinity (den===0 guard)', () => {
    const points = [{ x: 5, y: 1, w: 1 }, { x: 5, y: 2, w: 1 }, { x: 5, y: 3, w: 1 }];
    assert.equal(weightedLinearRegression(points), null);
  });

  await t.test('flat line (constant y) -> slope 0, intercept === the constant', () => {
    const points = [0, 1, 2, 3].map((x) => ({ x, y: 42, w: 1 }));
    const reg = weightedLinearRegression(points);
    assert.ok(Math.abs(reg.slope) < 1e-9);
    assert.ok(Math.abs(reg.intercept - 42) < 1e-9);
  });
});

test('computeTestDueSignal', async (t) => {
  const TEST_DURATIONS_SEC_REF = [60, 300, 600, 1200]; // mirrors the app's own TEST_DURATIONS_SEC

  await t.test('no confirmed tests ever -> every duration is stale (daysSince null)', () => {
    const { get } = loadApp();
    get('state').confirmedTests = {};
    const trainingState = { priorities: { anaerobic: 'HIGH', vo2max: 'HIGH', threshold: 'HIGH' } };
    const result = get('computeTestDueSignal')(get('state').profilPage, trainingState, '2026-06-01');
    result.entries.forEach((e) => {
      assert.equal(e.daysSince, null);
      assert.equal(e.stale, true);
    });
  });

  await t.test('a duration whose class is at MAINTENANCE/LOW priority is never "due", even if stale', () => {
    const { get } = loadApp();
    get('state').confirmedTests = {};
    const trainingState = { priorities: { anaerobic: 'MAINTENANCE', vo2max: 'LOW', threshold: 'MAINTENANCE' } };
    const result = get('computeTestDueSignal')(get('state').profilPage, trainingState, '2026-06-01');
    result.entries.forEach((e) => assert.equal(e.due, false, `${e.durationSec}s (${e.classKey}/${e.tier}) should not be due`));
    assert.equal(result.dueEntries.length, 0);
  });

  await t.test('recently confirmed (< TEST_STALENESS_DAYS ago) -> not stale, not due, even at HIGH priority', () => {
    const { get } = loadApp();
    const TEST_STALENESS_DAYS = get('TEST_STALENESS_DAYS');
    get('state').confirmedTests = {
      t1: { durationSec: 1200, confirmedAtIso: '2026-05-25T00:00:00.000Z' }, // 7 days before "today"
    };
    const trainingState = { priorities: { threshold: 'HIGH' } };
    const result = get('computeTestDueSignal')(get('state').profilPage, trainingState, '2026-06-01');
    const entry1200 = result.entries.find((e) => e.durationSec === 1200);
    assert.ok(7 < TEST_STALENESS_DAYS, 'sanity: fixture assumes 7 days is well under the staleness threshold');
    assert.equal(entry1200.daysSince, 7);
    assert.equal(entry1200.stale, false);
    assert.equal(entry1200.due, false);
  });

  await t.test('confirmed exactly TEST_STALENESS_DAYS ago -> stale (boundary is inclusive, >=)', () => {
    const { get } = loadApp();
    const TEST_STALENESS_DAYS = get('TEST_STALENESS_DAYS');
    const confirmedDate = new Date(Date.UTC(2026, 5, 1) - TEST_STALENESS_DAYS * 86400000);
    get('state').confirmedTests = {
      t1: { durationSec: 1200, confirmedAtIso: confirmedDate.toISOString() },
    };
    const trainingState = { priorities: { threshold: 'HIGH' } };
    const result = get('computeTestDueSignal')(get('state').profilPage, trainingState, '2026-06-01');
    const entry1200 = result.entries.find((e) => e.durationSec === 1200);
    assert.equal(entry1200.daysSince, TEST_STALENESS_DAYS);
    assert.equal(entry1200.stale, true);
    assert.equal(entry1200.due, true);
  });

  await t.test('only the LATEST confirmation for a duration counts, an older one for the same duration is ignored', () => {
    const { get } = loadApp();
    get('state').confirmedTests = {
      old: { durationSec: 1200, confirmedAtIso: '2026-01-01T00:00:00.000Z' }, // very stale
      recent: { durationSec: 1200, confirmedAtIso: '2026-05-30T00:00:00.000Z' }, // 2 days ago
    };
    const trainingState = { priorities: { threshold: 'HIGH' } };
    const result = get('computeTestDueSignal')(get('state').profilPage, trainingState, '2026-06-01');
    const entry1200 = result.entries.find((e) => e.durationSec === 1200);
    assert.equal(entry1200.daysSince, 2);
    assert.equal(entry1200.stale, false);
  });

  await t.test('sorted by priority tier first (HIGH before MEDIUM), then by staleness (longest-unconfirmed first)', () => {
    const { get } = loadApp();
    get('state').confirmedTests = {
      a: { durationSec: 60, confirmedAtIso: '2026-05-31T00:00:00.000Z' }, // anaerobic, 1 day ago, but HIGH
      b: { durationSec: 1200, confirmedAtIso: '2026-01-01T00:00:00.000Z' }, // threshold, very stale, but MEDIUM
    };
    const trainingState = { priorities: { anaerobic: 'HIGH', vo2max: 'MEDIUM', threshold: 'MEDIUM' } };
    const result = get('computeTestDueSignal')(get('state').profilPage, trainingState, '2026-06-01');
    // HIGH-tier 60s entry must sort before any MEDIUM-tier entry, even though it's fresher.
    const idx60 = result.entries.findIndex((e) => e.durationSec === 60);
    const idx1200 = result.entries.findIndex((e) => e.durationSec === 1200);
    assert.ok(idx60 < idx1200, 'HIGH-tier entry should sort before MEDIUM-tier entries regardless of staleness');
  });

  await t.test('suggestedDurationSec picks the first DUE entry when any exist', () => {
    const { get } = loadApp();
    get('state').confirmedTests = {};
    const trainingState = { priorities: { anaerobic: 'MAINTENANCE', vo2max: 'HIGH', threshold: 'MAINTENANCE' } };
    const result = get('computeTestDueSignal')(get('state').profilPage, trainingState, '2026-06-01');
    assert.ok(result.dueEntries.length > 0);
    assert.equal(result.suggestedDurationSec, result.dueEntries[0].durationSec);
    // vo2max maps to both 300s and 600s -- either is an acceptable top pick,
    // but it must NOT be 1200s (threshold, MAINTENANCE) or a MAINTENANCE-tier one.
    assert.ok([300, 600].includes(result.suggestedDurationSec));
  });

  await t.test('suggestedDurationSec falls back to entries[0] (highest-sorted) when nothing is due', () => {
    const { get } = loadApp();
    get('state').confirmedTests = {
      t1: { durationSec: 1200, confirmedAtIso: '2026-05-31T00:00:00.000Z' },
    };
    const trainingState = { priorities: { anaerobic: 'MAINTENANCE', vo2max: 'MAINTENANCE', threshold: 'HIGH' } };
    const result = get('computeTestDueSignal')(get('state').profilPage, trainingState, '2026-06-01');
    assert.equal(result.dueEntries.length, 0);
    assert.equal(result.suggestedDurationSec, result.entries[0].durationSec);
  });

  await t.test('covers all 4 known test durations, no duration silently dropped', () => {
    const { get } = loadApp();
    get('state').confirmedTests = {};
    const trainingState = { priorities: {} };
    const result = get('computeTestDueSignal')(get('state').profilPage, trainingState, '2026-06-01');
    assert.deepEqual(plain(result.entries.map((e) => e.durationSec)).sort((a, b) => a - b), TEST_DURATIONS_SEC_REF);
  });
});

// ---------------------------------------------------------------------
// localWeekBounds(now) -- local-timezone Monday-through-next-Monday
// bounds, shared by actualWeekZoneBreakdown() and trainerRiderContext()'s
// "Woche bisher" ride count. Added as a fix for a real bug (04.09.2026,
// Nutzer-Feedback): the Trainer tab's "Woche bisher" chip used to show a
// rolling last-7-days count under a label ("Woche bisher"/"week so far")
// that reads as a calendar week to a rider -- e.g. showing "5 Fahrten"
// when only 3 had actually happened since Monday, because two more from
// the tail end of the PREVIOUS week were still within the trailing 7
// days. Deliberately local time, not mondayOfUTC() (date-helpers.test.js)
// -- a UTC boundary would drift against the rider's own wall-clock Monday.
// ---------------------------------------------------------------------
test('localWeekBounds', async (t) => {
  await t.test('a Wednesday resolves to that same week\'s Monday 00:00 through the following Monday 00:00', () => {
    const { get } = loadApp();
    const localWeekBounds = get('localWeekBounds');
    const wednesday = new Date(2026, 8, 2, 15, 30, 0); // Wed 2026-09-02, 15:30 local
    const { monday, nextMonday } = localWeekBounds(wednesday);
    assert.equal(monday.getFullYear(), 2026);
    assert.equal(monday.getMonth(), 7); // August, 0-indexed -- Mon 2026-08-31
    assert.equal(monday.getDate(), 31); // Mon 2026-08-31
    assert.equal(monday.getHours(), 0);
    assert.equal(monday.getMinutes(), 0);
    assert.equal(nextMonday.getDate(), 7); // Mon 2026-09-07
    assert.equal(nextMonday.getMonth(), 8);
  });

  await t.test('a Monday itself resolves to its own midnight, not the previous week\'s', () => {
    const { get } = loadApp();
    const localWeekBounds = get('localWeekBounds');
    const mondayNoon = new Date(2026, 8, 7, 12, 0, 0); // Mon 2026-09-07, noon
    const { monday } = localWeekBounds(mondayNoon);
    assert.equal(monday.getDate(), 7);
    assert.equal(monday.getHours(), 0);
  });

  await t.test('a Sunday resolves back to the Monday that started its own week (6 days earlier), not the next one', () => {
    const { get } = loadApp();
    const localWeekBounds = get('localWeekBounds');
    const sunday = new Date(2026, 8, 6, 23, 59, 0); // Sun 2026-09-06, 23:59 local
    const { monday, nextMonday } = localWeekBounds(sunday);
    assert.equal(monday.getDate(), 31); // still the Monday that started this week
    assert.equal(monday.getMonth(), 7); // August
    assert.equal(nextMonday.getDate(), 7); // the Monday right after this Sunday
  });

  await t.test('nextMonday is always exactly 7 days after monday', () => {
    const { get } = loadApp();
    const localWeekBounds = get('localWeekBounds');
    const { monday, nextMonday } = localWeekBounds(new Date(2026, 2, 15));
    assert.equal((nextMonday - monday) / (1000 * 60 * 60 * 24), 7);
  });

  await t.test('REGRESSION: a ride from the tail end of last week must fall OUTSIDE this week\'s bounds, even though it is within the last 7 days', () => {
    // This is the exact scenario behind the reported bug: today is
    // Wednesday, and a ride from last Thursday is only 6 days ago (so it
    // WOULD count toward a rolling "last 7 days" window) but is clearly
    // in the previous calendar week.
    const { get } = loadApp();
    const localWeekBounds = get('localWeekBounds');
    const wednesday = new Date(2026, 8, 2, 12, 0, 0); // Wed 2026-09-02
    const { monday } = localWeekBounds(wednesday);
    const lastThursday = new Date(2026, 7, 27, 18, 0, 0); // Thu 2026-08-27, 6 days before
    assert.ok(lastThursday < monday, 'a ride 6 days ago from a Wednesday must still be before this week\'s Monday');
  });
});
