'use strict';
// Tests for the Reifendruckrechner mit Reminder (tire pressure calculator)
// pure functions: computeTargetPressureBar, computeLossRateBarPerDay,
// updateLearnedRateBarPerDay, estimateCurrentPressureBar, isPressureLow (see
// index.html's "---------- Reifendruckrechner mit Reminder ----------"
// section). Kept in its own file (separate from pure-functions.test.js) per
// the task brief -- new feature, new file.
//
// Each test gets a FRESH app instance via loadApp() (see
// test/support/loadApp.js), matching the existing suite's per-test isolation
// convention, even though none of these functions read/write `state`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

// ---------------------------------------------------------------------
// computeTargetPressureBar({riderWeightKg, bikeWeightKg, tireWidthMm, tubeless, terrain, wheel})
// ---------------------------------------------------------------------
test('computeTargetPressureBar', async (t) => {
  await t.test('exact table breakpoint: 25mm, 75kg total, road, non-tubeless, front -> 7.0 bar exactly', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 25, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 7.0);
  });

  await t.test('interpolated value between two breakpoints: 30mm (halfway between 28mm/6.0 and 32mm/5.0) -> 5.5 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 30, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 5.5);
  });

  await t.test('weight-scaled: 25mm base 7.0, 90kg total (weight factor 1.2) -> 8.4 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 85, bikeWeightKg: 5, tireWidthMm: 25, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 8.4);
  });

  await t.test('terrain factor: gravel (x0.85) on 32mm/75kg base 5.0 -> 4.3 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 32, tubeless: false, terrain: 'gravel', wheel: 'front' });
    assert.equal(result, 4.3);
  });

  await t.test('terrain factor: offroad (x0.7) on 32mm/75kg base 5.0 -> 3.5 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 32, tubeless: false, terrain: 'offroad', wheel: 'front' });
    assert.equal(result, 3.5);
  });

  await t.test('tubeless factor: 25mm/75kg/road tubeless (x0.9) -> 6.3 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 25, tubeless: true, terrain: 'road', wheel: 'front' });
    assert.equal(result, 6.3);
  });

  await t.test('wheel factor: rear (x1.1) on the same 25mm/75kg/road/non-tubeless setup as the front breakpoint test -> 7.7 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const front = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 25, tubeless: false, terrain: 'road', wheel: 'front' });
    const rear = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 25, tubeless: false, terrain: 'road', wheel: 'rear' });
    assert.equal(front, 7.0);
    assert.equal(rear, 7.7);
  });

  await t.test('width clamp: below 23mm clamps to the 23mm table endpoint (7.5 bar base)', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 10, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 7.5);
  });

  await t.test('width clamp: above 55mm clamps to the 55mm table endpoint (2.3 bar base)', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 70, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 2.3);
  });

  await t.test('final clamp: an extreme heavy rider pushes the raw result above 9.0 -> clamped to 9.0', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    // 23mm base 7.5, total weight 170kg -> weight factor ~2.27, raw ~17.0
    const result = computeTargetPressureBar({ riderWeightKg: 150, bikeWeightKg: 20, tireWidthMm: 23, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 9.0);
  });

  await t.test('final clamp: an extreme light rider pushes the raw result below 1.5 -> clamped to 1.5', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    // 55mm base 2.3, total weight 20kg -> weight factor ~0.267, raw ~0.61
    const result = computeTargetPressureBar({ riderWeightKg: 15, bikeWeightKg: 5, tireWidthMm: 55, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 1.5);
  });
});

// ---------------------------------------------------------------------
// computeLossRateBarPerDay(priorBar, measuredBar, hoursElapsed)
// ---------------------------------------------------------------------
test('computeLossRateBarPerDay', async (t) => {
  await t.test('normal case: 0.6 bar lost over 48 hours (2 days) -> 0.3 bar/day', () => {
    const { get } = loadApp();
    const computeLossRateBarPerDay = get('computeLossRateBarPerDay');
    const result = computeLossRateBarPerDay(6.0, 5.4, 48);
    assert.ok(Math.abs(result - 0.3) < 1e-9, `expected 0.3, got ${result}`);
  });

  await t.test('zero hoursElapsed -> null (no divide-by-zero)', () => {
    const { get } = loadApp();
    const computeLossRateBarPerDay = get('computeLossRateBarPerDay');
    assert.equal(computeLossRateBarPerDay(6.0, 5.4, 0), null);
  });

  await t.test('negative hoursElapsed -> null (guarded, not a negative-time result)', () => {
    const { get } = loadApp();
    const computeLossRateBarPerDay = get('computeLossRateBarPerDay');
    assert.equal(computeLossRateBarPerDay(6.0, 5.4, -10), null);
  });
});

// ---------------------------------------------------------------------
// updateLearnedRateBarPerDay(oldRate, newMeasuredRate, alpha = 0.3)
// ---------------------------------------------------------------------
test('updateLearnedRateBarPerDay', async (t) => {
  await t.test('normal EMA update: oldRate 0.15, newMeasuredRate 0.3 -> 0.195', () => {
    const { get } = loadApp();
    const updateLearnedRateBarPerDay = get('updateLearnedRateBarPerDay');
    const result = updateLearnedRateBarPerDay(0.15, 0.3);
    assert.ok(Math.abs(result - 0.195) < 1e-9, `expected 0.195, got ${result}`);
  });

  await t.test('sanity-clamp: an implausible 10 bar/day reading is clamped to 3 before the EMA runs, not applied raw', () => {
    const { get } = loadApp();
    const updateLearnedRateBarPerDay = get('updateLearnedRateBarPerDay');
    const result = updateLearnedRateBarPerDay(0.15, 10);
    // Unclamped, 10 would dominate the EMA (0.3*10+0.7*0.15 = 3.105).
    // Clamped to 3 first: 0.3*3+0.7*0.15 = 1.005.
    assert.ok(Math.abs(result - 1.005) < 1e-9, `expected 1.005 (clamped), got ${result}`);
  });

  await t.test('sanity-clamp: a negative ("gain") reading is clamped to 0 before the EMA runs', () => {
    const { get } = loadApp();
    const updateLearnedRateBarPerDay = get('updateLearnedRateBarPerDay');
    const result = updateLearnedRateBarPerDay(0.2, -5);
    // Clamped to 0: 0.3*0+0.7*0.2 = 0.14.
    assert.ok(Math.abs(result - 0.14) < 1e-9, `expected 0.14 (clamped), got ${result}`);
  });
});

// ---------------------------------------------------------------------
// estimateCurrentPressureBar(lastBaselineBar, lastBaselineAtMs, learnedRateBarPerDay, nowMs)
// ---------------------------------------------------------------------
test('estimateCurrentPressureBar', async (t) => {
  await t.test('normal case: 6.0 bar baseline, 0.3 bar/day loss, 2 days elapsed -> 5.4 bar', () => {
    const { get } = loadApp();
    const estimateCurrentPressureBar = get('estimateCurrentPressureBar');
    const day = 86400000;
    const baselineAt = 1000 * day;
    const now = baselineAt + 2 * day;
    const result = estimateCurrentPressureBar(6.0, baselineAt, 0.3, now);
    assert.ok(Math.abs(result - 5.4) < 1e-9, `expected 5.4, got ${result}`);
  });

  await t.test('zero-floor clamp: large elapsed time / high rate does not go negative', () => {
    const { get } = loadApp();
    const estimateCurrentPressureBar = get('estimateCurrentPressureBar');
    const day = 86400000;
    const baselineAt = 1000 * day;
    const now = baselineAt + 10 * day; // 10 days elapsed
    const result = estimateCurrentPressureBar(6.0, baselineAt, 3, now); // 6.0 - 3*10 = -24 unclamped
    assert.equal(result, 0);
  });
});

// ---------------------------------------------------------------------
// isPressureLow(estimatedBar, targetBar, thresholdPercent)
// ---------------------------------------------------------------------
test('isPressureLow', async (t) => {
  await t.test('true case: estimated pressure below the threshold fraction of target', () => {
    const { get } = loadApp();
    const isPressureLow = get('isPressureLow');
    // target 6.0 * 85% = 5.1; estimated 5.0 < 5.1 -> low
    assert.equal(isPressureLow(5.0, 6.0, 85), true);
  });

  await t.test('false case at the boundary: estimated pressure exactly at the threshold fraction is NOT low (strict <)', () => {
    const { get } = loadApp();
    const isPressureLow = get('isPressureLow');
    // target 6.0 * 85% = 5.1 exactly; estimated 5.1 is not < 5.1
    assert.equal(isPressureLow(5.1, 6.0, 85), false);
  });
});
