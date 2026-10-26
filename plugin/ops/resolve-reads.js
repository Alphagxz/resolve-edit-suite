'use strict';
/**
 * Read-only helpers that turn Resolve objects into plain data and a
 * validated timeline context. No writes happen in this file.
 */
const { createTimelineContext } = require('../core/timeline-context');
const tb = require('../core/timebase');
const { SuiteError } = require('../resolve/adapter');

function listOf(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

async function timelineContext(a, timeline, calibration = {}) {
  const get = (k) => a.call('Timeline', timeline, 'GetSetting', k);
  const [frameRate, dropFrame, width, height, startFrame, endFrame, startTimecode] = [
    await get('timelineFrameRate'),
    await get('timelineDropFrameTimecode'),
    await get('timelineResolutionWidth'),
    await get('timelineResolutionHeight'),
    await a.must('Timeline', timeline, 'GetStartFrame'),
    await a.must('Timeline', timeline, 'GetEndFrame'),
    await a.call('Timeline', timeline, 'GetStartTimecode'),
  ];
  try {
    return createTimelineContext({
      frameRate, dropFrame, width, height, startFrame, endFrame, startTimecode,
      endInclusive: calibration.timelineEndInclusive === true,
    });
  } catch (e) {
    throw new SuiteError(`Timeline settings could not be used safely: ${e.message}`, 'unsupported', { frameRate, width, height, startFrame, endFrame });
  }
}

async function trackItems(a, timeline, type, index) {
  const items = listOf(await a.call('Timeline', timeline, 'GetItemListInTrack', type, index));
  const out = [];
  for (const it of items) {
    out.push({
      ref: it,
      id: await a.call('TimelineItem', it, 'GetUniqueId').catch(() => null),
      name: await a.call('TimelineItem', it, 'GetName'),
      start: await a.must('TimelineItem', it, 'GetStart'),
      end: await a.must('TimelineItem', it, 'GetEnd'),
      // Source offsets exist only for media-backed items. On subtitles, titles
      // and generators Resolve raises "Item is not a media" (errorCode 6,
      // observed on 21.0.0b20), so these are null for such items.
      leftOffset: await optionalNumber(a, it, 'GetLeftOffset'),
      // Seconds into the source media; unambiguous for mixed-rate clips.
      sourceStartTime: await optionalNumber(a, it, 'GetSourceStartTime'),
    });
  }
  return out;
}

async function optionalNumber(a, item, method) {
  try {
    const v = Number(await a.call('TimelineItem', item, method));
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function clipProperty(a, mpi, key) {
  const v = await a.call('MediaPoolItem', mpi, 'GetClipProperty', key);
  if (v && typeof v === 'object' && !Array.isArray(v)) return v[key];
  return v;
}

/** Media frame rate of a pool item, parsed to an exact rational (null if unknown). */
async function mediaRate(a, mpi) {
  const fps = await clipProperty(a, mpi, 'FPS');
  try {
    return tb.parseFrameRate(fps);
  } catch {
    return null;
  }
}

async function projectSummary(a, calibration) {
  const ver = await a.version();
  const out = { resolve: ver, project: null, timeline: null, problems: [] };
  let project;
  try {
    ({ project } = await a.currentProject());
  } catch (e) {
    out.problems.push(e.message);
    return out;
  }
  out.project = {
    name: await a.call('Project', project, 'GetName'),
    timelineCount: await a.call('Project', project, 'GetTimelineCount'),
    frameRate: await a.call('Project', project, 'GetSetting', 'timelineFrameRate'),
    width: await a.call('Project', project, 'GetSetting', 'timelineResolutionWidth'),
    height: await a.call('Project', project, 'GetSetting', 'timelineResolutionHeight'),
  };
  const timeline = await a.call('Project', project, 'GetCurrentTimeline');
  if (!timeline) {
    out.problems.push('No active timeline.');
    return out;
  }
  try {
    const ctx = await timelineContext(a, timeline, calibration);
    const counts = {};
    for (const t of ['video', 'audio', 'subtitle']) counts[t] = await a.call('Timeline', timeline, 'GetTrackCount', t);
    out.timeline = {
      name: await a.call('Timeline', timeline, 'GetName'),
      rate: ctx.rate.label,
      dropFrame: ctx.dropFrame,
      width: ctx.width,
      height: ctx.height,
      aspect: ctx.aspect,
      startTimecode: ctx.timecodeAt(ctx.startFrame),
      duration: ctx.timecodeAt(ctx.durationFrames),
      durationFrames: ctx.durationFrames,
      tracks: counts,
      projectRateDiffers: String(out.project.frameRate) !== String(await a.call('Timeline', timeline, 'GetSetting', 'timelineFrameRate')),
    };
    out.problems.push(...ctx.problems);
  } catch (e) {
    out.problems.push(e.message);
  }
  return out;
}

module.exports = { listOf, timelineContext, trackItems, clipProperty, mediaRate, projectSummary };
