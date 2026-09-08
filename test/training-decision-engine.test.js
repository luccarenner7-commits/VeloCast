'use strict';
// Training Decision Engine (index.html, functions between classPerformanceScores()
// and computeTrainingOpportunity(), ~lines 8858-9054): decides which of the 8
// TRAINING_CLASSES a rider should train today, how urgently (priority tier),
// how much of it per week (budget), and whether the attached route can
// actually host it (suitability). One of the two hardest-remaining gaps in
// the 2026-09 test-coverage audit -- previously untested because building a
// realistic multi-week ride-history fixture that exercises both the current
// week's progress AND the 4-week neglect lookback simultaneously takes real
// effort, not because the functions are simple.
//
// `results` rows use the shape weeklyClassProgress()/trainedOnDate() actually
// read: { date, movingMin?, metrics?: { zoneTimes: number[7], intervalZoneTimes?:
// number[7] } }. Zone index mapping (TRAINING_CLASSES' own zoneIdx):
//   0 recovery, 1 endurance, 2 tempo, 3 threshold, 4 vo2max, 5 anaerobic, 6 sprint
// (longdistance has zoneIdx:null, tallied instead via movingMin>=config.longRideMinMinutes;
// sprint's raw zone-6 minutes get divided by config.sprintMinutesPerEffort and
// rounded to an effort count.)
//
// All fixture dates are anchored to a fixed TODAY_ISO (a Wednesday), never to
// the real clock, so every test is deterministic regardless of when it runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

const TODAY_ISO = '2026-09-09'; // a Wednesday

// TRAINING_CLASSES is a top-level `const` array, which -- unlike a
// top-level `function` declaration -- doesn't auto-attach to the vm
// sandbox's global object, so it had to be added explicitly to loadApp.js's
// `__exposed` list (see that file's own comment) to be reachable via
// get('TRAINING_CLASSES') at all. Now that it is, read the key list
// straight from the real array below instead of duplicating it by hand,
// which would silently drift if index.html's TRAINING_CLASSES ever changes.

function parseIsoDateUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}
function toIsoDate(d) { return d.toISOString().slice(0, 10); }
function addDaysUTC(d, n) { const out = new Date(d); out.setUTCDate(out.getUTCDate() + n); return out; }
function mondayOfUTC(d) { const day = (d.getUTCDay() + 6) % 7; return addDaysUTC(d, -day); }
const TODAY_MONDAY = mondayOfUTC(parseIsoDateUTC(TODAY_ISO));

// An ISO date `weeksAgo` full weeks before TODAY_ISO's own Monday, offset by
// `dayOffset` days into that week (default: Wednesday of that week) --
// mirrors test/chain-wear.test.js's isoDaysAgo() helper, but anchored to a
// fixed reference date instead of Date.now() so weekly-boundary fixtures
// stay deterministic.
function weekDateIso(weeksAgo, dayOffset) {
  return toIsoDate(addDaysUTC(TODAY_MONDAY, -7 * weeksAgo + (dayOffset == null ? 2 : dayOffset)));
}

// Builds a 7-element zoneTimes array (seconds) using the exact indexing
// convention test/pure-functions.test.js's rideZoneBreakdown tests use
// (`new Array(7).fill(0); zoneTimes[i] = seconds;`), from a
// { zoneIdx: seconds } map for readability.
function zoneTimesFrom(map) {
  const zt = new Array(7).fill(0);
  Object.entries(map).forEach(([idx, sec]) => { zt[Number(idx)] = sec; });
  return zt;
}

// A single ride that comfortably clears every priority-eligible class's
// LOW-tier weekly floor at once (see TRAINING_CONFIG's weekly*ByPriority.LOW
// tables and classNeglectWeeks()'s floorFraction=0.5) -- used to build
// "well-trained" past weeks that neutralize the neglect boost, so
// computeTrainingPriorities()'s score/baseline mapping can be tested against
// known tier boundaries in isolation from the neglect mechanism.
function wellTrainedRide(dateIso, overrides) {
  const zoneTimes = zoneTimesFrom({ 1: 200 * 60, 2: 40 * 60, 3: 40 * 60, 4: 10 * 60, 5: 6 * 60, 6: 3 * 60 });
  return Object.assign({ date: dateIso, movingMin: 200, metrics: { zoneTimes } }, overrides || {});
}

test('classPerformanceScores', async (t) => {
  await t.test('no items -> every class scores 0 with a null "why"', () => {
    const { get } = loadApp();
    const classPerformanceScores = get('classPerformanceScores');
    const scores = classPerformanceScores({ items: [] });
    get('TRAINING_CLASSES').map((c) => c.key)
      .forEach((key) => assert.deepEqual(plain(scores[key]), { score: 0, why: null }));
  });

  await t.test('goal "ftp" remaps to the "threshold" class', () => {
    const { get } = loadApp();
    const classPerformanceScores = get('classPerformanceScores');
    const scores = classPerformanceScores({ items: [{ goal: 'ftp', area: 'x', score: 40, why: 'ftp weakness' }] });
    assert.deepEqual(plain(scores.threshold), { score: 40, why: 'ftp weakness' });
  });

  await t.test('goal "endurance" + area "Ermüdungsresistenz" remaps to "longdistance", but a plain endurance item does not', () => {
    const { get } = loadApp();
    const classPerformanceScores = get('classPerformanceScores');
    const scores = classPerformanceScores({
      items: [
        { goal: 'endurance', area: 'Ermüdungsresistenz', score: 30, why: 'fatigue resistance' },
        { goal: 'endurance', area: 'Grundlagenausdauer', score: 20, why: 'plain endurance' },
      ],
    });
    assert.deepEqual(plain(scores.longdistance), { score: 30, why: 'fatigue resistance' });
    assert.deepEqual(plain(scores.endurance), { score: 20, why: 'plain endurance' });
  });

  await t.test('multiple items mapping to the same class: the strongest score wins', () => {
    const { get } = loadApp();
    const classPerformanceScores = get('classPerformanceScores');
    const scores = classPerformanceScores({
      items: [
        { goal: 'vo2max', area: 'a', score: 10, why: 'weaker' },
        { goal: 'vo2max', area: 'b', score: 50, why: 'stronger' },
        { goal: 'vo2max', area: 'c', score: 25, why: 'middling' },
      ],
    });
    assert.deepEqual(plain(scores.vo2max), { score: 50, why: 'stronger' });
  });

  await t.test('an item whose goal doesn\'t match any known class key is silently ignored, not crashing', () => {
    const { get } = loadApp();
    const classPerformanceScores = get('classPerformanceScores');
    const scores = classPerformanceScores({ items: [{ goal: 'not-a-real-goal', area: 'z', score: 99, why: 'ignored' }] });
    Object.values(plain(scores)).forEach((s) => assert.equal(s.score, 0));
  });

  await t.test('missing/malformed weaknessData (no .items) -> all zero, not a crash', () => {
    const { get } = loadApp();
    const classPerformanceScores = get('classPerformanceScores');
    const scores = classPerformanceScores({});
    Object.values(plain(scores)).forEach((s) => assert.equal(s.score, 0));
    const scores2 = classPerformanceScores(null);
    Object.values(plain(scores2)).forEach((s) => assert.equal(s.score, 0));
  });
});

test('weeklyClassProgress', async (t) => {
  await t.test('tallies zoneTimes (seconds -> minutes) per class within the current week, plus long-ride count and sprint-effort count', () => {
    const { get } = loadApp();
    const weeklyClassProgress = get('weeklyClassProgress');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const results = [
      { date: weekDateIso(0, 0), metrics: { zoneTimes: zoneTimesFrom({ 1: 600, 3: 1800 }) } }, // Monday: endurance 10min, threshold 30min
      { date: weekDateIso(0, 1), movingMin: 200 }, // a long ride (>=150min)
      { date: weekDateIso(0, 2), metrics: { zoneTimes: zoneTimesFrom({ 6: 120 }) } }, // sprint 2min -> /0.5min = 4 efforts
    ];
    const progress = weeklyClassProgress(results, TODAY_ISO, TRAINING_CONFIG);
    assert.equal(progress.endurance, 10);
    assert.equal(progress.threshold, 30);
    assert.equal(progress.longdistance, 1);
    assert.equal(progress.sprint, 4);
    assert.equal(progress.tempo, 0);
  });

  await t.test('prefers intervalZoneTimes over raw zoneTimes when both are present', () => {
    const { get } = loadApp();
    const weeklyClassProgress = get('weeklyClassProgress');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const results = [{
      date: weekDateIso(0, 1),
      metrics: { zoneTimes: zoneTimesFrom({ 4: 300 }), intervalZoneTimes: zoneTimesFrom({ 4: 900 }) },
    }];
    const progress = weeklyClassProgress(results, TODAY_ISO, TRAINING_CONFIG);
    assert.equal(progress.vo2max, 15); // 900s/60, NOT the raw 300s/60=5
  });

  await t.test('falls back to raw zoneTimes when intervalZoneTimes is absent (old cached rows)', () => {
    const { get } = loadApp();
    const weeklyClassProgress = get('weeklyClassProgress');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const results = [{ date: weekDateIso(0, 1), metrics: { zoneTimes: zoneTimesFrom({ 4: 300 }) } }];
    const progress = weeklyClassProgress(results, TODAY_ISO, TRAINING_CONFIG);
    assert.equal(progress.vo2max, 5);
  });

  await t.test('rides outside the current Mon-Mon window (before or from the invalid date) are excluded', () => {
    const { get } = loadApp();
    const weeklyClassProgress = get('weeklyClassProgress');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const results = [
      { date: toIsoDate(addDaysUTC(TODAY_MONDAY, -1)), metrics: { zoneTimes: zoneTimesFrom({ 1: 99999 }) } }, // last Sunday, before this week
      { date: toIsoDate(addDaysUTC(TODAY_MONDAY, 7)), metrics: { zoneTimes: zoneTimesFrom({ 1: 99999 }) } }, // next Monday, after this week
      { date: 'not-a-date', metrics: { zoneTimes: zoneTimesFrom({ 1: 99999 }) } }, // invalid date
    ];
    const progress = weeklyClassProgress(results, TODAY_ISO, TRAINING_CONFIG);
    assert.equal(progress.endurance, 0);
  });

  await t.test('empty/missing results -> every class at 0, not a crash', () => {
    const { get } = loadApp();
    const weeklyClassProgress = get('weeklyClassProgress');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const progress = weeklyClassProgress([], TODAY_ISO, TRAINING_CONFIG);
    get('TRAINING_CLASSES').map((c) => c.key)
      .forEach((key) => assert.equal(progress[key] || 0, 0));
    assert.deepEqual(plain(weeklyClassProgress(null, TODAY_ISO, TRAINING_CONFIG)), plain(progress));
  });
});

test('computeTrainingPriorities', async (t) => {
  await t.test('tier boundaries (raw score + classBaselineScore, neglect neutralized by 4 well-trained past weeks): HIGH>=55, MEDIUM>=25, LOW>=5, else MAINTENANCE', () => {
    const { get } = loadApp();
    const computeTrainingPriorities = get('computeTrainingPriorities');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const pastWeeks = [1, 2, 3, 4].map((w) => wellTrainedRide(weekDateIso(w)));
    const scores = {
      recovery: { score: 0, why: null }, endurance: { score: 0, why: null }, tempo: { score: 0, why: null },
      threshold: { score: 40, why: null }, // +baseline15 = 55 -> HIGH boundary, inclusive
      vo2max: { score: 14, why: null },    // +baseline10 = 24 -> just under mediumMin(25) -> LOW
      anaerobic: { score: 0, why: null },  // +baseline5 = 5 -> exactly lowMin -> LOW boundary, inclusive
      sprint: { score: 0, why: null },     // +baseline0 = 0 -> MAINTENANCE
      longdistance: { score: 0, why: null }, test: { score: 0, why: null },
    };
    const priorities = computeTrainingPriorities(scores, null, TRAINING_CONFIG, pastWeeks, TODAY_ISO);
    assert.equal(priorities.threshold, 'HIGH');
    assert.equal(priorities.vo2max, 'LOW');
    assert.equal(priorities.anaerobic, 'LOW');
    assert.equal(priorities.sprint, 'MAINTENANCE');
    assert.equal(priorities.endurance, 'LOW'); // baseline 20 alone, no raw score, no neglect
  });

  await t.test('recovery and test are always MAINTENANCE regardless of score (priorityEligible:false)', () => {
    const { get } = loadApp();
    const computeTrainingPriorities = get('computeTrainingPriorities');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const scores = { recovery: { score: 100, why: null }, test: { score: 100, why: null } };
    const priorities = computeTrainingPriorities(scores, null, TRAINING_CONFIG, [], TODAY_ISO);
    assert.equal(priorities.recovery, 'MAINTENANCE');
    assert.equal(priorities.test, 'MAINTENANCE');
  });

  await t.test('a manually selected goal forces its mapped class (GOAL_TO_CLASS) to HIGH, overriding whatever score/neglect would otherwise give it', () => {
    const { get } = loadApp();
    const computeTrainingPriorities = get('computeTrainingPriorities');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const scores = { vo2max: { score: 0, why: null } };
    const priorities = computeTrainingPriorities(scores, 'vo2max', TRAINING_CONFIG, [], TODAY_ISO);
    assert.equal(priorities.vo2max, 'HIGH');
  });

  await t.test('with zero training history at all, every class with a weekly floor gets the max neglect boost (documents classNeglectWeeks\' own behavior)', () => {
    const { get } = loadApp();
    const computeTrainingPriorities = get('computeTrainingPriorities');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const scores = {};
    ['recovery', 'endurance', 'tempo', 'threshold', 'vo2max', 'anaerobic', 'sprint', 'longdistance', 'test'].forEach((k) => { scores[k] = { score: 0, why: null }; });
    const priorities = computeTrainingPriorities(scores, null, TRAINING_CONFIG, [], TODAY_ISO);
    // baseline(20) + maxNeglectBoost(24) = 44 -> MEDIUM for endurance; every
    // other floor-bearing class with baseline<25 similarly gets lifted by
    // the same +24 cap (neglect.boostMax), landing at MEDIUM too.
    assert.equal(priorities.endurance, 'MEDIUM');
    assert.equal(priorities.tempo, 'MEDIUM');
    assert.equal(priorities.threshold, 'MEDIUM');
    assert.equal(priorities.vo2max, 'MEDIUM');
    assert.equal(priorities.anaerobic, 'MEDIUM');
    assert.equal(priorities.longdistance, 'MEDIUM');
    // sprint's baseline is 0, so even the capped +24 only reaches 24 -> LOW, not MEDIUM.
    assert.equal(priorities.sprint, 'LOW');
  });

  await t.test('neglect counting stops at the first non-neglected week walking backward -- an old gap behind a recently-trained week does not count', () => {
    const { get } = loadApp();
    const computeTrainingPriorities = get('computeTrainingPriorities');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const scores = {};
    ['endurance', 'tempo', 'threshold', 'vo2max', 'anaerobic', 'sprint', 'longdistance'].forEach((k) => { scores[k] = { score: 0, why: null }; });
    // Only week -1 (most recent completed week) is well-trained; weeks -2..-4
    // are empty. Walking backward from week -1, the FIRST week checked is
    // already non-neglected, so the loop breaks immediately -- 0 neglect
    // weeks, even though 3 older weeks behind it were empty.
    const results = [wellTrainedRide(weekDateIso(1))];
    const priorities = computeTrainingPriorities(scores, null, TRAINING_CONFIG, results, TODAY_ISO);
    assert.equal(priorities.endurance, 'LOW'); // baseline 20 only, no neglect boost
    assert.equal(priorities.threshold, 'LOW'); // baseline 15 only
  });

  await t.test('a single neglected week immediately behind an otherwise-trained history adds exactly one week\'s worth of boost', () => {
    const { get } = loadApp();
    const computeTrainingPriorities = get('computeTrainingPriorities');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const scores = {};
    ['endurance', 'tempo', 'threshold', 'vo2max', 'anaerobic', 'sprint', 'longdistance'].forEach((k) => { scores[k] = { score: 0, why: null }; });
    // Week -1 is empty (neglected), week -2 is well-trained -- counting
    // starts at week -1 (neglected, count=1) then stops at week -2 (trained).
    const results = [wellTrainedRide(weekDateIso(2))];
    const priorities = computeTrainingPriorities(scores, null, TRAINING_CONFIG, results, TODAY_ISO);
    // endurance: baseline20 + 1*boostPerWeek(8) = 28 -> MEDIUM (>=25)
    assert.equal(priorities.endurance, 'MEDIUM');
    // sprint: baseline0 + 8 = 8 -> LOW (>=5), distinguishing it from the
    // fully-neglected case above where sprint only reached LOW at +24 too --
    // here it's specifically the single-week +8 that clears the LOW floor.
    assert.equal(priorities.sprint, 'LOW');
  });
});

test('computeWeeklyBudgetTargets', async (t) => {
  await t.test('recovery is always 0 minutes and test is always 0 "test" units, regardless of priority tier', () => {
    const { get } = loadApp();
    const computeWeeklyBudgetTargets = get('computeWeeklyBudgetTargets');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const targets = computeWeeklyBudgetTargets({ recovery: 'HIGH', test: 'HIGH' }, TRAINING_CONFIG);
    assert.deepEqual(plain(targets.recovery), { unit: 'minutes', amount: 0 });
    assert.deepEqual(plain(targets.test), { unit: 'test', amount: 0 });
  });

  await t.test('each class reads its own weekly*ByPriority table at its assigned tier, with the right unit', () => {
    const { get } = loadApp();
    const computeWeeklyBudgetTargets = get('computeWeeklyBudgetTargets');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const priorities = { endurance: 'HIGH', tempo: 'MEDIUM', threshold: 'LOW', vo2max: 'MAINTENANCE', anaerobic: 'HIGH', sprint: 'MEDIUM', longdistance: 'LOW' };
    const targets = computeWeeklyBudgetTargets(priorities, TRAINING_CONFIG);
    assert.deepEqual(plain(targets.endurance), { unit: 'minutes', amount: TRAINING_CONFIG.weeklyEnduranceMinutesByPriority.HIGH });
    assert.deepEqual(plain(targets.tempo), { unit: 'quality', amount: TRAINING_CONFIG.weeklyTempoMinutesByPriority.MEDIUM });
    assert.deepEqual(plain(targets.threshold), { unit: 'quality', amount: TRAINING_CONFIG.weeklyThresholdMinutesByPriority.LOW });
    assert.deepEqual(plain(targets.vo2max), { unit: 'quality', amount: 0 }); // MAINTENANCE tier is 0 everywhere
    assert.deepEqual(plain(targets.anaerobic), { unit: 'quality', amount: TRAINING_CONFIG.weeklyAnaerobicMinutesByPriority.HIGH });
    assert.deepEqual(plain(targets.sprint), { unit: 'efforts', amount: TRAINING_CONFIG.weeklySprintEffortsByPriority.MEDIUM });
    assert.deepEqual(plain(targets.longdistance), { unit: 'rides', amount: TRAINING_CONFIG.weeklyLongRidesByPriority.LOW });
  });

  await t.test('a class missing from `priorities` defaults to the MAINTENANCE tier rather than crashing', () => {
    const { get } = loadApp();
    const computeWeeklyBudgetTargets = get('computeWeeklyBudgetTargets');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const targets = computeWeeklyBudgetTargets({}, TRAINING_CONFIG);
    assert.equal(targets.endurance.amount, TRAINING_CONFIG.weeklyEnduranceMinutesByPriority.MAINTENANCE);
  });
});

test('reconcileWeeklyBudgets', async (t) => {
  await t.test('combines a target and its matching progress into done/remaining/complete', () => {
    const { get } = loadApp();
    const reconcileWeeklyBudgets = get('reconcileWeeklyBudgets');
    const targets = { endurance: { unit: 'minutes', amount: 300 }, threshold: { unit: 'quality', amount: 40 } };
    const progress = { endurance: 320, threshold: 10 };
    const out = reconcileWeeklyBudgets(targets, progress);
    assert.deepEqual(plain(out.endurance), { unit: 'minutes', target: 300, done: 320, remaining: 0, complete: true });
    assert.deepEqual(plain(out.threshold), { unit: 'quality', target: 40, done: 10, remaining: 30, complete: false });
  });

  await t.test('remaining never goes negative when done exceeds target (overshoot), and a 0-target class is never "complete"', () => {
    const { get } = loadApp();
    const reconcileWeeklyBudgets = get('reconcileWeeklyBudgets');
    const out = reconcileWeeklyBudgets({ tempo: { unit: 'quality', amount: 0 } }, { tempo: 999 });
    assert.equal(out.tempo.remaining, 0);
    assert.equal(out.tempo.complete, false); // amount>0 is required for complete, even though done clears it
  });

  await t.test('a class with no matching progress entry defaults done to 0, not undefined/NaN', () => {
    const { get } = loadApp();
    const reconcileWeeklyBudgets = get('reconcileWeeklyBudgets');
    const out = reconcileWeeklyBudgets({ vo2max: { unit: 'quality', amount: 16 } }, {});
    assert.deepEqual(plain(out.vo2max), { unit: 'quality', target: 16, done: 0, remaining: 16, complete: false });
  });
});

test('computeTrainingDecisionState', async (t) => {
  await t.test('a 5-week fixture (4 well-trained past weeks, minus vo2max which is neglected throughout, plus a partial current week) produces both a live neglect boost on vo2max AND accurate current-week budget progress on threshold', () => {
    const { get } = loadApp();
    const computeTrainingDecisionState = get('computeTrainingDecisionState');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const noVo2max = (dateIso) => { const r = wellTrainedRide(dateIso); r.metrics.zoneTimes[4] = 0; return r; };
    const results = [1, 2, 3, 4].map((w) => noVo2max(weekDateIso(w)));
    results.push({ date: weekDateIso(0, 0), movingMin: 60, metrics: { zoneTimes: zoneTimesFrom({ 3: 20 * 60 }) } }); // this Monday: 20min threshold quality
    const weaknessData = { items: [{ goal: 'ftp', area: 'x', score: 30, why: 'threshold weakness' }] };

    const state = computeTrainingDecisionState(results, weaknessData, null, TODAY_ISO, TRAINING_CONFIG);

    assert.equal(state.weekStartIso, toIsoDate(TODAY_MONDAY));
    assert.deepEqual(plain(state.scores.threshold), { score: 30, why: 'threshold weakness' });
    // threshold: raw30 + baseline15 + no neglect (well-trained in all 4 past weeks) = 45 -> MEDIUM
    assert.equal(state.priorities.threshold, 'MEDIUM');
    // vo2max: raw0 + baseline10 + maxNeglectBoost24 (never trained in any of
    // the 4 past weeks) = 34 -> MEDIUM too, but via a completely different
    // mechanism (neglect, not a weakness score) -- the point of this fixture.
    assert.equal(state.priorities.vo2max, 'MEDIUM');
    // Current week's budget reflects the partial threshold ride actually
    // logged THIS week, independent of both the score and the past-week
    // neglect lookback used to derive the priority tier.
    assert.equal(state.budgets.threshold.done, 20);
    assert.equal(state.budgets.threshold.target, TRAINING_CONFIG.weeklyThresholdMinutesByPriority.MEDIUM);
    assert.equal(state.budgets.threshold.complete, false);
    assert.equal(state.budgets.vo2max.done, 0); // vo2max was never trained, including this week
  });
});

test('pickIntendedTrainingClass', async (t) => {
  await t.test('forceRecovery short-circuits to recovery/"safety" before any ranking logic runs', () => {
    const { get } = loadApp();
    const pickIntendedTrainingClass = get('pickIntendedTrainingClass');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const decisionState = { priorities: { threshold: 'HIGH' }, scores: {}, budgets: {} };
    const result = pickIntendedTrainingClass(decisionState, [], TODAY_ISO, TRAINING_CONFIG, true);
    assert.deepEqual(plain(result), { classKey: 'recovery', reason: 'safety' });
  });

  await t.test('ranks by priority tier weight first, then by score as a tiebreaker within the same tier', () => {
    const { get } = loadApp();
    const pickIntendedTrainingClass = get('pickIntendedTrainingClass');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const decisionState = {
      priorities: { threshold: 'HIGH', vo2max: 'HIGH', endurance: 'MEDIUM' },
      scores: { threshold: { score: 80, why: null }, vo2max: { score: 20, why: null } },
      budgets: {},
    };
    const result = pickIntendedTrainingClass(decisionState, [], TODAY_ISO, TRAINING_CONFIG, false);
    assert.deepEqual(plain(result), { classKey: 'threshold', reason: 'priority' }); // same HIGH tier, but higher score
  });

  await t.test('a class whose weekly budget is already complete is skipped in favor of the next-ranked one', () => {
    const { get } = loadApp();
    const pickIntendedTrainingClass = get('pickIntendedTrainingClass');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const decisionState = {
      priorities: { threshold: 'HIGH', vo2max: 'HIGH' },
      scores: { threshold: { score: 80, why: null }, vo2max: { score: 20, why: null } },
      budgets: { threshold: { target: 40, done: 40, complete: true } },
    };
    const result = pickIntendedTrainingClass(decisionState, [], TODAY_ISO, TRAINING_CONFIG, false);
    assert.equal(result.classKey, 'vo2max');
  });

  await t.test('the "no consecutive hard days" rule skips a noConsecutiveDays class trained yesterday with enough time-in-zone, falling through to the next-ranked class', () => {
    const { get } = loadApp();
    const pickIntendedTrainingClass = get('pickIntendedTrainingClass');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const yesterday = toIsoDate(addDaysUTC(parseIsoDateUTC(TODAY_ISO), -1));
    // vo2max (zoneIdx 4) has noConsecutiveDays:true in TRAINING_CONFIG; 20min
    // of zone-4 time yesterday clears recentTrainingMinMinutes (12). With no
    // priority set for any other class, every other priority-eligible class
    // ties at MAINTENANCE-weight-0, so the next one in TRAINING_CLASSES'
    // own declared order ('endurance') wins the tiebreak -- distinct from
    // the TRUE "fallback" reason below, which only fires once every
    // priority-eligible class has been explicitly disqualified.
    const results = [{ date: yesterday, metrics: { zoneTimes: zoneTimesFrom({ 4: 20 * 60 }) } }];
    const decisionState = { priorities: { vo2max: 'HIGH' }, scores: {}, budgets: {} };
    const result = pickIntendedTrainingClass(decisionState, results, TODAY_ISO, TRAINING_CONFIG, false);
    assert.equal(result.classKey, 'endurance');
    assert.equal(result.reason, 'priority'); // vo2max was skipped, but endurance is a normal (non-fallback) pick
  });

  await t.test('a noConsecutiveDays class trained yesterday but BELOW recentTrainingMinMinutes is NOT skipped (too little time-in-zone to count)', () => {
    const { get } = loadApp();
    const pickIntendedTrainingClass = get('pickIntendedTrainingClass');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const yesterday = toIsoDate(addDaysUTC(parseIsoDateUTC(TODAY_ISO), -1));
    const results = [{ date: yesterday, metrics: { zoneTimes: zoneTimesFrom({ 4: 5 * 60 }) } }]; // 5min < 12min floor
    const decisionState = { priorities: { vo2max: 'HIGH' }, scores: {}, budgets: {} };
    const result = pickIntendedTrainingClass(decisionState, results, TODAY_ISO, TRAINING_CONFIG, false);
    assert.equal(result.classKey, 'vo2max');
    assert.equal(result.reason, 'priority');
  });

  await t.test('true fallback: every priority-eligible class\'s budget is already complete -> endurance/"fallback"', () => {
    const { get } = loadApp();
    const pickIntendedTrainingClass = get('pickIntendedTrainingClass');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const classes = ['endurance', 'tempo', 'threshold', 'vo2max', 'anaerobic', 'sprint', 'longdistance'];
    const budgets = {};
    classes.forEach((k) => { budgets[k] = { target: 10, done: 10, complete: true }; });
    const priorities = {}; classes.forEach((k) => { priorities[k] = 'MEDIUM'; });
    const decisionState = { priorities, scores: {}, budgets };
    const result = pickIntendedTrainingClass(decisionState, [], TODAY_ISO, TRAINING_CONFIG, false);
    assert.deepEqual(plain(result), { classKey: 'endurance', reason: 'fallback' });
  });
});

test('computeTrainingOpportunity', async (t) => {
  await t.test('route=null: suitability is never computed and the opportunity is always "suitable" regardless of class', () => {
    const { get } = loadApp();
    const computeTrainingOpportunity = get('computeTrainingOpportunity');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const decisionState = { priorities: { threshold: 'HIGH' }, scores: {}, budgets: { threshold: { target: 40, done: 0, complete: false } } };
    const result = computeTrainingOpportunity(decisionState, null, [], TODAY_ISO, TRAINING_CONFIG, {}, {});
    assert.equal(result.classKey, 'threshold');
    assert.equal(result.suitability, null);
    assert.equal(result.suitable, true);
    assert.equal(result.forceRecovery, false);
  });

  await t.test('rp.acwr > 1.5 auto-triggers forceRecovery, overriding whatever priority ranking would otherwise pick', () => {
    const { get } = loadApp();
    const computeTrainingOpportunity = get('computeTrainingOpportunity');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const decisionState = { priorities: { threshold: 'HIGH' }, scores: {}, budgets: {} };
    const result = computeTrainingOpportunity(decisionState, null, [], TODAY_ISO, TRAINING_CONFIG, { acwr: 1.8 }, {});
    assert.equal(result.classKey, 'recovery');
    assert.equal(result.forceRecovery, true);
  });

  await t.test('rp.daysSinceHard <= 1 also auto-triggers forceRecovery (independent of acwr)', () => {
    const { get } = loadApp();
    const computeTrainingOpportunity = get('computeTrainingOpportunity');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const decisionState = { priorities: { threshold: 'HIGH' }, scores: {}, budgets: {} };
    const result = computeTrainingOpportunity(decisionState, null, [], TODAY_ISO, TRAINING_CONFIG, { daysSinceHard: 1 }, {});
    assert.equal(result.forceRecovery, true);
    // acwr comfortably below the threshold and daysSinceHard=2 (>1) -> no trigger
    const notTriggered = computeTrainingOpportunity(decisionState, null, [], TODAY_ISO, TRAINING_CONFIG, { acwr: 0.9, daysSinceHard: 2 }, {});
    assert.equal(notTriggered.forceRecovery, false);
  });

  await t.test('an exempt class (endurance) skips suitability scoring entirely even with a real route attached', () => {
    const { get } = loadApp();
    const computeTrainingOpportunity = get('computeTrainingOpportunity');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const decisionState = { priorities: { endurance: 'HIGH' }, scores: {}, budgets: {} };
    const route = {
      totalDistanceM: 30000,
      segments: [{ type: 'flat', startDist: 0, endDist: 30000, distanceM: 30000, avgGradient: 0, avgCurviness: 0, curvy: false }],
      points: [{ lat: 45, lon: 9, dist: 0 }, { lat: 45, lon: 9.1, dist: 30000 }],
    };
    const result = computeTrainingOpportunity(decisionState, route, [], TODAY_ISO, TRAINING_CONFIG, {}, {});
    assert.equal(result.classKey, 'endurance');
    assert.equal(result.suitability, null);
    assert.equal(result.suitable, true);
  });

  await t.test('a non-exempt class (threshold) with a too-short/too-little-workable-terrain route is marked unsuitable, with reasons populated', () => {
    const { get } = loadApp();
    const computeTrainingOpportunity = get('computeTrainingOpportunity');
    const TRAINING_CONFIG = get('TRAINING_CONFIG');
    const decisionState = { priorities: { threshold: 'HIGH' }, scores: {}, budgets: {} };
    const shortRoute = {
      totalDistanceM: 3000,
      segments: [{ type: 'flat', startDist: 0, endDist: 3000, distanceM: 3000, avgGradient: 0, avgCurviness: 0, curvy: false }],
      points: [{ lat: 45, lon: 9, dist: 0 }, { lat: 45, lon: 9.01, dist: 3000 }],
    };
    const result = computeTrainingOpportunity(decisionState, shortRoute, [], TODAY_ISO, TRAINING_CONFIG, {}, {});
    assert.equal(result.suitable, false);
    assert.ok(result.suitability.score < TRAINING_CONFIG.suitability.minAcceptable);
    assert.ok(result.suitability.reasons.length > 0);
  });
});
