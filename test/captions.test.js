'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tb = require('../plugin/core/timebase');
const subs = require('../plugin/core/subtitles');
const seg = require('../plugin/core/segmenter');
const { finalizeCues, validateCues, cuesToRelative } = require('../plugin/core/cues');
const { createTimelineContext } = require('../plugin/core/timeline-context');
const { captionLayout, scaleForResolution } = require('../plugin/core/layout');

const S = (s) => tb.secondsToFlicks(s);

test('SRT parse handles BOM, CRLF, missing ids and period separators', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\nworld\r\n\r\n00:00:03.000 --> 00:00:04,000\r\nNext\r\n';
  const { cues } = subs.parseSrt(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello\nworld');
  assert.equal(cues[0].start, S(1));
  assert.equal(cues[0].end, S(2.5));
  assert.equal(cues[1].start, S(3));
  assert.throws(() => subs.parseSrt('1\n00:00:01 --> 00:00:02\nx'), /Invalid SRT timing/);
});

test('SRT write/parse round-trip is lossless at ms precision', () => {
  const cues = [{ start: S(0.04), end: S(1.001), text: 'A' }, { start: S(3661.5), end: S(3662), text: 'B\nC' }];
  const back = subs.parseSrt(subs.writeSrt(cues)).cues;
  assert.deepEqual(back.map((c) => [c.start, c.end, c.text]), cues.map((c) => [c.start, c.end, c.text]));
});

test('WebVTT parse with settings, notes and short times', () => {
  const vtt = 'WEBVTT\n\nNOTE hi\n\nid1\n00:01.000 --> 00:02.000 align:center\n<b>Bold</b> text\n';
  const { cues } = subs.parseVtt(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Bold text');
  assert.equal(cues[0].id, 'id1');
});

test('Resolve 21.1 transcription payload with timecode and ms strings', () => {
  const r = tb.parseFrameRate('25');
  const out = subs.fromResolveTranscription({
    language: 'en',
    segments: [{ start: '01:00:01:00', end: '01:00:02:00', text: 'Hi there', speaker: 'A', words: [{ start: '01:00:01:00', end: '01:00:01:10', text: 'Hi' }, { start: '01:00:01:12', end: '01:00:02:00', text: 'there' }] }],
  }, r, 90000);
  assert.equal(out.segments[0].start, S(1));
  assert.equal(out.segments[0].words[1].start, S(1.48));
  assert.throws(() => subs.fromResolveTranscription({}, r), /segments/);
});

const words = (spec) => spec.map(([text, s, e]) => ({ text, start: S(s), end: S(e) }));

test('segmenter respects max chars/lines and balances lines', () => {
  const w = words([
    ['This', 0, 0.2], ['is', 0.2, 0.3], ['a', 0.3, 0.4], ['fairly', 0.4, 0.7], ['long', 0.7, 0.9], ['sentence', 0.9, 1.3],
    ['that', 1.3, 1.5], ['needs', 1.5, 1.8], ['to', 1.8, 1.9], ['wrap', 1.9, 2.2], ['nicely', 2.2, 2.6], ['onto', 2.6, 2.8],
    ['two', 2.8, 3.0], ['lines.', 3.0, 3.4], ['Then', 4.5, 4.7], ['more', 4.7, 5.0],
  ]);
  const { cues } = seg.segmentWords(w, { maxCharsPerLine: 24, maxLines: 2 });
  for (const c of cues) {
    assert.ok(c.lines.length <= 2);
    for (const l of c.lines) assert.ok(l.length <= 24, l);
  }
  // sentence end + 1.1s pause splits before "Then"
  assert.equal(cues[cues.length - 1].text, 'Then more');
  // no line ends in a dangling function word when avoidable
  for (const c of cues) for (const l of c.lines.slice(0, -1)) assert.ok(!/\b(a|the|to)$/i.test(l), l);
});

test('captions from a subtitle file never merge words across its entries', () => {
  const words = seg.estimateWordTimings([
    { start: S(1), end: S(3.2), text: 'This is a test caption for Edit Suite' },
    { start: S(3.5), end: S(6), text: 'We grew our revenue 300% in one quarter' },
  ]);
  const { cues } = seg.segmentWords(words, {});
  assert.deepEqual(cues.map((c) => c.text.replace(/\n/g, ' ')), ['This is a test caption for Edit Suite', 'We grew our revenue 300% in one quarter']);
  // still splits long entries when they do not fit
  const long = seg.segmentWords(words, { maxCharsPerLine: 12, maxLines: 1 }).cues;
  assert.ok(long.length > 2 && long.every((c) => c.lines[0].length <= 12));
  assert.ok(!long.some((c) => /Suite We/.test(c.text)));
});

test('breakLines refuses what cannot fit', () => {
  assert.equal(seg.breakLines(['supercalifragilistic'], 10, 2), null);
  assert.deepEqual(seg.breakLines(['short'], 10, 2), ['short']);
});

test('word-pop mode, casing and emphasis', () => {
  const w = words([['we', 0, 0.2], ['grew', 0.2, 0.5], ['300%', 0.5, 0.9], ['in', 0.9, 1.0], ['MAY', 1.0, 1.4]]);
  const { cues } = seg.segmentWords(w, { maxWordsPerCue: 2, caseMode: 'upper', emphasis: { numbers: true, words: ['grew'] } });
  assert.deepEqual(cues.map((c) => c.text), ['WE GREW', '300% IN', 'MAY']);
  assert.equal(cues[0].words[1].emphasis, true);
  assert.equal(cues[1].words[0].emphasis, true);
  assert.equal(cues[1].words[1].emphasis, false);
});

test('estimated word timings are flagged and bounded by the segment', () => {
  const est = seg.estimateWordTimings([{ start: S(1), end: S(3), text: 'one two three' }]);
  assert.equal(est.length, 3);
  assert.ok(est.every((w) => w.estimated && w.start >= S(1) && w.end <= S(3)));
  assert.equal(est[2].end, S(3));
});

test('option validation', () => {
  assert.throws(() => seg.segmentWords([], { maxCharsPerLine: 2 }), /maxCharsPerLine/);
  assert.throws(() => seg.segmentWords([], { minDurationMs: 9000, maxDurationMs: 1000 }), /minDurationMs/);
});

for (const [label, w, h] of [['23.976', 1920, 1080], ['29.97', 1080, 1920], ['25', 1080, 1080], ['59.94', 3840, 2160], ['50', 1080, 1350]]) {
  test(`finalizeCues at ${label} fps ${w}x${h}: no overlap, inside timeline, frame-aligned`, () => {
    const r = tb.parseFrameRate(label);
    const start = Math.round(3600 * tb.rateToFloat(r));
    const ctx = createTimelineContext({ frameRate: label, width: w, height: h, startFrame: start, endFrame: start + Math.round(20 * tb.rateToFloat(r)) - 1 });
    const cues = [
      { id: 'a', start: S(-0.5), end: S(1) }, // starts before timeline
      { id: 'b', start: S(0.9), end: S(2) }, // overlaps a
      { id: 'c', start: S(2), end: S(2.001) }, // rounds to zero frames
      { id: 'd', start: S(19.5), end: S(25) }, // runs past end
      { id: 'e', start: S(30), end: S(31) }, // outside
    ].map((c) => ({ ...c, text: c.id }));
    const { cues: out, report } = finalizeCues(cues, ctx, { minGapFrames: 1 });
    assert.deepEqual(validateCues(out, ctx), []);
    assert.deepEqual(out.map((c) => c.id), ['a', 'b', 'c', 'd']);
    assert.ok(report.some((x) => x.type === 'outside' && x.id === 'e'));
    assert.ok(report.some((x) => x.type === 'clamped' && x.id === 'd'));
    for (let i = 1; i < out.length; i++) assert.ok(out[i].startFrame >= out[i - 1].endFrame + 1);
    // relative export stays within the timeline
    for (const c of cuesToRelative(out, ctx)) assert.ok(c.start >= 0 && c.end <= ctx.durationFlicks);
  });
}

test('finalizeCues applies offset and user timing shift exactly', () => {
  const ctx = createTimelineContext({ frameRate: '24', width: 1920, height: 1080, startFrame: 86400, endFrame: 86400 + 2399 });
  const { cues } = finalizeCues([{ id: '1', start: S(1), end: S(2), text: 'x' }], ctx, { offset: S(10), timingShiftMs: -500 });
  assert.equal(cues[0].startFrame, 86400 + 24 * 10.5);
  assert.equal(cues[0].endFrame, 86400 + 24 * 11.5);
});

test('caption layout for horizontal, vertical and square frames', () => {
  const h = captionLayout({ width: 1920, height: 1080, aspect: 'horizontal' });
  const v = captionLayout({ width: 1080, height: 1920, aspect: 'vertical' });
  const sq = captionLayout({ width: 1080, height: 1080, aspect: 'square' });
  for (const l of [h, v, sq]) {
    assert.ok(l.fits);
    assert.ok(l.box.x >= l.safe.x && l.box.x + l.box.w <= l.safe.x + l.safe.w);
    assert.ok(l.fusion.center.x > 0 && l.fusion.center.x < 1 && l.fusion.center.y > 0 && l.fusion.center.y < 1);
  }
  assert.equal(h.zone, 'title-safe');
  assert.equal(v.zone, 'social-vertical');
  assert.equal(sq.zone, 'social-square');
  // vertical captions sit above the bottom overlay zone
  assert.ok(v.box.y + v.box.h <= 1920 * 0.8);
  assert.throws(() => captionLayout({ width: 1920, height: 1080 }, { zone: { top: 0.6, bottom: 0, left: 0, right: 0 } }), /Safe zone/);
  const s = scaleForResolution({ width: 1920, height: 1080 }, { width: 1080, height: 1920 });
  assert.ok(Math.abs(s.sizeFactor - 1.77778) < 1e-3);
});

const { patchCompText, readCompText } = require('../plugin/core/comp-text');

test('comp text: follower words replaced, connection kept, escaping safe', () => {
  const lua = 'Composition {\n\tTools = ordered() {\n\t\tTemplate = TextPlus { Inputs = { StyledText = Input { SourceOp = "Follower1", Source = "StyledText", }, Font = Input { Value = "Helvetica", }, }, },\n\t\tFollower1 = StyledTextFollower { Inputs = { Delay = Input { Value = 0.46, }, Text = Input { Value = StyledText { Value = "Smooth Word Up" }, }, }, },\n\t}\n}';
  assert.equal(readCompText(lua), 'Smooth Word Up');
  const p = patchCompText(lua, 'He said "hi" \\ 100%\nnext');
  assert.equal(p.ok, true);
  assert.equal(p.target, 'follower');
  assert.equal(readCompText(p.lua), 'He said "hi" \\ 100%\nnext');
  assert.match(p.lua, /StyledText = Input \{ SourceOp = "Follower1"/, 'Text+ stays driven by the follower');
  assert.match(p.lua, /Font = Input \{ Value = "Helvetica"/, 'other inputs untouched');
});

test('comp text: direct Text+ presets, and honest refusals', () => {
  const direct = 'Composition { Tools = ordered() { Template = TextPlus { Inputs = { StyledText = Input { Value = "Glitch Text", }, }, }, } }';
  const p = patchCompText(direct, 'New words');
  assert.equal(p.target, 'text+');
  assert.equal(readCompText(p.lua), 'New words');
  assert.equal(patchCompText('Composition { Tools = ordered() { Transform1 = Transform { }, } }', 'x').ok, false);
  assert.match(patchCompText('Composition { Compressed = true, }', 'x').reason, /compressed/);
});
