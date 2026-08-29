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
  await t.test('25mm, 75kg total, road, non-tubeless, front -> 4.9 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 25, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 4.9);
  });

  await t.test('width falls off faster than linear: 30mm, 75kg, road, front -> 3.9 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 30, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 3.9);
  });

  await t.test('weight-scaled (sub-linear): 25mm, 90kg total instead of 75kg -> 5.3 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 85, bikeWeightKg: 5, tireWidthMm: 25, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 5.3);
  });

  await t.test('terrain factor: gravel (x0.85) on 32mm/75kg -> 3.0 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 32, tubeless: false, terrain: 'gravel', wheel: 'front' });
    assert.equal(result, 3.0);
  });

  await t.test('terrain factor: offroad (x0.7) on 32mm/75kg -> 2.5 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 32, tubeless: false, terrain: 'offroad', wheel: 'front' });
    assert.equal(result, 2.5);
  });

  await t.test('tubeless factor: 25mm/75kg/road tubeless (x0.9) -> 4.4 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 25, tubeless: true, terrain: 'road', wheel: 'front' });
    assert.equal(result, 4.4);
  });

  await t.test('wheel factor: rear (x1.065) on the same 25mm/75kg/road/non-tubeless setup as the front test -> 5.2 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const front = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 25, tubeless: false, terrain: 'road', wheel: 'front' });
    const rear = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 25, tubeless: false, terrain: 'road', wheel: 'rear' });
    assert.equal(front, 4.9);
    assert.equal(rear, 5.2);
  });

  await t.test('width clamp: below 23mm clamps to the 23mm endpoint -> 5.5 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 10, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 5.5);
  });

  await t.test('width clamp: above 55mm clamps to the 55mm endpoint -> 1.8 bar', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 70, bikeWeightKg: 5, tireWidthMm: 70, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 1.8);
  });

  await t.test('final clamp: an extreme heavy rider pushes the raw result above 9.0 -> clamped to 9.0', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 400, bikeWeightKg: 50, tireWidthMm: 23, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 9.0);
  });

  await t.test('final clamp: an extreme light rider pushes the raw result below 1.5 -> clamped to 1.5', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const result = computeTargetPressureBar({ riderWeightKg: 15, bikeWeightKg: 5, tireWidthMm: 55, tubeless: false, terrain: 'road', wheel: 'front' });
    assert.equal(result, 1.5);
  });

  // Real-world calibration: values from SRAM's published tire pressure
  // calculator (hooked/tubed unless noted), 84kg/9.4kg or 60kg/9.4kg
  // rider/bike, road. Our formula was fitted to these and should land
  // within a rounding step.
  await t.test('SRAM calibration: 35mm, 84kg+9.4kg, tubed -> front 3.5, rear 3.7 (SRAM: 3.49/3.71)', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const front = computeTargetPressureBar({ riderWeightKg: 84, bikeWeightKg: 9.4, tireWidthMm: 35, tubeless: false, terrain: 'road', wheel: 'front' });
    const rear = computeTargetPressureBar({ riderWeightKg: 84, bikeWeightKg: 9.4, tireWidthMm: 35, tubeless: false, terrain: 'road', wheel: 'rear' });
    assert.equal(front, 3.5);
    assert.equal(rear, 3.7);
  });

  await t.test('SRAM calibration: 47mm, 84kg+9.4kg, tubed -> front 2.4, rear 2.5 (SRAM: 2.39/2.55)', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const front = computeTargetPressureBar({ riderWeightKg: 84, bikeWeightKg: 9.4, tireWidthMm: 47, tubeless: false, terrain: 'road', wheel: 'front' });
    const rear = computeTargetPressureBar({ riderWeightKg: 84, bikeWeightKg: 9.4, tireWidthMm: 47, tubeless: false, terrain: 'road', wheel: 'rear' });
    assert.equal(front, 2.4);
    assert.equal(rear, 2.5);
  });

  await t.test('SRAM calibration: 47mm, 60kg+9.4kg, tubed -> front 2.1, rear 2.2 (SRAM: 2.10/2.23)', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const front = computeTargetPressureBar({ riderWeightKg: 60, bikeWeightKg: 9.4, tireWidthMm: 47, tubeless: false, terrain: 'road', wheel: 'front' });
    const rear = computeTargetPressureBar({ riderWeightKg: 60, bikeWeightKg: 9.4, tireWidthMm: 47, tubeless: false, terrain: 'road', wheel: 'rear' });
    assert.equal(front, 2.1);
    assert.equal(rear, 2.2);
  });

  await t.test('SRAM calibration: 35mm, 84kg+9.4kg, tubeless -> front 3.1, rear 3.3 (SRAM: 3.17/3.38)', () => {
    const { get } = loadApp();
    const computeTargetPressureBar = get('computeTargetPressureBar');
    const front = computeTargetPressureBar({ riderWeightKg: 84, bikeWeightKg: 9.4, tireWidthMm: 35, tubeless: true, terrain: 'road', wheel: 'front' });
    const rear = computeTargetPressureBar({ riderWeightKg: 84, bikeWeightKg: 9.4, tireWidthMm: 35, tubeless: true, terrain: 'road', wheel: 'rear' });
    assert.equal(front, 3.1);
    assert.equal(rear, 3.3);
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
