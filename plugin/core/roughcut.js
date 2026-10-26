'use strict';
/**
 * Rough-cut planning: keep ranges (timeline time) -> AppendToTimeline
 * clipInfos for a NEW timeline. The source timeline is never modified.
 *
 * Why a new timeline: the Resolve API has no razor, trim, ripple-delete or
 * move for existing items (verified absent through 21.0/21.1 by third-party
 * dir() audits). Rebuilding with MediaPool.AppendToTimeline is the only
 * supported programmatic edit, and it is inherently non-destructive.
 *
 * Source/record frame conventions handled here:
 *   - record frames are timeline frames at the timeline rate
 *   - source in/out are frames at the MEDIA's own rate (the 'FPS' clip
 *     property), never assumed equal to the timeline rate
 *   - Resolve floors mixed-rate durations when placing; expectedDuration
 *     models that so verification does not flag correct placements
 *   - endFrame inclusivity is a calibration constant measured by Diagnostics
 *     on the installed build (see plugin/resolve/adapter.js), passed in here
 */
const tb = require('./timebase');

/**
 * @param {object} p
 * @param {object} p.ctx           timeline context
 * @param {Array}  p.items         primary-track items:
 *   { id, name, recStart, recEnd (abs timeline frames, end exclusive), srcStart (media frames), srcRate (rate obj), speed (percent, default 100), mediaRef }
 * @param {Array}  p.keep          keep ranges in flicks relative to timeline start
 * @param {Array}  [p.otherTrackItems]  items on other tracks: { track, recStart, recEnd, name }
 * @param {boolean} [p.endFrameInclusive=true]
 * @param {number} [p.minFragmentFrames=2] fragments shorter than this are skipped and reported
 */
function planRoughCut(p) {
  const { ctx, items, keep } = p;
  const endInclusive = p.endFrameInclusive !== false;
  const minFrag = p.minFragmentFrames ?? 2;
  const warnings = [];
  const blocked = [];
  const keepFrames = keep
    .map((k) => ({ a: ctx.toTimelineFrame(k.start, 'round'), b: ctx.toTimelineFrame(k.end, 'round') }))
    .filter((k) => k.b > k.a);

  const clipInfos = [];
  let record = ctx.startFrame;
  const sortedItems = items.slice().sort((x, y) => x.recStart - y.recStart);

  // Gaps on the primary track are reported (they disappear in the rebuild).
  for (let i = 1; i < sortedItems.length; i++) {
    const gap = sortedItems[i].recStart - sortedItems[i - 1].recEnd;
    if (gap > 0) warnings.push({ type: 'gap', message: `Gap of ${gap} frame(s) before "${sortedItems[i].name}" at ${ctx.timecodeAt(sortedItems[i - 1].recEnd)} will be closed.` });
    if (gap < 0) blocked.push({ type: 'overlap', message: `Items "${sortedItems[i - 1].name}" and "${sortedItems[i].name}" overlap on the primary track; rough cut needs a single non-overlapping track.` });
  }

  for (const it of sortedItems) {
    if ((it.speed ?? 100) !== 100) {
      blocked.push({ type: 'retimed', message: `"${it.name}" is retimed (${it.speed}%); retimed items are not rebuilt by the rough cut in this version.` });
      continue;
    }
    if (!it.srcRate) {
      blocked.push({ type: 'rate', message: `"${it.name}" has no readable source frame rate; cannot map record frames to source frames safely.` });
      continue;
    }
    for (const k of keepFrames) {
      const a = Math.max(k.a, it.recStart);
      const b = Math.min(k.b, it.recEnd);
      if (b - a <= 0) continue;
      if (b - a < minFrag) {
        warnings.push({ type: 'fragment', message: `Skipped a ${b - a}-frame fragment of "${it.name}" at ${ctx.timecodeAt(a)}.` });
        continue;
      }
      // Map record offsets to source frames via exact rational conversion of
      // absolute offsets from the item start (no accumulation across pieces).
      const srcIn = it.srcStart + tb.convertFrames(a - it.recStart, ctx.rate, it.srcRate, 'round');
      const srcOutExcl = it.srcStart + tb.convertFrames(b - it.recStart, ctx.rate, it.srcRate, 'round');
      const srcFrames = srcOutExcl - srcIn;
      const sameRate = it.srcRate.num * ctx.rate.den === ctx.rate.num * it.srcRate.den;
      const expectedDuration = sameRate ? srcFrames : tb.convertFrames(srcFrames, it.srcRate, ctx.rate, 'floor');
      if (!sameRate && expectedDuration !== b - a) {
        warnings.push({ type: 'mixed-rate', message: `"${it.name}" (${it.srcRate.label} fps in a ${ctx.rate.label} timeline): piece at ${ctx.timecodeAt(a)} will be ${expectedDuration} frame(s) instead of ${b - a} because Resolve floors mixed-rate durations.` });
      }
      clipInfos.push({
        itemId: it.id,
        name: it.name,
        mediaRef: it.mediaRef,
        startFrame: srcIn,
        endFrame: endInclusive ? srcOutExcl - 1 : srcOutExcl,
        recordFrame: record,
        trackIndex: 1,
        expectedDuration,
        sourceRecordRange: { a, b },
      });
      record += expectedDuration;
    }
  }

  // Other tracks: anything overlapping a removed region would lose sync.
  const removed = invertFrames(keepFrames, ctx.startFrame, ctx.endFrameExclusive);
  for (const o of p.otherTrackItems || []) {
    const hit = removed.find((r) => o.recStart < r.b && o.recEnd > r.a);
    warnings.push({
      type: 'other-track',
      message: hit
        ? `"${o.name}" on ${o.track} overlaps removed material at ${ctx.timecodeAt(hit.a)}; it is NOT carried into the rough-cut timeline.`
        : `"${o.name}" on ${o.track} is not carried into the rough-cut timeline.`,
    });
  }

  const keptFrames = clipInfos.reduce((s, c) => s + c.expectedDuration, 0);
  return {
    clipInfos,
    warnings,
    blocked,
    summary: {
      originalFrames: ctx.durationFrames,
      keptFrames,
      removedFrames: ctx.durationFrames - keptFrames,
      pieces: clipInfos.length,
    },
  };
}

function invertFrames(ranges, start, end) {
  const out = [];
  let t = start;
  for (const r of ranges.slice().sort((x, y) => x.a - y.a)) {
    if (r.a > t) out.push({ a: t, b: r.a });
    t = Math.max(t, r.b);
  }
  if (t < end) out.push({ a: t, b: end });
  return out;
}

/**
 * Compare what Resolve reports after AppendToTimeline with the plan.
 * @param {Array} plan     clipInfos from planRoughCut
 * @param {Array} actual   [{ start, end }] from TimelineItem.GetStart/GetEnd on the new track, in order
 * @param {boolean} endInclusive  convention of TimelineItem.GetEnd on this build
 */
function verifyPlacement(plan, actual, endInclusive = false) {
  const problems = [];
  if (actual.length !== plan.length) problems.push(`Expected ${plan.length} item(s) on the new timeline, found ${actual.length}.`);
  const n = Math.min(plan.length, actual.length);
  for (let i = 0; i < n; i++) {
    const want = plan[i];
    const got = actual[i];
    const gotEnd = endInclusive ? got.end + 1 : got.end;
    if (got.start !== want.recordFrame) problems.push(`Item ${i + 1} ("${want.name}") starts at ${got.start}, expected ${want.recordFrame}.`);
    if (gotEnd - got.start !== want.expectedDuration) problems.push(`Item ${i + 1} ("${want.name}") lasts ${gotEnd - got.start} frame(s), expected ${want.expectedDuration}.`);
    if (i > 0) {
      const prevEnd = endInclusive ? actual[i - 1].end + 1 : actual[i - 1].end;
      if (got.start !== prevEnd) problems.push(`Continuity break between items ${i} and ${i + 1} (${prevEnd} -> ${got.start}).`);
    }
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { planRoughCut, verifyPlacement, invertFrames };
