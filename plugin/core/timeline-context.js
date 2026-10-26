'use strict';
/**
 * A validated, immutable description of the active timeline built from the
 * raw values Resolve reports. All placement code goes through this object, so
 * frame-rate and timecode handling lives in exactly one place.
 *
 * Coordinate systems:
 *   - "timeline frame": absolute frame as used by Resolve's timeline API
 *     (GetStartFrame/GetEndFrame, recordFrame, AddMarker on Timeline is
 *     relative — see markerFrame()).
 *   - "flicks": suite-internal time measured from the timeline's first frame.
 */
const tb = require('./timebase');
const tc = require('./timecode');

function aspectClass(width, height) {
  const r = width / height;
  if (Math.abs(r - 1) < 0.02) return 'square';
  if (r > 1) return r >= 1.7 ? 'horizontal' : 'horizontal-narrow';
  return r <= 0.6 ? 'vertical' : 'vertical-wide';
}

/**
 * @param {object} raw
 * @param {string|number} raw.frameRate     Timeline.GetSetting('timelineFrameRate')
 * @param {boolean|string|number} [raw.dropFrame] Timeline.GetSetting('timelineDropFrameTimecode')
 * @param {number|string} raw.width         Timeline.GetSetting('timelineResolutionWidth')
 * @param {number|string} raw.height        Timeline.GetSetting('timelineResolutionHeight')
 * @param {number} raw.startFrame           Timeline.GetStartFrame()
 * @param {number} raw.endFrame             Timeline.GetEndFrame() (see endInclusive)
 * @param {string} [raw.startTimecode]      Timeline.GetStartTimecode()
 * @param {boolean} [raw.endInclusive=true] Whether endFrame is the last frame (Resolve convention) or one past it.
 */
function createTimelineContext(raw) {
  const problems = [];
  const rate = tb.parseFrameRate(raw.frameRate);
  const dfRaw = raw.dropFrame;
  let dropFrame = dfRaw === true || dfRaw === 1 || dfRaw === '1' || String(dfRaw).toLowerCase() === 'true';
  if (dropFrame && !tc.supportsDropFrame(rate)) {
    problems.push(`Resolve reports drop-frame timecode at ${rate.label} fps, which has no drop-frame form; using non-drop-frame.`);
    dropFrame = false;
  }
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new tb.TimebaseError(`Invalid timeline resolution ${raw.width}x${raw.height}`, 'BAD_RESOLUTION');
  }
  const startFrame = Number(raw.startFrame);
  const endFrameRaw = Number(raw.endFrame);
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrameRaw)) {
    throw new tb.TimebaseError(`Invalid timeline frame range ${raw.startFrame}..${raw.endFrame}`, 'BAD_RANGE');
  }
  const endExclusive = raw.endInclusive === false ? endFrameRaw : endFrameRaw + 1;
  if (endExclusive < startFrame) throw new tb.TimebaseError(`Timeline ends (${endFrameRaw}) before it starts (${startFrame})`, 'BAD_RANGE');

  if (raw.startTimecode) {
    try {
      const tcFrames = tc.timecodeToFrames(raw.startTimecode, rate, dropFrame);
      if (tcFrames !== startFrame) {
        problems.push(`Start timecode ${raw.startTimecode} is frame ${tcFrames} but Resolve reports start frame ${startFrame}; frame numbers from Resolve are used for placement.`);
      }
    } catch (e) {
      problems.push(`Could not interpret start timecode "${raw.startTimecode}": ${e.message}`);
    }
  }

  const durationFrames = endExclusive - startFrame;
  const ctx = {
    rate,
    fps: tb.rateToFloat(rate),
    dropFrame,
    width,
    height,
    aspect: aspectClass(width, height),
    startFrame,
    endFrameExclusive: endExclusive,
    durationFrames,
    durationFlicks: tb.framesToFlicks(durationFrames, rate),
    problems,

    /** Suite time (flicks from timeline start) -> absolute timeline frame. */
    toTimelineFrame(flicks, mode = 'round') {
      return startFrame + tb.flicksToFrames(flicks, rate, mode);
    },
    /** Absolute timeline frame -> suite time. */
    fromTimelineFrame(frame) {
      return tb.framesToFlicks(frame - startFrame, rate);
    },
    /** Frame offset relative to timeline start, as Timeline.AddMarker expects. */
    markerFrame(flicks, mode = 'round') {
      return tb.flicksToFrames(flicks, rate, mode);
    },
    timecodeAt(frame) {
      return tc.framesToTimecode(frame, rate, dropFrame);
    },
    containsFrame(frame) {
      return frame >= startFrame && frame < endExclusive;
    },
  };
  return Object.freeze(ctx);
}

module.exports = { createTimelineContext, aspectClass };
