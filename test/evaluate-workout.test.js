'use strict';
// Tests for evaluateWorkout() -- compares a completed activity's raw stream
// against a workout's planned steps (see index.html's own comment above the
// function). Flagged as a coverage gap by a full-app audit (04.09.2026):
// pure, no DOM/network, but had zero direct tests despite feeding the
// adaptive-learning pipeline (recordEvaluation()) and the trainer's
// post-workout evaluation UI. Not exhaustive over every threshold in
// classIntervalVerdict()/complianceVerdict() (those are their own,
// separately-reasoned pieces) -- focused on evaluateWorkout()'s own job:
// correctly matching stream data to steps (by time vs. by distance), the
// watts-vs-heartrate branch, and RPE-step exclusion from compliance.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

test('evaluateWorkout', async (t) => {
  await t.test('route-based workout (steps carry startDist) with no distance stream -> null', () => {
    const { get } = loadApp();
    const evaluateWorkout = get('evaluateWorkout');
    const workout = { steps: [{ startDist: 0, endDist: 1000, distanceM: 1000, pct: 0.9, kind: 'interval' }], classKey: 'threshold', totalDistanceM: 1000 };
    const rp = { usingHr: false, ftp: 200 };
    const stream = { time: [0, 10, 20, 30], watts: [180, 180, 180, 180] }; // no `distance` array
    assert.equal(evaluateWorkout(stream, workout, rp), null);
  });

  await t.test('time-based workout with no watts stream (and not using HR) -> null', () => {
    const { get } = loadApp();
    const evaluateWorkout = get('evaluateWorkout');
    const workout = { steps: [{ minutes: 10, pct: 0.9, kind: 'interval' }] };
    const rp = { usingHr: false, ftp: 200 };
    const stream = { time: [0, 200, 400, 600] }; // no `watts` array
    assert.equal(evaluateWorkout(stream, workout, rp), null);
  });

  await t.test('fewer than 4 stream samples -> null, regardless of shape being otherwise valid', () => {
    const { get } = loadApp();
    const evaluateWorkout = get('evaluateWorkout');
    const workout = { steps: [{ minutes: 1, pct: 0.9, kind: 'interval' }] };
    const rp = { usingHr: false, ftp: 200 };
    const stream = { time: [0, 30], watts: [180, 180] };
    assert.equal(evaluateWorkout(stream, workout, rp), null);
  });

  await t.test('time-based, watts-based: matches by elapsed time and computes achievedPct against %FTP', () => {
    const { get } = loadApp();
    const evaluateWorkout = get('evaluateWorkout');
    const workout = { steps: [{ minutes: 10, pct: 0.9, kind: 'interval' }], classKey: 'threshold' };
    const rp = { usingHr: false, ftp: 200 };
    const stream = { time: [0, 200, 400, 600], watts: [180, 180, 180, 180] };
    const result = evaluateWorkout(stream, workout, rp);
    assert.equal(result.perStep.length, 1);
    assert.equal(result.perStep[0].targetWatts, 180); // 0.9 * 200
    assert.equal(result.perStep[0].actualWatts, 180);
    assert.equal(result.perStep[0].achievedPct, 1);
    assert.equal(result.perStep[0].span, 600);
    assert.equal(result.complianceWeighted, 1);
    assert.equal(result.verdict, 'Ziel getroffen');
    assert.equal(result.actualTotal, 600);
    assert.equal(result.mismatchPct, 0, 'planned (10min=600s) exactly matches the actual stream length');
  });

  await t.test('route-based: matches by distance instead of time, distance exactly at a step boundary is excluded (half-open range)', () => {
    const { get } = loadApp();
    const evaluateWorkout = get('evaluateWorkout');
    const workout = { steps: [{ startDist: 0, endDist: 1000, distanceM: 1000, pct: 0.9, kind: 'interval' }], classKey: 'threshold', totalDistanceM: 1000 };
    const rp = { usingHr: false, ftp: 200 };
    const stream = { distance: [0, 300, 600, 1000], watts: [180, 180, 180, 999] }; // last point (999W) sits exactly ON the boundary
    const result = evaluateWorkout(stream, workout, rp);
    assert.equal(result.isRoute, true);
    assert.equal(result.perStep[0].actualWatts, 180, 'the boundary point (distance===endDist) must be excluded from the average, not just the wildly different value at it');
    assert.equal(result.perStep[0].achievedPct, 1);
  });

  await t.test('usingHr: matches primary stream key "heartrate" and computes target from %LTHR instead of %FTP', () => {
    const { get } = loadApp();
    const evaluateWorkout = get('evaluateWorkout');
    const workout = { steps: [{ minutes: 5, pct: 0.9, kind: 'interval' }], classKey: 'threshold' };
    const rp = { usingHr: true, lthr: 150, ftp: 200 }; // ftp present but must be ignored while usingHr
    const stream = { time: [0, 100, 200, 300], heartrate: [135, 135, 135, 135] };
    const result = evaluateWorkout(stream, workout, rp);
    assert.equal(result.perStep[0].targetHr, 135); // 0.9 * 150
    assert.equal(result.perStep[0].targetWatts, null);
    assert.equal(result.perStep[0].actualHr, 135);
    assert.equal(result.perStep[0].achievedPct, 1);
  });

  await t.test('an RPE-tagged step has no target/achievedPct (measured watts/HR still carried through) and is excluded from compliance weighting', () => {
    const { get } = loadApp();
    const evaluateWorkout = get('evaluateWorkout');
    const workout = {
      steps: [
        { minutes: 1, pct: 0, kind: 'interval', rpeLabel: 'Sprint' }, // wild measured value, must not affect anything below
        { minutes: 1, pct: 0.9, kind: 'interval' },
      ],
      classKey: 'threshold',
    };
    const rp = { usingHr: false, ftp: 200 };
    // RPE step (0-60s): 999W measured. Real step (60-120s): 180W measured (=0.9*200, on target).
    const stream = { time: [0, 40, 80, 120], watts: [999, 999, 180, 180] };
    const result = evaluateWorkout(stream, workout, rp);
    const [rpeStep, realStep] = result.perStep;
    assert.equal(rpeStep.actualWatts, 999, 'measured watts during the RPE step are still recorded');
    assert.equal(rpeStep.targetWatts, null);
    assert.equal(rpeStep.achievedPct, null);
    assert.equal(realStep.achievedPct, 1);
    // Only the real step should count toward compliance -- if the RPE
    // step's wild 999W leaked in, complianceWeighted would be far above 1.
    assert.equal(result.complianceWeighted, 1);
    assert.equal(result.classCompliance.rows.length, 1, 'the RPE step must not appear in summarizeClassCompliance()\'s rows either');
    assert.equal(result.classCompliance.rows[0].actualValue, 180);
  });

  await t.test('no classKey -> classCompliance is null', () => {
    const { get } = loadApp();
    const evaluateWorkout = get('evaluateWorkout');
    const workout = { steps: [{ minutes: 10, pct: 0.9, kind: 'interval' }] }; // no classKey
    const rp = { usingHr: false, ftp: 200 };
    const stream = { time: [0, 200, 400, 600], watts: [180, 180, 180, 180] };
    assert.equal(evaluateWorkout(stream, workout, rp).classCompliance, null);
  });

  await t.test('classKey "test" -> classCompliance is deliberately null (own confirmation flow handles pass/fail instead)', () => {
    const { get } = loadApp();
    const evaluateWorkout = get('evaluateWorkout');
    const workout = { steps: [{ minutes: 10, pct: 0.9, kind: 'interval' }], classKey: 'test' };
    const rp = { usingHr: false, ftp: 200 };
    const stream = { time: [0, 200, 400, 600], watts: [180, 180, 180, 180] };
    assert.equal(evaluateWorkout(stream, workout, rp).classCompliance, null);
  });

  await t.test('mismatchPct reflects a ride that stopped short of the planned duration', () => {
    const { get } = loadApp();
    const evaluateWorkout = get('evaluateWorkout');
    const workout = { steps: [{ minutes: 10, pct: 0.9, kind: 'interval' }] }; // planned: 600s
    const rp = { usingHr: false, ftp: 200 };
    const stream = { time: [0, 150, 300, 500], watts: [180, 180, 180, 180] }; // actual: 500s
    const result = evaluateWorkout(stream, workout, rp);
    assert.equal(result.actualTotal, 500);
    assert.ok(Math.abs(result.mismatchPct - (100/600*100)) < 1e-9, `expected ~16.67%, got ${result.mismatchPct}`);
  });
});
