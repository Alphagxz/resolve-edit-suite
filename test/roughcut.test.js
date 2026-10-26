'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tb = require('../plugin/core/timebase');
const audio = require('../plugin/core/audio');
const silence = require('../plugin/core/silence');
const { planRoughCut, verifyPlacement } = require('../plugin/core/roughcut');
const { createTimelineContext } = require('../plugin/core/timeline-context');
const { tmpDir, writeWav } = require('./helpers/fixtures');

const S = (s) => tb.secondsToFlicks(s);

// Speech (tone) at 0-1s, 1.2-2s, silence 2-3.5s, speech 3.5-5s, silence 5-6s.
function speech(t) {
  const on = (t < 1) || (t >= 1.2 && t < 2) || (t >= 3.5 && t < 5);
  return on ? 0.5 * Math.sin(2 * Math.PI * 220 * t) : 0.0005 * Math.sin(2 * Math.PI * 50 * t);
}

function envelopeFromWav(file) {
  const buf = fs.readFileSync(file);
  const fmt = audio.parseWavHeader(buf);
  const env = new audio.EnvelopeBuilder(fmt.sampleRate, 10);
  env.push(audio.decodeWavChunk(buf.subarray(fmt.dataOffset, fmt.dataOffset + fmt.dataBytes), fmt));
  return env.finish();
}

test('WAV header parsing and error reporting', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'a.wav');
  writeWav(f, { seconds: 0.1, channels: 2, sample: () => 0.25 });
  const fmt = audio.parseWavHeader(fs.readFileSync(f));
  assert.equal(fmt.channels, 2);
  assert.equal(fmt.frames, 4800);
  assert.throws(() => audio.parseWavHeader(Buffer.from('not a wav at all')), /RIFF/);
});

test('silence detection finds long pauses and keeps short intentional ones', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'speech.wav');
  writeWav(f, { seconds: 6, sample: speech });
  const env = envelopeFromWav(f);
  assert.equal(env.durationFlicks, S(6));
  const { silences, threshold } = silence.findSilences(env, { minSilenceMs: 500 });
  assert.ok(threshold < -20 && threshold >= -60, `threshold ${threshold}`);
  // the 0.2 s pause at 1-1.2 is intentional (shorter than 500 ms) and kept
  assert.equal(silences.length, 2);
  assert.ok(Math.abs(tb.flicksToSeconds(silences[0].start) - 2) < 0.02);
  assert.ok(Math.abs(tb.flicksToSeconds(silences[0].end) - 3.5) < 0.02);
});

test('cut proposals respect padding, kept pause and protected ranges', () => {
  const sil = [{ start: S(2), end: S(3.5) }, { start: S(5), end: S(6) }];
  const cuts = silence.proposeCuts(sil, { paddingMs: 100, keepPauseMs: 200, totalFlicks: S(6), protectedRanges: [{ start: S(2.5), end: S(2.7) }] });
  // first silence split around the protected range; trailing silence removed to the end
  assert.equal(cuts.length, 3);
  assert.equal(cuts[0].start, S(2.2));
  assert.equal(cuts[0].end, S(2.5));
  assert.equal(cuts[1].start, S(2.7));
  assert.equal(cuts[1].end, S(3.3));
  assert.equal(cuts[2].end, S(6));
  const keep = silence.keepRangesFromCuts(cuts, S(6));
  assert.deepEqual(keep.map((k) => [tb.flicksToSeconds(k.start), tb.flicksToSeconds(k.end)]), [[0, 2.2], [2.5, 2.7], [3.3, 5.2]]);
});

test('rough-cut plan at matching rates is continuous and verifiable', () => {
  const ctx = createTimelineContext({ frameRate: '25', width: 1920, height: 1080, startFrame: 90000, endFrame: 90000 + 149 });
  const items = [{ id: 'i1', name: 'A001', recStart: 90000, recEnd: 90150, srcStart: 500, srcRate: tb.parseFrameRate('25'), mediaRef: 'mp1' }];
  const keep = [{ start: S(0), end: S(2) }, { start: S(3.5), end: S(5) }];
  const plan = planRoughCut({ ctx, items, keep });
  assert.equal(plan.blocked.length, 0);
  assert.deepEqual(plan.clipInfos.map((c) => [c.startFrame, c.endFrame, c.recordFrame, c.expectedDuration]), [
    [500, 549, 90000, 50],
    // 3.5 s = frame 87.5 at 25 fps; boundaries round half away from zero -> 88
    [588, 624, 90050, 37],
  ]);
  assert.equal(plan.summary.removedFrames, 150 - 87);
  const actual = plan.clipInfos.map((c) => ({ start: c.recordFrame, end: c.recordFrame + c.expectedDuration }));
  assert.equal(verifyPlacement(plan.clipInfos, actual).ok, true);
  actual[1].start += 1;
  const bad = verifyPlacement(plan.clipInfos, actual);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /Continuity/.test(p)));
});

test('rough-cut plan maps mixed-rate sources through exact rationals and models flooring', () => {
  const ctx = createTimelineContext({ frameRate: '23.976', width: 1080, height: 1920, startFrame: 86400, endFrame: 86400 + 239 });
  const items = [{ id: 'i1', name: 'B', recStart: 86400, recEnd: 86640, srcStart: 0, srcRate: tb.parseFrameRate('29.97'), mediaRef: 'mp' }];
  const plan = planRoughCut({ ctx, items, keep: [{ start: 0, end: ctx.fromTimelineFrame(86400 + 101) }], endFrameInclusive: false });
  const c = plan.clipInfos[0];
  assert.equal(c.startFrame, 0);
  assert.equal(c.endFrame, tb.convertFrames(101, ctx.rate, tb.parseFrameRate('29.97')));
  assert.ok(c.expectedDuration <= 101);
});

test('rough-cut blocks retimed items and overlaps; reports other tracks', () => {
  const ctx = createTimelineContext({ frameRate: '24', width: 1920, height: 1080, startFrame: 0, endFrame: 239 });
  const r = tb.parseFrameRate('24');
  const plan = planRoughCut({
    ctx,
    items: [
      { id: 'a', name: 'A', recStart: 0, recEnd: 120, srcStart: 0, srcRate: r, speed: 50 },
      { id: 'b', name: 'B', recStart: 110, recEnd: 240, srcStart: 0, srcRate: r },
    ],
    keep: [{ start: 0, end: ctx.fromTimelineFrame(100) }],
    otherTrackItems: [{ track: 'A2', name: 'Music', recStart: 0, recEnd: 240 }],
  });
  assert.ok(plan.blocked.some((b) => b.type === 'retimed'));
  assert.ok(plan.blocked.some((b) => b.type === 'overlap'));
  assert.ok(plan.warnings.some((w) => w.type === 'other-track' && /NOT carried/.test(w.message)));
});
