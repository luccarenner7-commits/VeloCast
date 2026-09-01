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

// ---------------------------------------------------------------------
// getWheelTargetBar(data, wheel) -- calculator on/off toggle (Nachtrag)
// ---------------------------------------------------------------------
test('getWheelTargetBar', async (t) => {
  await t.test('calculator on (default): returns computeTargetPressureBar\'s result', () => {
    const { get } = loadApp();
    const getWheelTargetBar = get('getWheelTargetBar');
    const defaultTirePressureData = get('defaultTirePressureData');
    const data = defaultTirePressureData();
    data.settings.riderWeightKg = 70;
    data.settings.bikeWeightKg = 5;
    data.settings.tireWidthMm = 25;
    const result = getWheelTargetBar(data, 'front');
    assert.equal(result, 4.9); // matches the 25mm/75kg/road/front computeTargetPressureBar test above
  });

  await t.test('calculator off, manual target set: returns the manual value, ignores rider/bike/tire settings', () => {
    const { get } = loadApp();
    const getWheelTargetBar = get('getWheelTargetBar');
    const defaultTirePressureData = get('defaultTirePressureData');
    const data = defaultTirePressureData();
    data.settings.calculatorEnabled = false;
    data.settings.riderWeightKg = 70; // present but must be ignored while calc is off
    data.front.manualTargetBar = 3.2;
    const result = getWheelTargetBar(data, 'front');
    assert.equal(result, 3.2);
  });

  await t.test('calculator off, no manual target entered yet: returns null', () => {
    const { get } = loadApp();
    const getWheelTargetBar = get('getWheelTargetBar');
    const defaultTirePressureData = get('defaultTirePressureData');
    const data = defaultTirePressureData();
    data.settings.calculatorEnabled = false;
    const result = getWheelTargetBar(data, 'front');
    assert.equal(result, null);
  });

  await t.test('front and rear track independent manual targets while calculator is off', () => {
    const { get } = loadApp();
    const getWheelTargetBar = get('getWheelTargetBar');
    const defaultTirePressureData = get('defaultTirePressureData');
    const data = defaultTirePressureData();
    data.settings.calculatorEnabled = false;
    data.front.manualTargetBar = 3.2;
    data.rear.manualTargetBar = 3.5;
    assert.equal(getWheelTargetBar(data, 'front'), 3.2);
    assert.equal(getWheelTargetBar(data, 'rear'), 3.5);
  });
});

// ---------------------------------------------------------------------
// computeTirePressureReminder(data) -- calculator on/off gating (Nachtrag)
// ---------------------------------------------------------------------
test('computeTirePressureReminder', async (t) => {
  function baselineDaysAgo(w, bar, days){
    w.lastBaselineBar = bar;
    w.lastBaselineAtMs = Date.now() - days * 86400000;
    w.learnedRateBarPerDay = 0; // isolate the target/threshold comparison from loss-rate decay
  }

  await t.test('calculator off, manual target set, estimated below threshold -> low', () => {
    const { get } = loadApp();
    const computeTirePressureReminder = get('computeTirePressureReminder');
    const defaultTirePressureData = get('defaultTirePressureData');
    const data = defaultTirePressureData();
    data.settings.calculatorEnabled = false;
    data.settings.reminderThresholdPercent = 85;
    data.front.manualTargetBar = 6.0;
    baselineDaysAgo(data.front, 5.0, 1); // 5.0 < 6.0*0.85=5.1 -> low
    const result = computeTirePressureReminder(data);
    assert.equal(result.front, true);
    assert.equal(result.rear, false);
  });

  await t.test('calculator off, no manual target yet -> never flagged low, even with a baseline logged', () => {
    const { get } = loadApp();
    const computeTirePressureReminder = get('computeTirePressureReminder');
    const defaultTirePressureData = get('defaultTirePressureData');
    const data = defaultTirePressureData();
    data.settings.calculatorEnabled = false;
    baselineDaysAgo(data.front, 1.0, 30); // would be "low" against any real target, but there is none
    const result = computeTirePressureReminder(data);
    assert.equal(result.front, false);
  });

  await t.test('calculator off: rider/bike/tire settings being unset does NOT gate the reminder (unlike calculator-on mode)', () => {
    const { get } = loadApp();
    const computeTirePressureReminder = get('computeTirePressureReminder');
    const defaultTirePressureData = get('defaultTirePressureData');
    const data = defaultTirePressureData();
    data.settings.calculatorEnabled = false;
    // riderWeightKg/bikeWeightKg/tireWidthMm left null, unlike the calculator-on case
    data.front.manualTargetBar = 6.0;
    baselineDaysAgo(data.front, 5.0, 1);
    const result = computeTirePressureReminder(data);
    assert.equal(result.front, true);
  });

  await t.test('calculator on (default): unchanged behavior, still gated on rider/bike/tire settings being filled in', () => {
    const { get } = loadApp();
    const computeTirePressureReminder = get('computeTirePressureReminder');
    const defaultTirePressureData = get('defaultTirePressureData');
    const data = defaultTirePressureData();
    // settings left empty -> not ready, even with a baseline logged
    baselineDaysAgo(data.front, 1.0, 30);
    const result = computeTirePressureReminder(data);
    assert.equal(result.front, false);
  });
});

// ---------------------------------------------------------------------
// applyNachmessenUpdate(w, measured, neu, now) -- "Nachmessen & neu
// aufpumpen" button logic (see buildTireWheelCard). Folds the old
// standalone "Aufgepumpt" reset into this same button for the
// already-has-a-baseline case: with Gemessen filled in, behaves exactly as
// before (loss-rate learning + history entry); with Gemessen left empty, it
// still resets the baseline from "Neu aufgepumpt auf" but skips all of the
// rate-learning/history side effects.
// ---------------------------------------------------------------------
test('applyNachmessenUpdate', async (t) => {
  function wheelWithBaseline(){
    return { lastBaselineBar: 6.0, lastBaselineAtMs: Date.now() - 48 * 3600000, learnedRateBarPerDay: 0.15, history: [] };
  }

  await t.test('Gemessen and Neu both filled -- unchanged behavior: rate learning happens, history gets an entry', () => {
    const { get } = loadApp();
    const applyNachmessenUpdate = get('applyNachmessenUpdate');
    const w = wheelWithBaseline();
    const now = Date.now();
    const changed = applyNachmessenUpdate(w, 5.4, 6.2, now); // 0.6 bar lost over 48h -> 0.3 bar/day
    assert.equal(changed, true);
    assert.equal(w.lastBaselineBar, 6.2);
    assert.equal(w.lastBaselineAtMs, now);
    // EMA: 0.3*0.3 + 0.7*0.15 = 0.195
    assert.ok(Math.abs(w.learnedRateBarPerDay - 0.195) < 1e-9, `expected learnedRateBarPerDay ~0.195, got ${w.learnedRateBarPerDay}`);
    assert.equal(w.history.length, 1);
    assert.equal(w.history[0].measuredBar, 5.4);
    assert.equal(w.history[0].priorBar, 6.0);
  });

  await t.test('Gemessen empty/NaN, Neu filled -- baseline updates, NO rate learning, NO history entry', () => {
    const { get } = loadApp();
    const applyNachmessenUpdate = get('applyNachmessenUpdate');
    const w = wheelWithBaseline();
    const now = Date.now();
    const changed = applyNachmessenUpdate(w, NaN, 6.2, now);
    assert.equal(changed, true);
    assert.equal(w.lastBaselineBar, 6.2);
    assert.equal(w.lastBaselineAtMs, now);
    assert.equal(w.learnedRateBarPerDay, 0.15); // untouched
    assert.equal(w.history.length, 0);
  });

  await t.test('Neu invalid (empty/NaN) -- no-op, nothing changes, regardless of Gemessen', () => {
    const { get } = loadApp();
    const applyNachmessenUpdate = get('applyNachmessenUpdate');
    const w = wheelWithBaseline();
    const before = JSON.parse(JSON.stringify(w));
    const changed = applyNachmessenUpdate(w, 5.4, NaN, Date.now());
    assert.equal(changed, false);
    assert.deepEqual(w, before);
  });

  await t.test('Neu invalid (0) -- no-op, nothing changes', () => {
    const { get } = loadApp();
    const applyNachmessenUpdate = get('applyNachmessenUpdate');
    const w = wheelWithBaseline();
    const before = JSON.parse(JSON.stringify(w));
    const changed = applyNachmessenUpdate(w, 5.4, 0, Date.now());
    assert.equal(changed, false);
    assert.deepEqual(w, before);
  });

  await t.test('Neu invalid (negative) -- no-op, nothing changes, even with Gemessen empty', () => {
    const { get } = loadApp();
    const applyNachmessenUpdate = get('applyNachmessenUpdate');
    const w = wheelWithBaseline();
    const before = JSON.parse(JSON.stringify(w));
    const changed = applyNachmessenUpdate(w, NaN, -1, Date.now());
    assert.equal(changed, false);
    assert.deepEqual(w, before);
  });
});
