'use strict';
// parseGpxTrack(xmlText) (index.html, "---------- GPX import ----------"
// section, ~line 4866) -- lets the wind/map pipeline run on any GPX file, not
// just past Strava activities. Previously untestable: it calls
// `new DOMParser().parseFromString(...)`, and the vm-sandboxed test harness
// (test/support/loadApp.js) had no DOMParser at all, so any call threw
// `ReferenceError: DOMParser is not defined`. A minimal, hand-written
// GPX-only DOMParser stub was added to loadApp.js's sandbox (see the
// `DOMParserStub`/`makeGpxNodeStub` comments there) to close that gap --
// deliberately regex-based, not a real XML/DOM parser and not a new npm
// dependency (this repo ships zero dependencies by design).
//
// `grep -n "DOMParser" index.html` confirms parseGpxTrack() is the ONLY call
// site in the app, so these tests (and the stub) only need to cover its exact
// narrow usage: `.querySelector("parsererror")`, `.querySelectorAll("trkpt,
// rtept")`, `.getAttribute("lat"|"lon")`, and a child `.querySelector("ele")`
// with `.textContent`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./support/loadApp.js');

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

test('parseGpxTrack', async (t) => {
  await t.test('valid GPX with <trkpt> elements, some with <ele> and some without', () => {
    const { get } = loadApp();
    const parseGpxTrack = get('parseGpxTrack');
    const xml = `<?xml version="1.0"?>
<gpx><trk><trkseg>
  <trkpt lat="52.5200" lon="13.4050"><ele>34.5</ele></trkpt>
  <trkpt lat="52.5210" lon="13.4060"></trkpt>
  <trkpt lat="52.5220" lon="13.4070"><ele>36.1</ele></trkpt>
</trkseg></trk></gpx>`;
    const result = parseGpxTrack(xml);
    assert.deepEqual(plain(result.coords), [[52.5200, 13.4050], [52.5210, 13.4060], [52.5220, 13.4070]]);
    assert.deepEqual(plain(result.eles), [34.5, null, 36.1]);
  });

  await t.test('valid GPX with <rtept> elements instead of <trkpt> (route, not track)', () => {
    const { get } = loadApp();
    const parseGpxTrack = get('parseGpxTrack');
    const xml = `<gpx><rte>
  <rtept lat="48.8566" lon="2.3522"><ele>35</ele></rtept>
  <rtept lat="48.8570" lon="2.3530"><ele>36</ele></rtept>
</rte></gpx>`;
    const result = parseGpxTrack(xml);
    assert.deepEqual(plain(result.coords), [[48.8566, 2.3522], [48.8570, 2.3530]]);
    assert.deepEqual(plain(result.eles), [35, 36]);
  });

  await t.test('self-closing <trkpt .../> points (no children at all, so no <ele>) are still valid, ele -> null', () => {
    const { get } = loadApp();
    const parseGpxTrack = get('parseGpxTrack');
    const xml = `<gpx><trk><trkseg>
  <trkpt lat="10" lon="20"/>
  <trkpt lat="10.001" lon="20.001"/>
</trkseg></trk></gpx>`;
    const result = parseGpxTrack(xml);
    assert.deepEqual(plain(result.coords), [[10, 20], [10.001, 20.001]]);
    assert.deepEqual(plain(result.eles), [null, null]);
  });

  await t.test('fewer than 2 valid points -> null (a single trkpt is not a usable track)', () => {
    const { get } = loadApp();
    const parseGpxTrack = get('parseGpxTrack');
    const xml = `<gpx><trk><trkseg><trkpt lat="1" lon="2"><ele>10</ele></trkpt></trkseg></trk></gpx>`;
    assert.equal(parseGpxTrack(xml), null);
  });

  await t.test('zero points -> null', () => {
    const { get } = loadApp();
    const parseGpxTrack = get('parseGpxTrack');
    const xml = `<gpx><trk><trkseg></trkseg></trk></gpx>`;
    assert.equal(parseGpxTrack(xml), null);
  });

  await t.test('invalid lat/lon points mixed with valid ones are skipped, not crashing, and do not appear in coords/eles', () => {
    const { get } = loadApp();
    const parseGpxTrack = get('parseGpxTrack');
    const xml = `<gpx><trk><trkseg>
  <trkpt lat="52.5" lon="13.4"><ele>10</ele></trkpt>
  <trkpt lat="not-a-number" lon="13.41"><ele>11</ele></trkpt>
  <trkpt lat="52.52" lon="bogus"><ele>12</ele></trkpt>
  <trkpt lat="52.53" lon="13.43"><ele>13</ele></trkpt>
</trkseg></trk></gpx>`;
    const result = parseGpxTrack(xml);
    // Only the two structurally valid points survive; the two malformed ones
    // (in the middle) are silently dropped rather than producing NaN entries.
    assert.deepEqual(plain(result.coords), [[52.5, 13.4], [52.53, 13.43]]);
    assert.deepEqual(plain(result.eles), [10, 13]);
  });

  await t.test('a point missing the lat attribute entirely (getAttribute -> null) is skipped, not NaN-crashed', () => {
    const { get } = loadApp();
    const parseGpxTrack = get('parseGpxTrack');
    const xml = `<gpx><trk><trkseg>
  <trkpt lon="13.4"><ele>10</ele></trkpt>
  <trkpt lat="52.5" lon="13.4"><ele>11</ele></trkpt>
  <trkpt lat="52.51" lon="13.41"><ele>12</ele></trkpt>
</trkseg></trk></gpx>`;
    const result = parseGpxTrack(xml);
    assert.deepEqual(plain(result.coords), [[52.5, 13.4], [52.51, 13.41]]);
  });

  await t.test('malformed/non-XML input (does not even open like a tag): the stub\'s parsererror heuristic fires and parseGpxTrack bails to null', () => {
    const { get } = loadApp();
    const parseGpxTrack = get('parseGpxTrack');
    // This documents the ACTUAL behavior of the hand-written stub in
    // loadApp.js (a "does this start like XML at all" heuristic), not a
    // claim about what a real XML parser would do with arbitrary malformed
    // input -- see the stub's own comments for why this heuristic is enough
    // for parseGpxTrack()'s one call site.
    const result = parseGpxTrack('this is plainly not a gpx file at all');
    assert.equal(result, null);
  });

  await t.test('empty string input -> also treated as parsererror -> null', () => {
    const { get } = loadApp();
    const parseGpxTrack = get('parseGpxTrack');
    assert.equal(parseGpxTrack(''), null);
  });

  await t.test('well-formed-looking XML with no trkpt/rtept elements at all (e.g. just waypoints) -> null, not a crash', () => {
    const { get } = loadApp();
    const parseGpxTrack = get('parseGpxTrack');
    const xml = `<gpx><wpt lat="1" lon="2"><name>Start</name></wpt></gpx>`;
    assert.equal(parseGpxTrack(xml), null);
  });
});
