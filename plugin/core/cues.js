'use strict';
/**
 * Cue finalisation against a real timeline: offset, frame quantisation,
 * overlap prevention, minimum durations and clamping to the timeline extent.
 *
 * Every cue boundary is converted from its ABSOLUTE time independently
 * (never by accumulating per-cue durations), so long sequences cannot drift.
 */
const tb = require('./timebase');

/**
 * @param {Array} cues            cues in flicks relative to `offset` origin
 * @param {object} ctx            timeline context (core/timeline-context)
 * @param {object} [opts]
 * @param {number} [opts.offset=0]        flicks added to every cue (e.g. clip position on timeline)
 * @param {number} [opts.minGapFrames=0]  frames kept free between consecutive cues
 * @param {number} [opts.minDurationFrames=1]
 * @param {number} [opts.timingShiftMs=0] user timing adjustment
 * @returns {{cues: Array, report: Array<{id, type, message}>}}
 *   cues carry startFrame/endFrame (absolute timeline frames, end exclusive)
 */
function finalizeCues(cues, ctx, opts = {}) {
  const offset = opts.offset || 0;
  const shift = tb.msToFlicks(opts.timingShiftMs || 0);
  const minGap = opts.minGapFrames ?? 0;
  const minDur = Math.max(1, opts.minDurationFrames ?? 1);
  const report = [];
  const note = (id, type, message) => report.push({ id, type, message });

  const sorted = cues
    .map((c, i) => ({ ...c, _order: i }))
    .sort((a, b) => a.start - b.start || a._order - b._order);

  const placed = [];
  for (const c of sorted) {
    let startFrame = ctx.toTimelineFrame(c.start + offset + shift, 'round');
    let endFrame = ctx.toTimelineFrame(c.end + offset + shift, 'round');
    if (endFrame <= startFrame) {
      note(c.id, 'duration', `Duration rounded to zero frames at ${ctx.rate.label} fps; extended to ${minDur} frame(s).`);
      endFrame = startFrame + minDur;
    }
    if (endFrame <= ctx.startFrame || startFrame >= ctx.endFrameExclusive) {
      note(c.id, 'outside', 'Cue lies entirely outside the timeline and was dropped.');
      continue;
    }
    if (startFrame < ctx.startFrame) {
      note(c.id, 'clamped', 'Cue started before the timeline and was clamped to the first frame.');
      startFrame = ctx.startFrame;
    }
    if (endFrame > ctx.endFrameExclusive) {
      note(c.id, 'clamped', 'Cue extended past the timeline end and was trimmed.');
      endFrame = ctx.endFrameExclusive;
    }
    const prev = placed[placed.length - 1];
    if (prev && startFrame < prev.endFrame + minGap) {
      const newPrevEnd = startFrame - minGap;
      if (newPrevEnd - prev.startFrame >= minDur) {
        note(prev.id, 'overlap', `Trimmed by ${prev.endFrame - newPrevEnd} frame(s) to avoid overlapping cue ${c.id}.`);
        prev.endFrame = newPrevEnd;
      } else {
        const pushed = prev.endFrame + minGap;
        note(c.id, 'overlap', `Delayed by ${pushed - startFrame} frame(s) to avoid overlapping cue ${prev.id}.`);
        startFrame = pushed;
        if (endFrame - startFrame < minDur) endFrame = startFrame + minDur;
        if (endFrame > ctx.endFrameExclusive) {
          note(c.id, 'outside', 'No room left before the timeline end after resolving overlap; dropped.');
          continue;
        }
      }
    }
    if (endFrame - startFrame < minDur) {
      const want = startFrame + minDur;
      if (want <= ctx.endFrameExclusive) {
        note(c.id, 'duration', `Extended to the minimum ${minDur} frame(s).`);
        endFrame = want;
      }
    }
    const { _order, ...rest } = c;
    placed.push({ ...rest, startFrame, endFrame });
  }

  // Word timings follow their cue onto the frame grid (clamped inside the cue).
  for (const c of placed) {
    if (!c.words) continue;
    c.words = c.words.map((w) => {
      const s = Math.min(Math.max(ctx.toTimelineFrame(w.start + offset + shift), c.startFrame), c.endFrame - 1);
      const e = Math.min(Math.max(ctx.toTimelineFrame(w.end + offset + shift), s + 1), c.endFrame);
      return { ...w, startFrame: s, endFrame: e };
    });
  }
  return { cues: placed, report };
}

/** Independent validator used after insertion and in tests. */
function validateCues(cues, ctx) {
  const problems = [];
  let prev = null;
  for (const c of cues) {
    if (!Number.isInteger(c.startFrame) || !Number.isInteger(c.endFrame)) problems.push(`${c.id}: non-integer frame`);
    if (c.endFrame <= c.startFrame) problems.push(`${c.id}: non-positive duration`);
    if (c.startFrame < ctx.startFrame || c.endFrame > ctx.endFrameExclusive) problems.push(`${c.id}: outside timeline`);
    if (prev && c.startFrame < prev.endFrame) problems.push(`${c.id}: overlaps ${prev.id}`);
    prev = c;
  }
  return problems;
}

/** Convert placed cues back to flicks relative to the timeline start (for SRT export). */
function cuesToRelative(cues, ctx) {
  return cues.map((c) => ({ ...c, start: ctx.fromTimelineFrame(c.startFrame), end: ctx.fromTimelineFrame(c.endFrame) }));
}

module.exports = { finalizeCues, validateCues, cuesToRelative };
