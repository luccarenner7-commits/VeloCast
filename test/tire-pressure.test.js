'use strict';
// Tests for the Reifendruckrechner mit Reminder (tire pressure calculator)
// pure functions: computeTargetPressureBar, computeLossRateFractionPerDay,
// updateLearnedRateFractionPerDay, estimateCurrentPressureBar, isPressureLow,
// and the loadTirePressureData() migration path (see index.html's
// "---------- Reifendruckrechner mit Reminder ----------" section). Kept in
// its own file (separate from pure-functions.test.js) per the task brief --
// new feature, new file.
//
// The loss-rate model changed from linear (constant bar/day subtracted) to
// exponential decay (a constant FRACTION of current pressure lost per day) --
// physically, pressure loss through the tire wall is a diffusion process
// proportional to current pressure, so the linear model overestimated loss
// over longer periods. computeLossRateBarPerDay/updateLearnedRateBarPerDay
// were renamed to computeLossRateFractionPerDay/updateLearnedRateFractionPerDay
// accordingly (estimateCurrentPressureBar keeps its name -- only its 3rd
// parameter's meaning and the internal formula changed). Existing users'
// saved `learnedRateBarPerDay` values are migrated once by
// loadTirePressureData() -- see the dedicated test block below.
//
// Each test gets a FRESH app instance via loadApp() (see
// test/support/loadApp.js), matching the existing suite's per-test isolation
// convention, even though none of these functions read/write `state`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

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
// computeLossRateFractionPerDay(priorBar, measuredBar, hoursElapsed)
// fraction/day = ln(priorBar / measuredBar) / (hoursElapsed / 24)
// ---------------------------------------------------------------------
test('computeLossRateFractionPerDay', async (t) => {
  await t.test('normal case: 6.0 -> 5.4 bar over 48 hours (2 days) -> ~0.0526803 fraction/day', () => {
    const { get } = loadApp();
    const computeLossRateFractionPerDay = get('computeLossRateFractionPerDay');
    const result = computeLossRateFractionPerDay(6.0, 5.4, 48);
    // ln(6.0/5.4) = ln(10/9) = 0.10536051565782628
    // / (48/24) = / 2 = 0.05268025782891314
    assert.ok(Math.abs(result - 0.05268025782891314) < 1e-9, `expected ~0.05268025782891314, got ${result}`);
  });

  await t.test('zero hoursElapsed -> null (no divide-by-zero)', () => {
    const { get } = loadApp();
    const computeLossRateFractionPerDay = get('computeLossRateFractionPerDay');
    assert.equal(computeLossRateFractionPerDay(6.0, 5.4, 0), null);
  });

  await t.test('negative hoursElapsed -> null (guarded, not a negative-time result)', () => {
    const { get } = loadApp();
    const computeLossRateFractionPerDay = get('computeLossRateFractionPerDay');
    assert.equal(computeLossRateFractionPerDay(6.0, 5.4, -10), null);
  });

  await t.test('measuredBar of 0 -> null (guarded, ln(x/0) would be Infinity)', () => {
    const { get } = loadApp();
    const computeLossRateFractionPerDay = get('computeLossRateFractionPerDay');
    assert.equal(computeLossRateFractionPerDay(6.0, 0, 48), null);
  });

  await t.test('priorBar of 0 -> null (guarded, ln(0/x) would be -Infinity)', () => {
    const { get } = loadApp();
    const computeLossRateFractionPerDay = get('computeLossRateFractionPerDay');
    assert.equal(computeLossRateFractionPerDay(0, 5.4, 48), null);
  });

  await t.test('measuredBar > priorBar (mid-measurement top-up) -> negative fraction, NOT clamped here', () => {
    const { get } = loadApp();
    const computeLossRateFractionPerDay = get('computeLossRateFractionPerDay');
    const result = computeLossRateFractionPerDay(5.4, 6.0, 48);
    // ln(5.4/6.0) = ln(0.9) = -0.10536051565782628, / 2 = -0.05268025782891314
    // Unclamped by design -- clamping only happens in updateLearnedRateFractionPerDay.
    assert.ok(Math.abs(result - (-0.05268025782891314)) < 1e-9, `expected ~-0.05268025782891314, got ${result}`);
  });
});

// ---------------------------------------------------------------------
// updateLearnedRateFractionPerDay(oldRate, newRate, alpha = 0.3)
// ---------------------------------------------------------------------
test('updateLearnedRateFractionPerDay', async (t) => {
  await t.test('normal EMA update: oldRate 0.02, newRate 0.05 -> 0.029', () => {
    const { get } = loadApp();
    const updateLearnedRateFractionPerDay = get('updateLearnedRateFractionPerDay');
    const result = updateLearnedRateFractionPerDay(0.02, 0.05);
    // 0.3*0.05 + 0.7*0.02 = 0.015 + 0.014 = 0.029
    assert.ok(Math.abs(result - 0.029) < 1e-9, `expected 0.029, got ${result}`);
  });

  await t.test('sanity-clamp: an implausible 10 (1000%/day) reading is clamped to 0.5 before the EMA runs, not applied raw', () => {
    const { get } = loadApp();
    const updateLearnedRateFractionPerDay = get('updateLearnedRateFractionPerDay');
    const result = updateLearnedRateFractionPerDay(0.02, 10);
    // Unclamped, 10 would dominate the EMA (0.3*10+0.7*0.02 = 3.014).
    // Clamped to TIRE_PRESSURE_MAX_FRACTION_PER_DAY=0.5 first: 0.3*0.5+0.7*0.02 = 0.164.
    assert.ok(Math.abs(result - 0.164) < 1e-9, `expected 0.164 (clamped), got ${result}`);
  });

  await t.test('sanity-clamp: a negative ("gain") reading is clamped to 0 before the EMA runs', () => {
    const { get } = loadApp();
    const updateLearnedRateFractionPerDay = get('updateLearnedRateFractionPerDay');
    const result = updateLearnedRateFractionPerDay(0.04, -2);
    // Clamped to 0: 0.3*0+0.7*0.04 = 0.028.
    assert.ok(Math.abs(result - 0.028) < 1e-9, `expected 0.028 (clamped), got ${result}`);
  });
});

// ---------------------------------------------------------------------
// estimateCurrentPressureBar(lastBaselineBar, lastBaselineAtMs, learnedRateFractionPerDay, nowMs)
// bar(t) = lastBaselineBar * (1 - learnedRateFractionPerDay) ^ daysElapsed
// ---------------------------------------------------------------------
test('estimateCurrentPressureBar', async (t) => {
  await t.test('normal case: 6.0 bar baseline, 5%/day fractional loss, 2 days elapsed -> 5.415 bar', () => {
    const { get } = loadApp();
    const estimateCurrentPressureBar = get('estimateCurrentPressureBar');
    const day = 86400000;
    const baselineAt = 1000 * day;
    const now = baselineAt + 2 * day;
    const result = estimateCurrentPressureBar(6.0, baselineAt, 0.05, now);
    // 6.0 * (1 - 0.05)^2 = 6.0 * 0.95^2 = 6.0 * 0.9025 = 5.415
    assert.ok(Math.abs(result - 5.415) < 1e-9, `expected 5.415, got ${result}`);
  });

  await t.test('zero-floor clamp: an (unclamped, direct-call) rate above 100%/day does not go negative', () => {
    const { get } = loadApp();
    const estimateCurrentPressureBar = get('estimateCurrentPressureBar');
    const day = 86400000;
    const baselineAt = 1000 * day;
    const now = baselineAt + 1 * day; // 1 day elapsed (integer exponent keeps the math well-defined)
    const result = estimateCurrentPressureBar(6.0, baselineAt, 2, now);
    // (1 - 2)^1 = -1 -> 6.0 * -1 = -6.0 unclamped -> Math.max(0, -6.0) = 0
    assert.equal(result, 0);
  });

  await t.test('zero rate -> pressure stays exactly at baseline regardless of elapsed time', () => {
    const { get } = loadApp();
    const estimateCurrentPressureBar = get('estimateCurrentPressureBar');
    const day = 86400000;
    const baselineAt = 1000 * day;
    const now = baselineAt + 100 * day;
    const result = estimateCurrentPressureBar(6.0, baselineAt, 0, now);
    // 6.0 * (1 - 0)^100 = 6.0 * 1 = 6.0
    assert.equal(result, 6.0);
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
    w.learnedRateFractionPerDay = 0; // isolate the target/threshold comparison from loss-rate decay
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
    return { lastBaselineBar: 6.0, lastBaselineAtMs: Date.now() - 48 * 3600000, learnedRateFractionPerDay: 0.02, history: [] };
  }

  await t.test('Gemessen and Neu both filled -- unchanged behavior: rate learning happens, history gets an entry', () => {
    const { get } = loadApp();
    const applyNachmessenUpdate = get('applyNachmessenUpdate');
    const w = wheelWithBaseline();
    const now = Date.now();
    const changed = applyNachmessenUpdate(w, 5.4, 6.2, now); // 6.0 -> 5.4 bar over ~48h
    // rate = ln(6.0/5.4) / (48/24) = ln(10/9) / 2 = 0.10536051565782628 / 2 = 0.05268025782891314
    // EMA: 0.3*0.05268025782891314 + 0.7*0.02 = 0.015804077348673942 + 0.014 = 0.029804077348673942
    assert.equal(changed, true);
    assert.equal(w.lastBaselineBar, 6.2);
    assert.equal(w.lastBaselineAtMs, now);
    assert.ok(Math.abs(w.learnedRateFractionPerDay - 0.029804077348673942) < 1e-9, `expected learnedRateFractionPerDay ~0.0298041, got ${w.learnedRateFractionPerDay}`);
    assert.equal(w.history.length, 1);
    assert.equal(w.history[0].measuredBar, 5.4);
    assert.equal(w.history[0].priorBar, 6.0);
    assert.ok(Math.abs(w.history[0].rateFractionPerDay - 0.05268025782891314) < 1e-9);
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
    assert.equal(w.learnedRateFractionPerDay, 0.02); // untouched
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

// ---------------------------------------------------------------------
// loadTirePressureData() migration: existing users' saved data may still
// carry the old linear-model field `learnedRateBarPerDay` from before the
// switch to the exponential/fractional model (see index.html's
// loadTirePressureData()). This must be converted to an approximate
// fraction/day ONCE (no reset, no loss of learning progress) and the stale
// field must never linger in the returned object afterwards.
//
// Needs test/support/loadApp.js's `initialLocalStorage` option (same
// mechanism as settings-migration.test.js) since loadTirePressureData() is
// called at the app's top-level script evaluation (`state.tirePressure =
// loadTirePressureData()`) -- but here it's re-invoked directly via `get()`
// after load, since the sandboxed localStorage stub it reads from is the
// same in-memory instance either way and calling the function directly names
// exactly what's under test.
// ---------------------------------------------------------------------
test('loadTirePressureData migration (learnedRateBarPerDay -> learnedRateFractionPerDay)', async (t) => {
  function tireBlob(front, rear){
    return { velocast_tire_pressure: JSON.stringify({ front: front || {}, rear: rear || {} }) };
  }

  await t.test('old data WITH learnedRateBarPerDay AND lastBaselineBar set -> converted correctly, old field gone', () => {
    const { get } = loadApp({
      initialLocalStorage: tireBlob({ lastBaselineBar: 6.0, lastBaselineAtMs: 12345, learnedRateBarPerDay: 0.3, history: [] }),
    });
    const loadTirePressureData = get('loadTirePressureData');
    const result = loadTirePressureData();
    // converted = learnedRateBarPerDay / lastBaselineBar = 0.3 / 6.0 = 0.05
    assert.ok(Math.abs(result.front.learnedRateFractionPerDay - 0.05) < 1e-9, `expected ~0.05, got ${result.front.learnedRateFractionPerDay}`);
    assert.equal(Object.prototype.hasOwnProperty.call(result.front, 'learnedRateBarPerDay'), false);
    assert.equal(result.front.lastBaselineBar, 6.0);
  });

  await t.test('old data WITH learnedRateBarPerDay but WITHOUT lastBaselineBar (never pumped up) -> falls back to the new default, no crash', () => {
    const { get } = loadApp({
      initialLocalStorage: tireBlob({ learnedRateBarPerDay: 0.3, lastBaselineBar: null, history: [] }),
    });
    const loadTirePressureData = get('loadTirePressureData');
    const TIRE_PRESSURE_DEFAULT_RATE_FRACTION_PER_DAY = get('TIRE_PRESSURE_DEFAULT_RATE_FRACTION_PER_DAY');
    const result = loadTirePressureData();
    assert.equal(result.front.learnedRateFractionPerDay, TIRE_PRESSURE_DEFAULT_RATE_FRACTION_PER_DAY);
    assert.equal(Object.prototype.hasOwnProperty.call(result.front, 'learnedRateBarPerDay'), false);
  });

  await t.test('data already in the new format (has learnedRateFractionPerDay already) -> stays unchanged, no double-conversion', () => {
    const { get } = loadApp({
      initialLocalStorage: tireBlob({ lastBaselineBar: 6.0, lastBaselineAtMs: 12345, learnedRateFractionPerDay: 0.07, history: [] }),
    });
    const loadTirePressureData = get('loadTirePressureData');
    const result = loadTirePressureData();
    assert.equal(result.front.learnedRateFractionPerDay, 0.07);
    assert.equal(Object.prototype.hasOwnProperty.call(result.front, 'learnedRateBarPerDay'), false);
  });

  await t.test('completely fresh/empty data (first install) -> default as before', () => {
    const { get } = loadApp(); // no seeded localStorage at all
    const loadTirePressureData = get('loadTirePressureData');
    const defaultTireWheelData = get('defaultTireWheelData');
    const result = loadTirePressureData();
    assert.deepEqual(plain(result.front), plain(defaultTireWheelData()));
    assert.deepEqual(plain(result.rear), plain(defaultTireWheelData()));
  });
});
