'use strict';
// Tests for the segment stat-chip builders and the star-state fallback --
// flagged as a coverage gap by a full-app audit (04.09.2026): these are the
// exact functions the "Potential used this ride's own effort instead of the
// genuine PR" bug lived in (see index.html's computeRideEffortStatChips()
// comment), yet had zero direct tests before this file -- the bug's own
// regression coverage lived only in segmentPotentialValue()'s tests, not in
// the chip-building functions that actually display the number to the user.
//
//   - buildXomChip(xomTime, prSeconds, label): the KOM/QOM delta chip
//     (closeness tint tiers, "GLEICHAUF" on-par case).
//   - computeSegmentStatChips(seg, bucket): starred-bucket branch directly,
//     and the bucket.efforts delegation to computeRideEffortStatChips().
//   - computeRideEffortStatChips(effort, detail, prWatts): ride-completed
//     bucket's chip builder -- Zeit/Ø-watts from the effort itself, Potential
//     from the genuine PR watts+duration (the regression this bug fix needs
//     covered at the chip-builder level, not just segmentPotentialValue()).
//   - segmentIsStarred(seg, bucket): the three-way star-state fallback
//     (state.segmentStars -> bucket.details -> seg.starred).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

// ---------------------------------------------------------------------
// buildXomChip(xomTime, prSeconds, label)
// ---------------------------------------------------------------------
test('buildXomChip', async (t) => {
  await t.test('missing prSeconds -> plain label, no style, value is the raw xomTime string', () => {
    const { get } = loadApp();
    const buildXomChip = get('buildXomChip');
    assert.deepEqual(plain(buildXomChip('1:40', null, 'KOM')), { value: '1:40', label: 'KOM', style: null });
  });

  await t.test('unparseable xomTime -> plain label, no style (parseDuration fails)', () => {
    const { get } = loadApp();
    const buildXomChip = get('buildXomChip');
    assert.deepEqual(plain(buildXomChip('n/a', 200, 'KOM')), { value: 'n/a', label: 'KOM', style: null });
  });

  await t.test('closeness exactly at the 5% boundary -> tight "kom-near" tier (inclusive <=)', () => {
    const { get } = loadApp();
    const buildXomChip = get('buildXomChip');
    const fmtDuration = get('fmtDuration');
    // xom=100s, pr=105s -> delta=5s, closeness=5/100=5%.
    const chip = buildXomChip('1:40', 105, 'KOM');
    assert.equal(chip.label, `KOM +${fmtDuration(5)}`);
    assert.equal(chip.style, 'color:var(--kom-near); background:var(--kom-near-bg);');
  });

  await t.test('closeness between 5% and 15% -> mid "kom-mid" tier', () => {
    const { get } = loadApp();
    const buildXomChip = get('buildXomChip');
    // xom=100s, pr=110s -> delta=10s, closeness=10%.
    const chip = buildXomChip('1:40', 110, 'KOM');
    assert.equal(chip.style, 'color:var(--kom-mid); background:var(--kom-mid-bg);');
  });

  await t.test('closeness beyond 15% -> plain delta label, no tint', () => {
    const { get } = loadApp();
    const buildXomChip = get('buildXomChip');
    // xom=100s, pr=130s -> delta=30s, closeness=30%.
    const chip = buildXomChip('1:40', 130, 'KOM');
    assert.equal(chip.style, null);
  });

  await t.test('PR at or ahead of the record (delta <= 0) -> "GLEICHAUF", not a negative delta', () => {
    const { get } = loadApp();
    const buildXomChip = get('buildXomChip');
    const atRecord = buildXomChip('1:40', 100, 'QOM'); // delta === 0
    assert.equal(atRecord.label, 'QOM GLEICHAUF');
    assert.equal(atRecord.style, 'color:var(--kom-near); background:var(--kom-near-bg);');
    const aheadOfRecord = buildXomChip('1:40', 90, 'QOM'); // delta < 0
    assert.equal(aheadOfRecord.label, 'QOM GLEICHAUF');
  });
});

// ---------------------------------------------------------------------
// computeSegmentStatChips(seg, bucket) -- starred-bucket branch
// (bucket.efforts falsy) directly, plus the delegation wiring.
// ---------------------------------------------------------------------
test('computeSegmentStatChips', async (t) => {
  await t.test('no detail for this segment -> empty chips', () => {
    const { get } = loadApp();
    const compute = get('computeSegmentStatChips');
    const bucket = { efforts: null, details: {}, prWatts: {} };
    assert.deepEqual(plain(compute({ id: 1 }, bucket)), { hero: [], secondary: [] });
  });

  await t.test('detail with a PR time -> "PR" hero chip', () => {
    const { get } = loadApp();
    const compute = get('computeSegmentStatChips');
    const fmtDuration = get('fmtDuration');
    const bucket = { efforts: null, details: { 1: { athlete_segment_stats: { pr_elapsed_time: 100 } } }, prWatts: {} };
    const { hero } = compute({ id: 1 }, bucket);
    assert.deepEqual(plain(hero), [{ value: fmtDuration(100), label: 'PR' }]);
  });

  await t.test('prWatts present -> secondary watt line has NO "Ø" prefix (genuinely PR watts, not a ride average)', () => {
    const { get } = loadApp();
    const compute = get('computeSegmentStatChips');
    const bucket = {
      efforts: null,
      details: { 1: { athlete_segment_stats: { pr_elapsed_time: 100 } } },
      prWatts: { 1: { watts: 250, measured: true } },
    };
    const { secondary } = compute({ id: 1 }, bucket);
    assert.ok(secondary.includes('250 W'), `expected a plain "250 W" entry, got ${JSON.stringify(secondary)}`);
  });

  await t.test('unmeasured (estimated) prWatts get a "~" prefix', () => {
    const { get } = loadApp();
    const compute = get('computeSegmentStatChips');
    const bucket = {
      efforts: null,
      details: { 1: { athlete_segment_stats: { pr_elapsed_time: 100 } } },
      prWatts: { 1: { watts: 250, measured: false } },
    };
    const { secondary } = compute({ id: 1 }, bucket);
    assert.ok(secondary.includes('~250 W'));
  });

  await t.test('potential chip appears when riderProfile + prWatts + pr are all available', () => {
    const { get } = loadApp();
    const compute = get('computeSegmentStatChips');
    const state = get('state');
    // Keys must be real MMP_DURATIONS_SEC entries (estimatePowerCurveAt()
    // only interpolates between those) -- 60 and 300 both are.
    state.profilPage.riderProfile = { mmpCurve: { 60: 250, 300: 200 } };
    const bucket = {
      efforts: null,
      details: { 1: { athlete_segment_stats: { pr_elapsed_time: 60 } } },
      prWatts: { 1: { watts: 250, measured: true } },
    };
    const { hero } = compute({ id: 1 }, bucket);
    const potential = hero.find(c => c.label === 'Potential');
    assert.equal(potential.value, '100%');
  });

  await t.test('showKomChip=false suppresses the KOM chip even when xoms.kom is present', () => {
    const { get } = loadApp();
    const compute = get('computeSegmentStatChips');
    const state = get('state');
    state.showKomChip = false;
    const bucket = {
      efforts: null,
      details: { 1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:30' } } },
      prWatts: {},
    };
    const { hero } = compute({ id: 1 }, bucket);
    assert.equal(hero.some(c => c.label && c.label.startsWith('KOM')), false);
  });

  await t.test('showQomChip=true (default) includes the QOM chip when xoms.qom is present', () => {
    const { get } = loadApp();
    const compute = get('computeSegmentStatChips');
    const bucket = {
      efforts: null,
      details: { 1: { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { qom: '1:30' } } },
      prWatts: {},
    };
    const { hero } = compute({ id: 1 }, bucket);
    assert.equal(hero.some(c => c.label && c.label.startsWith('QOM')), true);
  });

  await t.test('elevation gain and effort count land in the secondary line', () => {
    const { get } = loadApp();
    const compute = get('computeSegmentStatChips');
    const bucket = {
      efforts: null,
      details: { 1: { athlete_segment_stats: { effort_count: 7 }, total_elevation_gain: 123.6 } },
      prWatts: {},
    };
    const { secondary } = compute({ id: 1 }, bucket);
    assert.ok(secondary.includes('124 Hm'), `expected rounded elevation, got ${JSON.stringify(secondary)}`);
    assert.ok(secondary.includes('7× gefahren'));
  });

  await t.test('bucket.efforts set -> delegates fully to computeRideEffortStatChips() with the matching args', () => {
    // A "Zeit" hero chip only ever comes from the ride-effort branch (the
    // starred-bucket branch above never builds one) -- seeing it here proves
    // real delegation happened, not just a superficially similar shape.
    const { get } = loadApp();
    const compute = get('computeSegmentStatChips');
    const computeRideEffortStatChips = get('computeRideEffortStatChips');
    const effort = { elapsed_time: 200, average_watts: 180 };
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 } };
    const prWatts = { watts: 300, measured: true };
    const bucket = { efforts: { 1: effort }, details: { 1: detail }, prWatts: { 1: prWatts } };
    const viaCompute = compute({ id: 1 }, bucket);
    const direct = computeRideEffortStatChips(effort, detail, prWatts);
    assert.deepEqual(plain(viaCompute), plain(direct));
    assert.ok(viaCompute.hero.some(c => c.label === 'Zeit'), 'delegated result should contain a Zeit chip, proving the ride-effort branch ran');
  });
});

// ---------------------------------------------------------------------
// computeRideEffortStatChips(effort, detail, prWatts) -- ride-completed
// bucket's chip builder.
// ---------------------------------------------------------------------
test('computeRideEffortStatChips', async (t) => {
  await t.test('no effort at all -> empty chips', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    assert.deepEqual(plain(compute(null, null, null)), { hero: [], secondary: [] });
  });

  await t.test('ordinary effort -> plain "Zeit" hero chip, no PR styling', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const fmtDuration = get('fmtDuration');
    const { hero } = compute({ elapsed_time: 250, pr_rank: 3 }, null, null);
    assert.deepEqual(plain(hero), [{ value: fmtDuration(250), label: 'Zeit', style: null }]);
  });

  await t.test('pr_rank === 1 on this very effort -> "Zeit · PR!" tail-tinted chip', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const { hero } = compute({ elapsed_time: 250, pr_rank: 1 }, null, null);
    assert.equal(hero[0].label, 'Zeit · PR!');
    assert.equal(hero[0].style, 'color:var(--tail); background:var(--tail-bg);');
  });

  await t.test('this ride\'s own average watts -> "Ø" secondary line (measured vs. estimated)', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const measured = compute({ elapsed_time: 100, average_watts: 210.4, device_watts: true }, null, null);
    assert.ok(measured.secondary.includes('Ø 210 W'), `expected rounded measured watts, got ${JSON.stringify(measured.secondary)}`);
    const estimated = compute({ elapsed_time: 100, average_watts: 210.4, device_watts: false }, null, null);
    assert.ok(estimated.secondary.includes('Ø ~210 W'));
  });

  await t.test('no average_watts on the effort -> no Ø line at all', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const { secondary } = compute({ elapsed_time: 100 }, null, null);
    assert.equal(secondary.some(s => s.startsWith('Ø')), false);
  });

  await t.test('effort.kom_rank -> "Platz X (Effort)" secondary line, independent of detail', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const { secondary } = compute({ elapsed_time: 100, kom_rank: 4 }, null, null);
    assert.ok(secondary.includes('Platz 4 (Effort)'));
  });

  await t.test('missing detail -> no PR/Potential/KOM/QOM/elevation/count lines, only effort-derived data', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const { hero, secondary } = compute({ elapsed_time: 100, average_watts: 200 }, null, { watts: 300 });
    assert.equal(hero.some(c => c.label === 'Potential'), false, 'no detail means no genuine PR duration, so no potential chip even with prWatts present');
    assert.equal(secondary.some(s => s.startsWith('PR ')), false);
  });

  await t.test('REGRESSION: potential is computed from the genuine PR watts+duration, never from this ride\'s own effort', () => {
    // This is the exact bug that was fixed: Potential used to be paired with
    // effort.average_watts/effort.elapsed_time (this ride's own numbers)
    // instead of the genuine PR effort's watts+duration. Deliberately picks
    // an effort whose own watts/duration would give a WILDLY different %
    // than the genuine PR would, so a regression back to the old behavior
    // flips this assertion instead of silently passing by coincidence.
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const state = get('state');
    // Curve: 400W ceiling at 60s (sprint), 100W ceiling at 1200s (endurance).
    state.profilPage.riderProfile = { mmpCurve: { 60: 400, 1200: 100 } };
    const effort = { elapsed_time: 60, average_watts: 40 }; // this ride: a very easy roll, 40W/60s -> 40/400 = 10% if wrongly used
    const detail = { athlete_segment_stats: { pr_elapsed_time: 1200 } }; // genuine PR: 1200s
    const prWatts = { watts: 97, measured: true }; // genuine PR watts -> 97/100 = 97%
    const { hero } = compute(effort, detail, prWatts);
    const potential = hero.find(c => c.label === 'Potential');
    assert.equal(potential.value, '97%', 'must use genuine PR watts (97W) against the genuine PR duration\'s ceiling (100W @ 1200s), not this ride\'s 40W/60s effort');
  });

  await t.test('prWatts missing -> no potential chip even with a genuine PR duration available', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const state = get('state');
    state.profilPage.riderProfile = { mmpCurve: { 60: 400 } };
    const { hero } = compute({ elapsed_time: 60 }, { athlete_segment_stats: { pr_elapsed_time: 60 } }, null);
    assert.equal(hero.some(c => c.label === 'Potential'), false);
  });

  await t.test('detail.athlete_segment_stats.pr_elapsed_time -> "PR {duration}" secondary line', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const fmtDuration = get('fmtDuration');
    const { secondary } = compute({ elapsed_time: 100 }, { athlete_segment_stats: { pr_elapsed_time: 88 } }, null);
    assert.ok(secondary.includes(`PR ${fmtDuration(88)}`));
  });

  await t.test('showKomChip/showQomChip gate the KOM/QOM chips exactly like the starred-bucket branch', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const state = get('state');
    state.showKomChip = false;
    state.showQomChip = true;
    const detail = { athlete_segment_stats: { pr_elapsed_time: 100 }, xoms: { kom: '1:30', qom: '1:20' } };
    const { hero } = compute({ elapsed_time: 100 }, detail, null);
    assert.equal(hero.some(c => c.label && c.label.startsWith('KOM')), false);
    assert.equal(hero.some(c => c.label && c.label.startsWith('QOM')), true);
  });

  await t.test('elevation gain and effort count from detail land in secondary, same as the starred-bucket branch', () => {
    const { get } = loadApp();
    const compute = get('computeRideEffortStatChips');
    const detail = { athlete_segment_stats: { effort_count: 3 }, total_elevation_gain: 55.2 };
    const { secondary } = compute({ elapsed_time: 100 }, detail, null);
    assert.ok(secondary.includes('55 Hm'));
    assert.ok(secondary.includes('3× gefahren'));
  });
});

// ---------------------------------------------------------------------
// segmentIsStarred(seg, bucket) -- three-way fallback:
// state.segmentStars -> bucket.details -> seg.starred -> false.
// ---------------------------------------------------------------------
test('segmentIsStarred', async (t) => {
  await t.test('nothing known anywhere -> false (the safe default, never guesses true)', () => {
    const { get } = loadApp();
    const isStarred = get('segmentIsStarred');
    const bucket = { details: {} };
    assert.equal(isStarred({ id: 1 }, bucket), false);
  });

  await t.test('state.segmentStars takes precedence over everything else, both directions', () => {
    const { get } = loadApp();
    const isStarred = get('segmentIsStarred');
    const state = get('state');
    const bucket = { details: { 1: { starred: false } } };
    state.segmentStars[1] = { starred: true, pending: false, error: null };
    assert.equal(isStarred({ id: 1, starred: false }, bucket), true, 'a recorded true must win over a detail/summary saying false');
    state.segmentStars[1] = { starred: false, pending: false, error: null };
    assert.equal(isStarred({ id: 1, starred: true }, bucket), false, 'a recorded false must win over a detail/summary saying true');
  });

  await t.test('a pending entry with no prior known value (starred undefined/null) falls through to bucket.details, not treated as a known false', () => {
    const { get } = loadApp();
    const isStarred = get('segmentIsStarred');
    const state = get('state');
    state.segmentStars[1] = { starred: undefined, pending: true, error: null }; // applySegmentStar()'s in-flight shape when nothing was known before
    const bucket = { details: { 1: { starred: true } } };
    assert.equal(isStarred({ id: 1 }, bucket), true);
  });

  await t.test('no state.segmentStars entry -> falls back to bucket.details[id].starred', () => {
    const { get } = loadApp();
    const isStarred = get('segmentIsStarred');
    assert.equal(isStarred({ id: 1 }, { details: { 1: { starred: true } } }), true);
    assert.equal(isStarred({ id: 1 }, { details: { 1: { starred: false } } }), false);
  });

  await t.test('no segmentStars entry and no detail -> falls back to the bare seg.starred field', () => {
    const { get } = loadApp();
    const isStarred = get('segmentIsStarred');
    const bucket = { details: {} };
    assert.equal(isStarred({ id: 1, starred: true }, bucket), true);
    assert.equal(isStarred({ id: 1, starred: false }, bucket), false);
    assert.equal(isStarred({ id: 1 }, bucket), false, 'a missing seg.starred field must read as not-starred, not throw');
  });

  await t.test('a missing bucket (undefined) does not throw -- falls straight to seg.starred', () => {
    const { get } = loadApp();
    const isStarred = get('segmentIsStarred');
    assert.equal(isStarred({ id: 1, starred: true }, undefined), true);
  });
});
