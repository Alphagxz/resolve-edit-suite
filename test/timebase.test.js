'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tb = require('../plugin/core/timebase');
const tc = require('../plugin/core/timecode');
const { createTimelineContext } = require('../plugin/core/timeline-context');

const RATES = ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60'];

test('parses Resolve rate strings to exact rationals', () => {
  assert.deepEqual(tb.parseFrameRate('23.976'), { num: 24000, den: 1001, label: '23.976' });
  assert.deepEqual(tb.parseFrameRate(23.98), { num: 24000, den: 1001, label: '23.976' });
  assert.deepEqual(tb.parseFrameRate('29.97 DF'), { num: 30000, den: 1001, label: '29.97' });
  assert.deepEqual(tb.parseFrameRate(59.94), { num: 60000, den: 1001, label: '59.94' });
  assert.deepEqual(tb.parseFrameRate({ num: 48000, den: 2002 }), { num: 24000, den: 1001, label: '23.976' });
  assert.equal(tb.parseFrameRate('25').num, 25);
  assert.throws(() => tb.parseFrameRate('17'), /Unsupported/);
  assert.throws(() => tb.parseFrameRate('abc'), /parse/);
  assert.throws(() => tb.parseFrameRate('23.9'), /Unsupported/);
});

test('every supported rate has an exact integer flick duration', () => {
  for (const r of tb.KNOWN_RATES) assert.ok(Number.isInteger(tb.flicksPerFrame(r)), r.label);
  assert.equal(tb.flicksPerFrame(tb.parseFrameRate('23.976')), 29429400);
  assert.equal(tb.flicksPerFrame(tb.parseFrameRate('29.97')), 23543520);
});

test('frame <-> flicks round-trips exactly for all rates over 24 hours', () => {
  for (const label of RATES) {
    const r = tb.parseFrameRate(label);
    const day = Math.round(86400 * tb.rateToFloat(r));
    for (const f of [0, 1, 2, 1000, 17982, 107892, day - 1, day]) {
      assert.equal(tb.flicksToFrames(tb.framesToFlicks(f, r), r), f, `${label} frame ${f}`);
    }
  }
});

test('no cumulative drift: 10 hours of 1/3-second cues at 23.976', () => {
  const r = tb.parseFrameRate('23.976');
  const third = tb.FLICKS_PER_SECOND / 3;
  let prevFrame = -1;
  for (let i = 0; i <= 3 * 36000; i++) {
    const t = Math.round(i * third); // absolute time each step
    const f = tb.flicksToFrames(t, r);
    // Independent reference via exact rational arithmetic in BigInt
    const ref = Number((BigInt(i) * 24000n * 2n + 3n * 1001n) / (2n * 3n * 1001n));
    assert.equal(f, ref);
    assert.ok(f >= prevFrame);
    prevFrame = f;
  }
  // 10h at 23.976 is exactly 863136.86... frames -> rounds to 863137
  assert.equal(tb.flicksToFrames(36000 * tb.FLICKS_PER_SECOND, r), 863137);
});

test('rounding modes and cross-rate conversion', () => {
  const r24 = tb.parseFrameRate('24');
  const half = tb.framesToFlicks(1, r24) / 2;
  assert.equal(tb.flicksToFrames(half, r24, 'floor'), 0);
  assert.equal(tb.flicksToFrames(half, r24, 'ceil'), 1);
  assert.equal(tb.flicksToFrames(half, r24, 'round'), 1);
  assert.equal(tb.convertFrames(24000, tb.parseFrameRate('23.976'), tb.parseFrameRate('29.97')), 30000);
  assert.equal(tb.convertFrames(25, tb.parseFrameRate('25'), tb.parseFrameRate('50')), 50);
  assert.equal(tb.convertFrames(1001, tb.parseFrameRate('24'), tb.parseFrameRate('23.976')), 1000);
  assert.throws(() => tb.flicksToFrames(1.5, r24), /integer/);
});

test('NDF timecode', () => {
  const r = tb.parseFrameRate('25');
  assert.equal(tc.framesToTimecode(90000, r), '01:00:00:00');
  assert.equal(tc.timecodeToFrames('01:00:00:00', r), 90000);
  assert.equal(tc.framesToTimecode(86400, tb.parseFrameRate('23.976')), '01:00:00:00');
  assert.throws(() => tc.timecodeToFrames('00:00:00:25', r), /out of range/);
});

test('29.97 drop-frame known values', () => {
  const r = tb.parseFrameRate('29.97');
  assert.equal(tc.framesToTimecode(1799, r, true), '00:00:59;29');
  assert.equal(tc.framesToTimecode(1800, r, true), '00:01:00;02');
  assert.equal(tc.framesToTimecode(17982, r, true), '00:10:00;00');
  assert.equal(tc.framesToTimecode(107892, r, true), '01:00:00;00');
  assert.equal(tc.timecodeToFrames('01:00:00;00', r), 107892);
  assert.throws(() => tc.timecodeToFrames('00:01:00;00', r), /dropped/);
  assert.equal(tc.timecodeToFrames('00:10:00;00', r), 17982);
});

test('59.94 drop-frame known values and full round-trip', () => {
  const r = tb.parseFrameRate('59.94');
  assert.equal(tc.framesToTimecode(3600, r, true), '00:01:00;04');
  assert.equal(tc.framesToTimecode(215784, r, true), '01:00:00;00');
  for (const rate of [r, tb.parseFrameRate('29.97')]) {
    for (let f = 0; f < 40000; f += 7) assert.equal(tc.timecodeToFrames(tc.framesToTimecode(f, rate, true), rate, true), f);
  }
});

test('drop-frame is refused at rates where it does not exist', () => {
  assert.throws(() => tc.framesToTimecode(10, tb.parseFrameRate('25'), true), /only defined/);
  assert.throws(() => tc.framesToTimecode(10, tb.parseFrameRate('23.976'), true), /only defined/);
});

test('timeline context validates and reports inconsistencies', () => {
  const ctx = createTimelineContext({ frameRate: '29.97', dropFrame: '1', width: 1080, height: 1920, startFrame: 107892, endFrame: 107892 + 899, startTimecode: '01:00:00;00' });
  assert.equal(ctx.aspect, 'vertical');
  assert.equal(ctx.durationFrames, 900);
  assert.equal(ctx.problems.length, 0);
  assert.equal(ctx.timecodeAt(107892 + 1800), '01:01:00;02');
  assert.equal(ctx.toTimelineFrame(tb.secondsToFlicks(1)), 107892 + 30);

  const odd = createTimelineContext({ frameRate: 25, dropFrame: true, width: 1920, height: 1080, startFrame: 90000, endFrame: 90100, startTimecode: '00:59:59:00' });
  assert.equal(odd.dropFrame, false);
  assert.equal(odd.problems.length, 2);
  assert.throws(() => createTimelineContext({ frameRate: 24, width: 0, height: 1080, startFrame: 0, endFrame: 10 }), /resolution/);
});
