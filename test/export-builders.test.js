'use strict';
// Tests for the .ZWO (Zwift workout XML) and .FIT (binary workout) export
// builders -- flagged as a coverage gap by a full-app audit (04.09.2026):
// pure string/byte builders, no DOM/network, but had zero direct tests even
// though their supporting primitives (fitCrc/fitString/xmlEscape) already
// did (see test/export-helpers.test.js). This file covers the actual
// message/step-layout logic those primitives feed into.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

// ---------------------------------------------------------------------
// buildZwo(workout, rp, goalLabelText)
// ---------------------------------------------------------------------
test('buildZwo', async (t) => {
  function baseWorkout(steps) {
    return { title: 'Sweet Spot 3x10', adaptation: 'Tempo-Reiz', steps };
  }
  function baseRp() {
    return { ftp: 250, ftpSource: 'geschätzt', riderType: 'Allrounder' };
  }

  await t.test('first step becomes <Warmup>, last becomes <Cooldown>, middle steps become <SteadyState>', () => {
    const { get } = loadApp();
    const buildZwo = get('buildZwo');
    const steps = [
      { name: 'Aufwärmen', minutes: 10, pct: 0.5 },
      { name: 'Intervall 1', minutes: 10, pct: 0.9 },
      { name: 'Ausfahren', minutes: 5, pct: 0.4 },
    ];
    const xml = buildZwo(baseWorkout(steps), baseRp(), 'Tempo');
    assert.match(xml, /<Warmup Duration="600" PowerLow="0.375" PowerHigh="0.5">/);
    assert.match(xml, /<SteadyState Duration="600" Power="0.9">/);
    assert.match(xml, /<Cooldown Duration="300" PowerLow="0.4" PowerHigh="0.3">/);
  });

  await t.test('steps with minutes<=0 are filtered out entirely (never rendered as a 0/negative-duration block)', () => {
    const { get } = loadApp();
    const buildZwo = get('buildZwo');
    const steps = [
      { name: 'Aufwärmen', minutes: 10, pct: 0.5 },
      { name: 'Leer', minutes: 0, pct: 0.9 },
      { name: 'Ausfahren', minutes: 5, pct: 0.4 },
    ];
    const xml = buildZwo(baseWorkout(steps), baseRp(), 'Tempo');
    assert.equal(xml.includes('Leer'), false);
    // Only 2 steps survive the filter -> first is Warmup, second is
    // Cooldown (the zero-duration step never occupies the "middle" slot).
    assert.match(xml, /<Warmup/);
    assert.match(xml, /<Cooldown/);
    assert.equal(xml.includes('<SteadyState'), false);
  });

  await t.test('a single-step workout renders as Warmup, not Cooldown (i===0 is checked first)', () => {
    const { get } = loadApp();
    const buildZwo = get('buildZwo');
    const steps = [{ name: 'Alles', minutes: 20, pct: 0.7 }];
    const xml = buildZwo(baseWorkout(steps), baseRp(), 'Tempo');
    assert.match(xml, /<Warmup Duration="1200" PowerLow="0.525" PowerHigh="0.7">/);
    assert.equal(xml.includes('<Cooldown'), false);
    assert.equal(xml.includes('<SteadyState'), false);
  });

  await t.test('a two-step workout has a Warmup and a Cooldown, no SteadyState', () => {
    const { get } = loadApp();
    const buildZwo = get('buildZwo');
    const steps = [
      { name: 'Erst', minutes: 10, pct: 0.5 },
      { name: 'Zweit', minutes: 10, pct: 0.6 },
    ];
    const xml = buildZwo(baseWorkout(steps), baseRp(), 'Tempo');
    assert.match(xml, /<Warmup/);
    assert.match(xml, /<Cooldown/);
    assert.equal(xml.includes('<SteadyState'), false);
  });

  await t.test('duration rounds to the nearest second and floors at 1s, never 0', () => {
    const { get } = loadApp();
    const buildZwo = get('buildZwo');
    const steps = [
      { name: 'A', minutes: 0.008, pct: 0.5 }, // 0.48s -> rounds to 0 -> floored to 1
      { name: 'B', minutes: 1.501, pct: 0.6 }, // 90.06s -> rounds to 90
      { name: 'C', minutes: 5, pct: 0.7 },
    ];
    const xml = buildZwo(baseWorkout(steps), baseRp(), 'Tempo');
    assert.match(xml, /<Warmup Duration="1"/);
    assert.match(xml, /<SteadyState Duration="90"/);
  });

  await t.test('power fraction is rounded to 3 decimal places', () => {
    const { get } = loadApp();
    const buildZwo = get('buildZwo');
    const steps = [
      { name: 'A', minutes: 5, pct: 0.5 },
      { name: 'B', minutes: 5, pct: 0.33333333 },
      { name: 'C', minutes: 5, pct: 0.6 },
    ];
    const xml = buildZwo(baseWorkout(steps), baseRp(), 'Tempo');
    assert.match(xml, /<SteadyState Duration="300" Power="0.333">/);
  });

  await t.test('XML-unsafe characters in title/step name/description are escaped', () => {
    const { get } = loadApp();
    const buildZwo = get('buildZwo');
    const xmlEscape = get('xmlEscape');
    const workout = { title: 'Tempo & "Base" <hart>', adaptation: 'A&B', steps: [
      { name: '3x8\' @ 90%', minutes: 8, pct: 0.9 },
      { name: 'Ende', minutes: 5, pct: 0.5 },
    ] };
    const xml = buildZwo(workout, baseRp(), 'Ziel <X>');
    assert.ok(xml.includes(`<name>${xmlEscape(workout.title)}</name>`));
    assert.ok(xml.includes(xmlEscape("3x8' @ 90%")));
    assert.ok(!xml.includes('<hart>'), 'raw unescaped angle brackets must never appear in the step/title text');
  });

  await t.test('overall envelope: XML declaration, single <workout> block, matches the expected line order', () => {
    const { get } = loadApp();
    const buildZwo = get('buildZwo');
    const steps = [
      { name: 'A', minutes: 5, pct: 0.5 },
      { name: 'B', minutes: 5, pct: 0.6 },
    ];
    const xml = buildZwo(baseWorkout(steps), baseRp(), 'Tempo');
    const lines = xml.split('\n');
    assert.equal(lines[0], '<?xml version="1.0" encoding="UTF-8"?>');
    assert.equal(lines[1], '<workout_file>');
    assert.equal(lines[lines.length - 1], '</workout_file>');
    assert.equal((xml.match(/<workout>/g) || []).length, 1);
    assert.equal((xml.match(/<\/workout>/g) || []).length, 1);
  });
});

// ---------------------------------------------------------------------
// Shared byte-level helpers for buildFit()/buildCourseFit() -- a small
// sequential reader that decodes the buffer in EXACTLY the order the
// encoder writes it (mirroring index.html's own u8/u16/u32 push sequence
// field-by-field), rather than hardcoded absolute offsets -- keeps the
// tests readable and makes a genuine layout mismatch fail loudly instead
// of silently reading garbage from the wrong offset.
// ---------------------------------------------------------------------
function makeFitReader(bytes) {
  let pos = 0;
  return {
    u8() { return bytes[pos++]; },
    u16() { const v = (bytes[pos] | (bytes[pos + 1] << 8)) >>> 0; pos += 2; return v; },
    u32() { const v = (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0; pos += 4; return v; },
    bytes(n) { const out = Array.from(bytes.slice(pos, pos + n)); pos += n; return out; },
    get pos() { return pos; },
  };
}
// fitString() zero-pads a fixed-length buffer -- decode back to a plain JS
// string by stopping at the first null byte.
function asciiFromFitStringBytes(arr) {
  const end = arr.indexOf(0);
  return String.fromCharCode(...(end === -1 ? arr : arr.slice(0, end)));
}
function assertFitEnvelope(bytes, get) {
  const fitCrc = get('fitCrc');
  // Object.prototype.toString.call() (not `instanceof`) -- the buffer is a
  // Uint8Array constructed inside the vm sandbox's own realm, so it fails
  // `instanceof Uint8Array` against this file's outer-realm constructor
  // even though it genuinely is one; toString.call() reads the internal
  // [[Class]]/Symbol.toStringTag instead of walking the prototype chain,
  // so it works across realms.
  assert.equal(Object.prototype.toString.call(bytes), '[object Uint8Array]', 'buildFit()/buildCourseFit() must return a Uint8Array');
  assert.equal(bytes[0], 12, 'header size byte');
  assert.equal(bytes[1], 0x20, 'protocol version byte');
  const profileVersion = bytes[2] | (bytes[3] << 8);
  assert.equal(profileVersion, 100);
  const dataSize = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  assert.equal(dataSize, bytes.length - 12 - 2, 'header data-size field must match body length (total minus 12-byte header minus 2-byte trailing CRC)');
  assert.deepEqual(Array.from(bytes.slice(8, 12)), [0x2E, 0x46, 0x49, 0x54], '".FIT" signature');
  const expectedCrc = fitCrc(Array.from(bytes), 0, bytes.length - 2, 0);
  const actualCrc = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
  assert.equal(actualCrc, expectedCrc, 'trailing CRC-16 must match an independent fitCrc() computation over everything before it');
}
// Decodes a buildFit() workout buffer sequentially, mirroring the encoder's
// own write order line-for-line (file_id -> workout -> workout_step
// definition -> one data record per step -> trailing CRC).
function decodeFitWorkout(bytes) {
  const r = makeFitReader(bytes);
  r.bytes(12); // file header, checked separately via assertFitEnvelope()
  // file_id definition + data record
  r.u8(); r.u8(); r.u8(); r.u16(); const fidFields = r.u8();
  for (let i = 0; i < fidFields; i++) r.bytes(3);
  r.u8(); // data record header
  const fileType = r.u8(); const manufacturer = r.u16(); const product = r.u16(); const timeCreated = r.u32();
  // workout definition + data record
  r.u8(); r.u8(); r.u8(); r.u16(); const wkFields = r.u8();
  for (let i = 0; i < wkFields; i++) r.bytes(3);
  r.u8();
  const sport = r.u8(); const capabilities = r.u32(); const numValidSteps = r.u16();
  const title = asciiFromFitStringBytes(r.bytes(24));
  // workout_step definition
  r.u8(); r.u8(); r.u8(); r.u16(); const stepFields = r.u8();
  for (let i = 0; i < stepFields; i++) r.bytes(3);
  const steps = [];
  for (let i = 0; i < numValidSteps; i++) {
    r.u8(); // data record header
    const index = r.u16();
    const name = asciiFromFitStringBytes(r.bytes(24));
    const durationType = r.u8();
    const durationValue = r.u32();
    const targetType = r.u8();
    const customTarget = r.u32();
    const lo = r.u32();
    const hi = r.u32();
    const intensity = r.u8();
    steps.push({ index, name, durationType, durationValue, targetType, customTarget, lo, hi, intensity });
  }
  return { fileType, manufacturer, product, timeCreated, sport, capabilities, numValidSteps, title, steps };
}

// ---------------------------------------------------------------------
// buildFit(workout, rp)
// ---------------------------------------------------------------------
test('buildFit', async (t) => {
  await t.test('envelope: header fields, CRC, and title/step-count survive the round trip', () => {
    const { get } = loadApp();
    const buildFit = get('buildFit');
    const workout = { title: 'Sweet Spot 3x10', routeBased: false, steps: [{ name: 'Alles', minutes: 10, pct: 0.9 }] };
    const rp = { usingHr: false, ftp: 200 };
    const bytes = buildFit(workout, rp);
    assertFitEnvelope(bytes, get);
    const decoded = decodeFitWorkout(bytes);
    assert.equal(decoded.title, 'Sweet Spot 3x10');
    assert.equal(decoded.numValidSteps, 1);
    assert.equal(decoded.fileType, 5, 'file_id type=5 (workout)');
  });

  await t.test('power-mode: target/duration/intensity math across a 3-step warmup/interval/cooldown workout', () => {
    const { get } = loadApp();
    const buildFit = get('buildFit');
    const workout = {
      title: 'Test', routeBased: false,
      steps: [
        { name: 'Warmup', minutes: 10, pct: 0.5 },
        { name: 'Interval', minutes: 10, pct: 0.9 },
        { name: 'Cooldown', minutes: 5, pct: 0.4 },
      ],
    };
    const rp = { usingHr: false, ftp: 200 };
    const { steps } = decodeFitWorkout(buildFit(workout, rp));
    assert.equal(steps.length, 3);

    // Step 0 (warmup): target = round(0.5*200) = 100W, +-4% band, offset
    // +1000 (workout_power field-type convention), intensity forced to 2
    // (warmup) purely by being index 0.
    assert.equal(steps[0].targetType, 4, 'power');
    assert.equal(steps[0].lo, 1096); // 1000 + (100 - round(100*0.04))
    assert.equal(steps[0].hi, 1104); // 1000 + 100 + round(100*0.04)
    assert.equal(steps[0].durationType, 0, 'time-based');
    assert.equal(steps[0].durationValue, 600000, '10 minutes in milliseconds');
    assert.equal(steps[0].intensity, 2);

    // Step 1 (middle, pct=0.9 > 0.6 -> "active" intensity 0).
    assert.equal(steps[1].lo, 1173); // 1000 + (180 - round(180*0.04)=7)
    assert.equal(steps[1].hi, 1187); // 1000 + 180 + 7
    assert.equal(steps[1].intensity, 0);

    // Step 2 (last -> cooldown intensity 3, regardless of its own pct).
    assert.equal(steps[2].lo, 1077); // 1000 + (80 - round(80*0.04)=3)
    assert.equal(steps[2].hi, 1083);
    assert.equal(steps[2].durationValue, 300000, '5 minutes in milliseconds');
    assert.equal(steps[2].intensity, 3);
  });

  await t.test('a middle step with pct<=0.6 gets "recovery" intensity (1), not "active" (0)', () => {
    const { get } = loadApp();
    const buildFit = get('buildFit');
    const workout = {
      title: 'Test', routeBased: false,
      steps: [
        { name: 'Warmup', minutes: 5, pct: 0.5 },
        { name: 'Recovery', minutes: 3, pct: 0.55 },
        { name: 'Cooldown', minutes: 5, pct: 0.4 },
      ],
    };
    const { steps } = decodeFitWorkout(buildFit(workout, { usingHr: false, ftp: 200 }));
    assert.equal(steps[1].intensity, 1);
  });

  await t.test('HR-mode: target type is heart_rate (1) with the +100 field-type offset, computed from %LTHR', () => {
    const { get } = loadApp();
    const buildFit = get('buildFit');
    const workout = { title: 'Test', routeBased: false, steps: [{ name: 'Steady', minutes: 10, pct: 0.9 }] };
    const rp = { usingHr: true, lthr: 150 };
    const { steps } = decodeFitWorkout(buildFit(workout, rp));
    // target = round(0.9*150) = 135, +-4% band = +-5 (round(135*0.04)=5), offset +100.
    assert.equal(steps[0].targetType, 1, 'heart_rate');
    assert.equal(steps[0].lo, 230); // 100 + 135 - 5
    assert.equal(steps[0].hi, 240); // 100 + 135 + 5
  });

  await t.test('an RPE-tagged step in HR mode has an "open" target (no bpm range) and an "RPE {x} - " name prefix', () => {
    const { get } = loadApp();
    const buildFit = get('buildFit');
    const workout = { title: 'Test', routeBased: false, steps: [{ name: 'Sprint 1', minutes: 0.5, pct: 1.5, rpeLabel: 'Sprint', rpeTarget: 9 }] };
    const rp = { usingHr: true, lthr: 150 };
    const { steps } = decodeFitWorkout(buildFit(workout, rp));
    assert.equal(steps[0].targetType, 2, 'open (no real-time target)');
    assert.equal(steps[0].lo, 0);
    assert.equal(steps[0].hi, 0);
    assert.equal(steps[0].name, 'RPE 9 - Sprint 1');
  });

  await t.test('a distance-based step (routeBased=false, distanceM set) uses duration_type=distance, scaled by 100', () => {
    const { get } = loadApp();
    const buildFit = get('buildFit');
    const workout = { title: 'Test', routeBased: false, steps: [{ name: 'Distanz', distanceM: 1500, pct: 0.9 }] };
    const { steps } = decodeFitWorkout(buildFit(workout, { usingHr: false, ftp: 200 }));
    assert.equal(steps[0].durationType, 1, 'distance-based');
    assert.equal(steps[0].durationValue, 150000); // 1500m * 100
  });

  await t.test('steps with neither a positive duration nor a positive distance are filtered out', () => {
    const { get } = loadApp();
    const buildFit = get('buildFit');
    const workout = {
      title: 'Test', routeBased: false,
      steps: [
        { name: 'Real', minutes: 10, pct: 0.9 },
        { name: 'Leer', minutes: 0, pct: 0.9 }, // no minutes AND no distanceM
      ],
    };
    const { numValidSteps, steps } = decodeFitWorkout(buildFit(workout, { usingHr: false, ftp: 200 }));
    assert.equal(numValidSteps, 1);
    assert.equal(steps[0].name, 'Real');
  });
});

// ---------------------------------------------------------------------
// buildCourseFit(route, rp) -- deliberately minimal per its own comment:
// file_id + one `record` (global 20) message per downsampled route point.
// ---------------------------------------------------------------------
test('buildCourseFit', async (t) => {
  function decodeFitCourse(bytes) {
    const r = makeFitReader(bytes);
    r.bytes(12);
    // file_id definition + data record
    r.u8(); r.u8(); r.u8(); r.u16(); const fidFields = r.u8();
    for (let i = 0; i < fidFields; i++) r.bytes(3);
    r.u8();
    const fileType = r.u8(); r.u16(); r.u16(); r.u32();
    // record (global 20) definition
    r.u8(); r.u8(); r.u8(); r.u16(); const recFields = r.u8();
    for (let i = 0; i < recFields; i++) r.bytes(3);
    const records = [];
    // Each record data byte-count = 1 (header) + 4 (timestamp) + 4 (lat)
    // + 4 (lon) + 2 (altitude) + 4 (distance) = 19 bytes; keep decoding
    // until only the trailing 2-byte CRC is left.
    while (bytes.length - r.pos > 2) {
      r.u8();
      const timestamp = r.u32();
      const lat = r.u32() | 0; // back to signed for semicircle math
      const lon = r.u32() | 0;
      const altitude = r.u16();
      const distance = r.u32();
      records.push({ timestamp, lat, lon, altitude, distance });
    }
    return { fileType, records };
  }

  await t.test('envelope: header/CRC, and one record per downsampled route point', () => {
    const { get } = loadApp();
    const buildCourseFit = get('buildCourseFit');
    const downsampleRoutePoints = get('downsampleRoutePoints');
    const route = {
      points: [
        { lat: 45, lon: 90, dist: 0, ele: 500 },
        { lat: 45.01, lon: 90.01, dist: 1200, ele: 520 },
        { lat: 45.02, lon: 90.02, dist: 2500, ele: 480 },
      ],
      segments: [],
    };
    const rp = { usingHr: false, speedModel: null };
    const bytes = buildCourseFit(route, rp);
    assertFitEnvelope(bytes, get);
    const { records } = decodeFitCourse(bytes);
    const expectedPointCount = downsampleRoutePoints(
      route.points.map(p => ({ lat: p.lat, lon: p.lon, dist: p.dist, ele: p.ele })),
      20
    ).length;
    assert.equal(records.length, expectedPointCount);
  });

  await t.test('file_id type=6 (course), distinct from a workout FIT file\'s type=5', () => {
    const { get } = loadApp();
    const buildCourseFit = get('buildCourseFit');
    const route = { points: [{ lat: 45, lon: 90, dist: 0, ele: 500 }, { lat: 45.01, lon: 90.01, dist: 1200, ele: 500 }, { lat: 45.02, lon: 90.02, dist: 2500, ele: 500 }], segments: [] };
    const { fileType } = decodeFitCourse(buildCourseFit(route, { usingHr: false, speedModel: null }));
    assert.equal(fileType, 6);
  });

  await t.test('first record encodes lat/lon as semicircles, altitude offset by +500m scaled x5, and distance scaled x100', () => {
    const { get } = loadApp();
    const buildCourseFit = get('buildCourseFit');
    // Clean fractions of 180 so the semicircle conversion lands on exact integers.
    const route = {
      points: [
        { lat: 45, lon: 90, dist: 0, ele: 500 }, // ele+500=1000 -> *5 = 5000
        { lat: 45.01, lon: 90.01, dist: 1200, ele: 520 },
        { lat: 45.02, lon: 90.02, dist: 2500, ele: 480 },
      ],
      segments: [],
    };
    const { records } = decodeFitCourse(buildCourseFit(route, { usingHr: false, speedModel: null }));
    const first = records[0];
    assert.equal(first.lat, Math.round(45 * (0x80000000 / 180)));
    assert.equal(first.lon, Math.round(90 * (0x80000000 / 180)));
    assert.equal(first.altitude, 5000);
    assert.equal(first.distance, 0);
  });
});
